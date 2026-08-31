// Persistencia dos atos do DOU. Antes este bloco existia TRIPLICADO — em
// api/ingest-dou.js, scripts/backfill-dou.js e scripts/run-ingest-dou.js — e cada
// copia tinha os mesmos tres problemas:
//
//   1. Dedupe linha a linha: um SELECT por ato (~220 round-trips por dia).
//   2. Um UPDATE extra por ato so para gravar `themes`, que cabia no proprio insert.
//   3. Alertas sem `alert_type`. A coluna ia NULL, e o indice de dedupe de alertas
//      nunca conflitava: cada reingestao do mesmo dia duplicava os alertas.
//
// Aqui e uma implementacao so: dedupe em lote, insert em blocos e themes junto.
// Mede-se em consultas, nao em linhas: ~220 round-trips viram ~10.
const { classifyThemes } = require("./themes");
const { processPeopleFromDoc, matchMonitorsForDoc } = require("./ingest");

const DOC_TYPE = { 1: "norma", 2: "ato_pessoal", 3: "contrato" };

// Teto por consulta. O `.in()` do PostgREST viaja na querystring: 50 hashes de 64
// chars dao ~3 KB, folgado; 220 estourariam o limite de URL do servidor.
const LOTE_DEDUPE = 50;
const LOTE_INSERT = 50;

function pedacos(lista, n) {
  const out = [];
  for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
  return out;
}

// Quais desses content_hash ja estao no banco.
async function hashesExistentes(supabase, hashes) {
  const achados = new Set();
  for (const bloco of pedacos([...new Set(hashes)], LOTE_DEDUPE)) {
    const { data, error } = await supabase
      .from("documents")
      .select("content_hash")
      .in("content_hash", bloco);
    if (error) throw error;
    for (const d of data || []) achados.add(d.content_hash);
  }
  return achados;
}

// Insere em blocos e devolve id por content_hash. Se o bloco falhar (tipicamente
// corrida contra outra ingestao, com o indice unico ativo), cai para linha a linha
// para nao perder o bloco inteiro por causa de um ato.
async function inserirDocs(supabase, linhas, falhas = []) {
  const idPorHash = new Map();
  for (const bloco of pedacos(linhas, LOTE_INSERT)) {
    const { data, error } = await supabase.from("documents").insert(bloco).select("id, content_hash");
    if (!error) {
      for (const d of data || []) idPorHash.set(d.content_hash, d.id);
      continue;
    }
    for (const linha of bloco) {
      const { data: um, error: e1 } = await supabase
        .from("documents").insert(linha).select("id, content_hash").single();
      if (!e1 && um) { idPorHash.set(um.content_hash, um.id); continue; }
      // SO duplicata pode ser ignorada. A versao anterior engolia QUALQUER erro
      // presumindo corrida — e com isso um erro sistemico (coluna ausente, NOT NULL,
      // check, timeout de escrita, projeto em read-only por cota) reprovava as 50
      // linhas em silencio: a rota respondia 200 {ok:true, inserted:0} e o backfill
      // logava "+0 novos, 0 ja existiam", indistinguivel de um sabado.
      // Era regressao: antes desta refatoracao havia `if (docErr) throw docErr`.
      const dup = e1?.code === "23505" || /duplicate key|already exists/i.test(e1?.message || "");
      if (!dup) {
        falhas.push(`${e1?.code || "?"}: ${e1?.message || "erro sem mensagem"}`);
      }
    }
  }
  return idPorHash;
}

// ── Camada 1: particionamento temporal ──────────────────────────────────────
// Um dia e servido por EXATAMENTE UMA fonte. Este e o unico mecanismo de dedupe
// entre fontes que funciona hoje, e a medicao mostra por que ele nao e opcional:
//
//   10/08/2026 esta no banco pelo INLABS (114 atos). Recolhendo o mesmo dia pela
//   fonte publica (225 atos), o dedupe por content_hash reconhece ZERO — os ids sao
//   de sistemas diferentes (INLABS 50709306, portal 724195045). Inserir seria criar
//   225 duplicatas.
//
//   E titulo normalizado NAO resolve: 130 registros publicos casam com 114 do banco,
//   porque titulo colide DENTRO da propria fonte ("Despacho" se repete no mesmo dia).
//
// Por isso: antes de gravar, checa se o dia ja tem linhas de OUTRA fonte. Se tiver,
// recusa. Reingerir um dia ja coberto exige a Camada 3 (guarda textual), que ainda
// nao esta a 100% — e ate la o caminho seguro e nao tocar nesses dias.
// UMA consulta POR DATA, nao um .in() com varias.
//
// A primeira versao usava .in(datas) e lia as linhas devolvidas. Isso trunca: o
// PostgREST corta em 1000 e um bloco de 50 datas x ~200 atos sao 10 mil linhas — as
// datas alem do corte voltariam SEM fonte registrada, a guarda nao veria conflito, e
// o acervo duplicaria exatamente no caso que ela existe para impedir. Falso negativo
// numa guarda e pior que falso positivo.
//
// Aqui basta descobrir QUAIS fontes serviram cada dia, entao uma amostra pequena por
// data resolve — sem trazer o dia inteiro.
const AMOSTRA_FONTE = 200;

