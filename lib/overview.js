// Visao Geral (M31): um unico payload para a tela inicial, no lugar das 7
// requisicoes que ela disparava (trend + data_health + recent + score + daily +
// radar + alerts). Alem de cortar round-trips, permite montar no servidor um
// RESUMO DETERMINISTICO — sem IA, sem ai_summary (que hoje e null em 100% dos
// atos) — a partir do que ja esta no banco.
//
// Tudo aqui e leitura. A funcao nunca lanca para o caller: devolve { ok, ... }.

// ── Datas em America/Sao_Paulo ──────────────────────────────────────────────
// O resto do codebase usa toISOString(), que e UTC: entre 21h e meia-noite de
// Brasilia o "hoje" ja virou amanha e o filtro de 1 dia voltava vazio. en-CA
// formata como YYYY-MM-DD, que e exatamente o formato de published_at (date).
const FUSO = "America/Sao_Paulo";
const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit"
});

function isoBR(date = new Date()) {
  return FMT.format(date);
}
function isoMaisDias(n, base = new Date()) {
  return isoBR(new Date(base.getTime() + n * 86400000));
}
// Dia da semana (0=domingo) da data YYYY-MM-DD, lida como data civil.
function diaDaSemana(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}
function ehFimDeSemana(iso) {
  const w = diaDaSemana(iso);
  return w === 0 || w === 6;
}
function ptBR(iso) {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "";
}

const PERIODOS_VALIDOS = [1, 7, 14, 30, 90];
const ROTULOS = { 1: "Hoje", 7: "Últimos 7 dias", 14: "Últimos 14 dias", 30: "Últimos 30 dias", 90: "Últimos 90 dias" };

function normalizaPeriodo(days) {
  const n = Number(days);
  return PERIODOS_VALIDOS.includes(n) ? n : 7;
}

// ── Formatacao de dinheiro ──────────────────────────────────────────────────
// Escala em vez de casas decimais: "R$ 412,7 mi" le melhor num KPI que
// "R$ 412.734.221,00" e nao mente sobre a precisao do dado.
function dinheiro(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return `R$ ${(n / 1e9).toFixed(1).replace(".", ",")} bi`;
  if (n >= 1e6) return `R$ ${(n / 1e6).toFixed(1).replace(".", ",")} mi`;
  if (n >= 1e3) return `R$ ${(n / 1e3).toFixed(0)} mil`;
  return `R$ ${n.toFixed(0)}`;
}

function pct(parte, total) {
  return total > 0 ? Math.round((parte / total) * 100) : 0;
}

// ── Contagem exata sem trazer linha ─────────────────────────────────────────
// head:true + count:exact resolve no Postgres. E o que torna o Δ% vs. janela
// anterior barato: dois COUNT em vez de baixar 2x a janela inteira.
async function contaDocs(supabase, de, ate) {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("source_name", "DOU")
    .gte("published_at", de)
    .lte("published_at", ate);
  return error ? null : (count ?? 0);
}

// Linhas da janela atual, so as 3 colunas que a serie e o corte por agencia usam.
// Ordem DESC: se a janela estourar o teto, quem cai fora sao os dias mais ANTIGOS
// (o dia corrente sempre entra) — mesma decisao ja tomada em type=trend.
const PAGINA = 1000;
const TETO_LINHAS = 20000;

async function docsDaJanela(supabase, de, ate) {
  const linhas = [];
  for (let from = 0; from < TETO_LINHAS; from += PAGINA) {
    const { data, error } = await supabase
      .from("documents")
      .select("published_at, document_type, agency_id")
      .eq("source_name", "DOU")
      .gte("published_at", de)
      .lte("published_at", ate)
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGINA - 1);
    if (error) return { erro: error.message, linhas: [], truncado: false };
    linhas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return { erro: null, linhas, truncado: linhas.length >= TETO_LINHAS };
}