async function fontesDoDia(supabase, datas) {
  const porData = new Map();
  for (const dia of [...new Set(datas)]) {
    const { data, error } = await supabase
      .from("documents")
      .select("metadata")
      .eq("source_name", "DOU")
      .eq("published_at", dia)
      .limit(AMOSTRA_FONTE);
    if (error) throw error;
    if (!data || !data.length) continue;
    const fontes = new Set();
    for (const d of data) fontes.add(d.metadata?.fonte || "inlabs");
    porData.set(dia, fontes);
  }
  return porData;
}

/**
 * Grava os atos coletados de um dia.
 *
 * @param {object} supabase
 * @param {Array}  records         saida de collectDou()
 * @param {object} opcoes
 *   - analisar   (fn|null) analyzeAto. null = sem IA. A rota HTTP passa null: sao
 *                ~220 chamadas sequenciais a Claude, ~7 min, e nao cabem nos 60s
 *                da Vercel. scripts/backfill-ai.js preenche depois.
 *   - comPessoas (bool)    roda processPeopleFromDoc. Desligado na rota HTTP: e
 *                trabalho duplicado do cron ingest-people-dou das 12:30 e sozinho
 *                consome 25-30s.
 *   - monitores  (Array)   monitores ativos, de loadActiveMonitors().
 *   - exigirParticao (bool) recusa gravar num dia ja servido por OUTRA fonte
 *                (Camada 1). Default true — desligar so com a Camada 3 pronta.
 *   - comAlertas (bool)    gera alerta por ato de pessoal (Secao 2). O backfill
 *                historico passa false: 20 dias de atos virariam centenas de
 *                alertas 'novos' de fatos velhos, afogando os alertas do dia.
 */
async function persistDou(supabase, records, opcoes = {}) {
  const { analisar = null, comPessoas = false, monitores = [], comAlertas = true,
          exigirParticao = true } = opcoes;

  const fonteDestes = records[0]?.fonte || "inlabs";
  if (exigirParticao && records.length) {
    const porData = await fontesDoDia(supabase, records.map((r) => r.published_at));
    const conflitos = [];
    for (const [dia, fontes] of porData) {
      const outras = [...fontes].filter((f) => f !== fonteDestes);
      if (outras.length) conflitos.push(`${dia} (ja servido por: ${outras.join(", ")})`);
    }
    if (conflitos.length) {
      // Falha explicita, nao silenciosa: quem quiser reingerir precisa saber que
      // esta pedindo o caminho que ainda nao tem dedupe entre fontes.
      const e = new Error(
        `Particionamento violado: ${conflitos.join("; ")}. Coletando por "${fonteDestes}". ` +
        `Reingerir dia ja coberto exige a Camada 3 (guarda textual), ainda nao disponivel. ` +
        `Use exigirParticao:false apenas se souber o que esta fazendo.`
      );
      e.code = "PARTICAO_VIOLADA";
      throw e;
    }
  }

  const existentes = await hashesExistentes(supabase, records.map((r) => r.content_hash));
  const novos = records.filter((r) => !existentes.has(r.content_hash));
  const skipped = records.length - novos.length;

  // IA e opcional e sequencial por design (rate limit): so roda quando pedida.
  const analises = new Map();
  if (analisar) {
    for (const r of novos) {
      analises.set(r.content_hash, await analisar(r.title, r.extracted_text));
    }
  }
  const analiseDe = (r) => analises.get(r.content_hash) || { summary: null, entities: [], confidence: null };

  const linhas = novos.map((r) => {
    const ai = analiseDe(r);
    let themes = [];
    try {
      themes = classifyThemes(r.title, r.extracted_text);
    } catch { /* classificacao e best-effort; nunca trava a ingestao */ }
    return {
      agency_id: r.agency_id,
      source_name: "DOU",
      source_url: r.source_url,
      document_type: DOC_TYPE[r.section] || "ato",
      title: r.title,
      published_at: r.published_at,
      content_hash: r.content_hash,
      extracted_text: r.extracted_text,
      // O coletor publico marca "preview" quando so conseguiu o resumo de 403 chars.
      // Respeitar isso e o que permite reprocessar depois so o que ficou incompleto —
      // se sobrescrevermos com "raw", a lacuna some de vista.
      extraction_status: ai.summary ? "summarized" : (r.extraction_status || "raw"),
      // themes vai no proprio insert. Se a coluna nao existir em producao, o insert
      // inteiro falharia — por isso o retry sem ela, logo abaixo.
      ...(themes.length ? { themes } : {}),
      metadata: {
        section: r.section,
        orgao: r.orgao,
        agency_acronym: r.agency_acronym,
        // Proveniencia: qual fonte serviu esta linha. E o que torna o
        // particionamento temporal AUDITAVEL por SQL — sem isso nao da para provar
        // que um dia foi servido por uma fonte so, que e o mecanismo que impede
        // duplicata entre INLABS e in.gov.br.
        fonte: r.fonte || "inlabs",
        ai_summary: ai.summary,
        ai_entities: ai.entities,
        ai_confidence: ai.confidence
      }
    };
  });

  // Falhas de escrita que NAO sao duplicata. Precisam chegar ao caller: sem isso,
  // "nao consegui gravar" e "nao havia o que gravar" produzem a mesma resposta.
  const falhasInsert = [];
  let idPorHash = await inserirDocs(supabase, linhas, falhasInsert);

  // Coluna themes ausente (migracao M14 nao aplicada): reinsere sem ela. Antes isso
  // vivia num catch inalcancavel, porque inserirDocs nunca lancava.
  if (falhasInsert.length && falhasInsert.some((f) => /themes/i.test(f))) {
    falhasInsert.length = 0;
    idPorHash = await inserirDocs(supabase, linhas.map(({ themes, ...resto }) => resto), falhasInsert);
  }

  // Alertas de ato de pessoal + hits de monitor, sobre o que REALMENTE entrou.
  const alerts = [];
  const monitorAlerts = [];
  const monitorHits = new Map();
  let directors = 0;

  for (const r of novos) {
    const docId = idPorHash.get(r.content_hash);
    if (!docId) continue; // duplicata perdida numa corrida: nada a alertar
    const ai = analiseDe(r);

    for (const h of matchMonitorsForDoc(monitores, {
      docId, title: r.title, text: r.extracted_text,
      agencyId: r.agency_id, agencyAcronym: r.agency_acronym,
      publishedAt: r.published_at, aiEntities: ai.entities
    })) {
      monitorAlerts.push(h.alert);
      monitorHits.set(h.monitorId, (monitorHits.get(h.monitorId) || 0) + 1);
    }

    if (r.section === 2) {
      if (comAlertas) alerts.push({
        target_kind: "agency",
        target_id: r.agency_id,
        // Sem alert_type o indice de dedupe de alertas nunca conflita e cada
        // reingestao do mesmo dia duplicava a linha.
        alert_type: "ato_pessoal",
        title: `Ato de pessoal: ${r.agency_acronym}`,
        description: ai.summary || r.title,
        severity: "high",
        source_document_id: docId
      });
      if (comPessoas) {
        const saida = await processPeopleFromDoc(supabase, {
          id: docId, agency_id: r.agency_id, agency_acronym: r.agency_acronym,
          published_at: r.published_at, title: r.title,
          text: r.extracted_text, aiEntities: ai.entities
        });
        directors += saida.people;
      }
    }
  }

  if (alerts.length) {
    for (const bloco of pedacos(alerts, LOTE_INSERT)) {
      await supabase.from("alerts").insert(bloco);
    }
  }

  return {
    inserted: idPorHash.size,
    // O caller PRECISA distinguir "0 porque nao havia nada" de "0 porque tudo falhou".
    falhas: falhasInsert.length,
    erros: falhasInsert.slice(0, 5),
    skipped,
    directors,
    alerts: alerts.length,
    monitorAlerts,
    monitorHits,
    pendentesDeIA: analisar ? 0 : idPorHash.size
  };
}

module.exports = { persistDou, DOC_TYPE };