// ── Resumo deterministico ───────────────────────────────────────────────────
// Cada bullet tem um piso anti-ruido. Nenhum deles usa IA nem ai_summary; todos
// saem de contagem sobre dados ja persistidos, entao o texto e reproduzivel e
// auditavel — se o numero parece errado, da para conferir na tabela.
function montaResumo(ctx) {
  const {
    periodo, totalAtual, totalAnterior, porTipo, porAgencia, porAgenciaAnterior,
    diasParado, ultimaIngestao, alertas, movimentacao, contratos30
  } = ctx;

  const agenciasAtivas = Object.keys(porAgencia).length;
  const bullets = [];
  // Sem a janela anterior carregada (90d) nao da para afirmar pico nem silencio.
  const temComparacao = ctx.comparaAgencias;

  // 1. Ingestao parada vem primeiro: ela relativiza todos os numeros abaixo.
  if (diasParado != null && diasParado > 2) {
    bullets.push({
      tom: "alerta",
      texto: `Ingestão do DOU parada há ${diasParado} dias — os números abaixo cobrem até ${ptBR(ultimaIngestao)}.`
    });
  }

  // 2. Pico: so conta se a base anterior tinha corpo (>=3) e o salto e material (>=5).
  let pico = null;
  for (const [sigla, at] of Object.entries(temComparacao ? porAgencia : {})) {
    const ant = porAgenciaAnterior[sigla] || 0;
    if (ant < 3 || at.total < 5) continue;
    const razao = at.total / ant;
    if (razao >= 2 && (!pico || razao > pico.razao)) pico = { sigla, razao, atual: at.total, anterior: ant };
  }
  if (pico) {
    bullets.push({
      tom: "atencao",
      texto: `${pico.sigla} publicou ${pico.razao.toFixed(1).replace(".", ",")}× o volume da janela anterior (${pico.atual} atos contra ${pico.anterior}).`
    });
  }

  // 3. Silencio: agencia que era ativa e zerou. Suprimido quando TODAS zeraram
  //    (ai o diagnostico e falha de ingestao, nao comportamento do regulador) e
  //    quando a janela e um unico dia nao util.
  const janelaUtil = temComparacao && !(periodo === 1 && ehFimDeSemana(ctx.ate));
  const todasZeraram = agenciasAtivas === 0;
  if (janelaUtil && !todasZeraram) {
    const silenciosas = Object.entries(porAgenciaAnterior)
      .filter(([sigla, ant]) => ant >= 5 && !porAgencia[sigla])
      .map(([sigla]) => sigla);
    if (silenciosas.length) {
      bullets.push({
        tom: "atencao",
        texto: silenciosas.length === 1
          ? `${silenciosas[0]} não publicou nada no período (tinha ${porAgenciaAnterior[silenciosas[0]]} atos na janela anterior).`
          : `${silenciosas.length} agências zeraram a publicação: ${silenciosas.slice(0, 4).join(", ")}${silenciosas.length > 4 ? "…" : ""}.`
      });
    }
  }

  // 4. Alertas abertos, pelo tipo que mais aparece.
  if (alertas.total > 0) {
    const [tipoTop, qtdTop] = Object.entries(alertas.porTipo).sort((a, b) => b[1] - a[1])[0] || [];
    // Severidade e tipo saem da amostra dos 200 mais recentes: dizer "dos N mais
    // recentes" evita apresentar um recorte como se fosse o universo.
    const recorte = alertas.amostrados ? " (dos 200 mais recentes)" : "";
    const detalhe = alertas.altos > 0 ? `, ${alertas.altos} de alta severidade${recorte}` : "";
    bullets.push({
      tom: alertas.altos > 0 ? "alerta" : "neutro",
      texto: `${alertas.total} alerta${alertas.total > 1 ? "s" : ""} em aberto${detalhe}${tipoTop ? ` — o tipo mais frequente é ${tipoTop} (${qtdTop})` : ""}.`
    });
  }

  // 5. Colegiado: datas do FATO (started_at/ended_at), nao created_at do alerta.
  //    created_at e hora da coleta e mentiria em qualquer backfill.
  if (movimentacao.total > 0) {
    const partes = [];
    if (movimentacao.entradas) partes.push(`${movimentacao.entradas} nomeaç${movimentacao.entradas > 1 ? "ões" : "ão"}`);
    if (movimentacao.saidas) partes.push(`${movimentacao.saidas} saída${movimentacao.saidas > 1 ? "s" : ""}`);
    bullets.push({
      tom: "neutro",
      texto: `${movimentacao.total} mudança${movimentacao.total > 1 ? "s" : ""} de colegiado com data no período: ${partes.join(" e ")}.`
    });
  }

  // 6. Prazo com dinheiro. Declara quantos nao tem valor: somar nulo como zero
  //    em silencio e o jeito mais facil de subestimar a exposicao.
  if (contratos30.total > 0) {
    const semValor = contratos30.semValor
      ? ` (${contratos30.semValor} sem valor declarado)`
      : "";
    bullets.push({
      tom: "atencao",
      texto: `${contratos30.total} contrato${contratos30.total > 1 ? "s vencem" : " vence"} nos próximos 30 dias — ${dinheiro(contratos30.valor)} somados${semValor}.`
    });
  }

  // ── Lead ──
  let lead;
  if (totalAtual === 0) {
    lead = periodo === 1
      ? (ehFimDeSemana(ctx.ate)
        ? "Nenhum ato hoje — o DOU não circula em fim de semana."
        : "Nenhum ato hoje ainda. A edição do DOU costuma sair pela manhã; use “Atualizar agora” para buscar.")
      : `Nenhum ato no período (${ptBR(ctx.de)} a ${ptBR(ctx.ate)}). Verifique a ingestão do DOU.`;
  } else {
    const ordenadas = Object.entries(porAgencia).sort((a, b) => b[1].total - a[1].total);
    const top3 = ordenadas.slice(0, 3);
    const concentracao = pct(top3.reduce((s, [, a]) => s + a.total, 0), totalAtual);
    const composicao = `${pct(porTipo.norma, totalAtual)}% normas, ${pct(porTipo.ato_pessoal, totalAtual)}% atos de pessoal, ${pct(porTipo.contrato, totalAtual)}% contratos`;
    const lideres = top3.length >= 2
      ? ` ${top3.map(([s]) => s).join(", ")} concentram ${concentracao}%.`
      : (top3.length === 1 ? ` Tudo veio de ${top3[0][0]}.` : "");
    lead = `${ROTULOS[periodo]} · ${totalAtual} atos de ${agenciasAtivas} agência${agenciasAtivas > 1 ? "s" : ""} — ${composicao}.${lideres}`;
  }

  return {
    lead,
    bullets: bullets.slice(0, 5),
    // Truncou = totalAtual e um piso, nao um total: comparar com o COUNT exato
    // da janela anterior produziria uma queda que nao existe.
    // Com a ingestao parada a janela atual esta incompleta por FALHA DE COLETA,
    // nao por queda de publicacao: um Delta aqui seria lido como fato do mundo.
    delta_pct: (ctx.truncado || (diasParado != null && diasParado > 2))
      ? null
      : deltaPct(totalAtual, totalAnterior)
  };
}

// null quando nao ha base de comparacao: 0 -> 5 nao e "+500%", e "sem base".
function deltaPct(atual, anterior) {
  if (anterior == null || anterior === 0) return null;
  return Math.round(((atual - anterior) / anterior) * 100);
}

// ── Montagem ────────────────────────────────────────────────────────────────
async function buildOverview(supabase, opcoes = {}) {
  const periodo = normalizaPeriodo(opcoes.days);
  const ate = isoBR();
  const de = isoMaisDias(-(periodo - 1));
  const deAnterior = isoMaisDias(-(periodo * 2 - 1));
  const ateAnterior = isoMaisDias(-periodo);

  const hoje = ate;
  const em30 = isoMaisDias(30);
  const em90 = isoMaisDias(90);
  const comparaAgencias = periodo <= 30;

  // Uma rodada de leituras independentes. allSettled: uma fonte quebrada degrada
  // o bloco dela, nao a tela inteira.
  const [
    agenciasRes, janelaRes, totalAnteriorRes, ultimoAtoRes, recentesRes,
    alertasRes, alertasCountRes, contratosRes, mandatosIniRes, mandatosFimRes, monitoresRes,
    docsAnteriorRes, mandatosProximosRes
  ] = await Promise.allSettled([
    supabase.from("agencies").select("id, acronym"),
    docsDaJanela(supabase, de, ate),
    contaDocs(supabase, deAnterior, ateAnterior),
    supabase.from("documents").select("published_at").eq("source_name", "DOU")
      .order("published_at", { ascending: false }).limit(1),
    supabase.from("documents")
      .select("id, title, document_type, published_at, source_url, metadata, agencies(acronym)")
      .eq("source_name", "DOU")
      .order("published_at", { ascending: false })
      .order("collected_at", { ascending: false })
      .limit(12),
    supabase.from("alerts").select("id, alert_type, severity, title, body, created_at")
      .is("acknowledged_at", null).order("created_at", { ascending: false }).limit(200),
    supabase.from("alerts").select("id", { count: "exact", head: true }).is("acknowledged_at", null),
    supabase.from("contracts").select("object, supplier_name, value, ends_at, agencies(acronym)")
      .gte("ends_at", hoje).lte("ends_at", em90).order("ends_at").limit(500),
    supabase.from("mandates").select("id").gte("started_at", de).lte("started_at", ate),
    supabase.from("mandates").select("id, role, ended_at, people(full_name), agencies(acronym)")
      .gte("ended_at", de).lte("ended_at", ate),
    supabase.from("monitors").select("id, label, last_hit_at, hit_count").eq("active", true),
    // A janela anterior so e baixada quando cabe: ate 30 dias sao ~6,6 mil linhas.
    // Em 90d seriam outras 20 mil so para dois bullets — nao compensa, e o Delta
    // continua exato porque vem de um COUNT, nao das linhas.
    comparaAgencias ? docsDaJanela(supabase, deAnterior, ateAnterior)
                    : Promise.resolve({ erro: null, linhas: [], truncado: false }),
    // Fim de mandato a vencer: evento futuro, janela diferente da do periodo.
    supabase.from("mandates").select("id, role, ended_at, people(full_name), agencies(acronym)")
      .gte("ended_at", hoje).lte("ended_at", em90).order("ended_at").limit(200)
  ]);

  const valor = (r, padrao) => (r.status === "fulfilled" ? r.value : padrao);

  // Agencias: id -> sigla. Uma consulta pequena substitui o embed agencies(acronym)
  // em ate 20 mil linhas de documento.
  const siglaPorId = {};
  for (const a of valor(agenciasRes, { data: [] })?.data || []) siglaPorId[a.id] = a.acronym;

  const janela = valor(janelaRes, { erro: "falha na leitura", linhas: [], truncado: false });
  const janelaAnterior = valor(docsAnteriorRes, { erro: null, linhas: [], truncado: false });

  // Serie diaria + cortes por tipo e por agencia, num passe so.
  const porDia = {};
  const porTipo = { norma: 0, ato_pessoal: 0, contrato: 0 };
  const porAgencia = {};
  for (const d of janela.linhas) {
    const dia = d.published_at;
    if (!porDia[dia]) porDia[dia] = { date: dia, norma: 0, ato_pessoal: 0, contrato: 0, total: 0 };
    const t = porTipo[d.document_type] !== undefined ? d.document_type : "norma";
    porDia[dia][t]++; porDia[dia].total++; porTipo[t]++;
    const sigla = siglaPorId[d.agency_id] || "?";
    if (!porAgencia[sigla]) porAgencia[sigla] = { acronym: sigla, norma: 0, ato_pessoal: 0, contrato: 0, total: 0 };
    porAgencia[sigla][t]++; porAgencia[sigla].total++;
  }
  const series = Object.values(porDia).sort((a, b) => a.date.localeCompare(b.date));
  // Se truncou, o dia mais antigo esta incompleto: exibir a contagem parcial dele
  // faria a curva "cair" no inicio por artefato de paginacao.
  if (janela.truncado && series.length > 1) series.shift();
  const totalAtual = series.reduce((s, d) => s + d.total, 0);

  const porAgenciaAnterior = {};
  for (const d of janelaAnterior.linhas) {
    const sigla = siglaPorId[d.agency_id] || "?";
    porAgenciaAnterior[sigla] = (porAgenciaAnterior[sigla] || 0) + 1;
  }
  const totalAnterior = valor(totalAnteriorRes, null);

  // Frescor: distancia entre o ato mais recente do acervo e hoje.
  const ultimaIngestao = valor(ultimoAtoRes, { data: [] })?.data?.[0]?.published_at || null;
  const diasParado = ultimaIngestao
    ? Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${ultimaIngestao}T00:00:00Z`)) / 86400000)
    : null;

  const alertasLinhas = valor(alertasRes, { data: [] })?.data || [];
  // O total vem de um COUNT; as 200 linhas sao amostra para o corte por tipo e
  // para o feed. Sem isso, "200 alertas" seria so o teto do limit disfarcado.
  const alertasTotal = valor(alertasCountRes, { count: null })?.count ?? alertasLinhas.length;
  const alertasAmostrados = alertasLinhas.length < alertasTotal;
  const alertas = {
    total: alertasTotal,
    amostrados: alertasAmostrados,
    altos: alertasLinhas.filter((a) => a.severity === "high").length,
    porTipo: alertasLinhas.reduce((acc, a) => {
      const k = a.alert_type || "sem tipo";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {})
  };

  const contratos = valor(contratosRes, { data: [] })?.data || [];
  const contratos30Linhas = contratos.filter((c) => String(c.ends_at || "").slice(0, 10) <= em30);
  const soma = (linhas) => linhas.reduce((s, c) => s + (Number(c.value) || 0), 0);
  const contratos30 = {
    total: contratos30Linhas.length,
    valor: soma(contratos30Linhas),
    semValor: contratos30Linhas.filter((c) => c.value == null).length
  };
  // O KPI conta 90d: o montante tem que ser o de 90d tambem, senao o card soma
  // dinheiro de uma janela e contrato de outra.
  const contratos90 = {
    total: contratos.length,
    valor: soma(contratos),
    semValor: contratos.filter((c) => c.value == null).length,
    truncado: contratos.length >= 500
  };

  const entradas = (valor(mandatosIniRes, { data: [] })?.data || []).length;
  const saidasLinhas = valor(mandatosFimRes, { data: [] })?.data || [];
  const movimentacao = { entradas, saidas: saidasLinhas.length, total: entradas + saidasLinhas.length };

  const monitores = valor(monitoresRes, { data: [] })?.data || [];
  const monitoresDisparados = monitores.filter((m) => m.last_hit_at && String(m.last_hit_at).slice(0, 10) >= de).length;

  // Prazos: os 5 eventos mais proximos, contrato e fim de mandato lado a lado.
  const prazos = [
    ...contratos.map((c) => ({
      tipo: "contrato",
      data: c.ends_at,
      agencia: c.agencies?.acronym || null,
      titulo: (c.object || "Contrato").slice(0, 90),
      detalhe: c.supplier_name || null,
      valor: c.value != null ? Number(c.value) : null
    })),
    ...(valor(mandatosProximosRes, { data: [] })?.data || []).map((m) => ({
      tipo: "mandato",
      data: m.ended_at,
      agencia: m.agencies?.acronym || null,
      titulo: `Fim de mandato: ${m.people?.full_name || "dirigente"}`,
      detalhe: m.role || null,
      valor: null
    }))
  ].sort((a, b) => String(a.data).localeCompare(String(b.data))).slice(0, 5);

  const resumo = montaResumo({
    periodo, de, ate, totalAtual, totalAnterior, porTipo, porAgencia, porAgenciaAnterior,
    diasParado, ultimaIngestao, alertas, movimentacao, contratos30,
    comparaAgencias, truncado: janela.truncado
  });

  return {
    ok: true,
    periodo: { days: periodo, de, ate, rotulo: ROTULOS[periodo] },
    frescor: {
      ultima_ingestao: ultimaIngestao,
      dias_parado: diasParado,
      estado: diasParado == null ? "vazio" : diasParado <= 1 ? "ok" : diasParado <= 3 ? "atencao" : "parado"
    },
    kpis: {
      atos: { valor: totalAtual, anterior: totalAnterior, delta_pct: resumo.delta_pct, truncado: janela.truncado },
      alertas: { valor: alertas.total, altos: alertas.altos },
      contratos_90d: {
        valor: contratos90.total, montante: contratos90.valor,
        sem_valor: contratos90.semValor, truncado: contratos90.truncado
      },
      monitores: { valor: monitores.length, disparados: monitoresDisparados }
    },
    resumo: { lead: resumo.lead, bullets: resumo.bullets },
    series,
    por_agencia: Object.values(porAgencia).sort((a, b) => b.total - a.total),
    recentes: (valor(recentesRes, { data: [] })?.data || []).map((d) => ({
      id: d.id,
      title: d.title,
      type: d.document_type,
      date: d.published_at,
      agency: d.agencies?.acronym || d.metadata?.agency_acronym || "?",
      confidence: d.metadata?.ai_confidence ?? null,
      link: d.source_url
    })),
    alertas: alertasLinhas.slice(0, 8),
    prazos,
    // Sem cortes silenciosos: o front precisa poder dizer o que nao foi medido.
    limites: {
      janela_truncada: janela.truncado,
      comparacao_por_agencia: comparaAgencias
    },
    erros: [janela.erro].filter(Boolean)
  };
}

module.exports = { buildOverview, isoBR, dinheiro, PERIODOS_VALIDOS };
