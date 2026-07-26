// F3 (NOMOS) — Relatorio/digest de um painel curado. FONTE UNICA usada por:
//   - endpoint painel_report (JSON + markdown) — o botao "Exportar relatorio"
//   - endpoint painel_send_report + scripts/send-painel-reports.js (webhook/e-mail)
// Sem IA. Degrada gracioso (tabela ausente -> lista vazia). "Novidade" = votacoes
// DATAVEIS (legislative_votacoes) desde `since`; a `situacao` e snapshot (sem data),
// entao entra como estado atual, nao como "mudou" (honesto, nao inventa data).

// Hidrata os itens do painel + busca novidades. `since` = ISO (default: 30 dias).
// NAO reusa o painel_get (query propria) p/ nao arriscar o endpoint ja shipado.
// byIngestion=true (digest agendado): "novo" = INGERIDO desde o ultimo envio
// (created_at > since, ESTRITO) — nao duplica no limite do dia nem perde voto
// ingerido com atraso. byIngestion=false (relatorio on-demand): snapshot dos votos
// recentes por DATA do evento (data_votacao >= sinceDate).
async function buildPainelDigest(supabase, painelId, { since, byIngestion = false } = {}) {
  const sinceIso = since || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const { data: painel } = await supabase.from("paineis").select("*").eq("id", painelId).maybeSingle();
  if (!painel) return null;

  const { data: rows } = await supabase.from("painel_items").select("*").eq("painel_id", painelId).order("created_at", { ascending: true });
  const items = rows || [];
  const refsOf = (k) => items.filter((r) => r.item_kind === k).map((r) => r.ref_id);
  const propRefs = refsOf("proposicao"), stakeRefs = refsOf("stakeholder"), orgaoRefs = refsOf("orgao");

  const [propsRes, stakeRes, orgaoRes, votRes] = await Promise.allSettled([
    propRefs.length ? supabase.from("proposicoes").select("id, casa, tipo, numero, ano, titulo, ementa, situacao, themes, url").in("id", propRefs) : Promise.resolve({ data: [] }),
    stakeRefs.length ? supabase.from("people").select("id, full_name, role, uf").in("id", stakeRefs) : Promise.resolve({ data: [] }),
    orgaoRefs.length ? supabase.from("agencies").select("id, acronym, name").in("id", orgaoRefs) : Promise.resolve({ data: [] }),
    propRefs.length
      ? (byIngestion
          ? supabase.from("legislative_votacoes").select("proposicao_id, casa, descricao, data_votacao, resultado").in("proposicao_id", propRefs).gt("created_at", sinceIso).order("data_votacao", { ascending: false })
          : supabase.from("legislative_votacoes").select("proposicao_id, casa, descricao, data_votacao, resultado").in("proposicao_id", propRefs).gte("data_votacao", sinceDate).order("data_votacao", { ascending: false }))
      : Promise.resolve({ data: [] })
  ]);
  const dataOf = (r) => (r.status === "fulfilled" ? (r.value.data || []) : []);
  const propMap = new Map(dataOf(propsRes).map((x) => [String(x.id), x]));
  const stakeMap = new Map(dataOf(stakeRes).map((x) => [String(x.id), x]));
  const orgaoMap = new Map(dataOf(orgaoRes).map((x) => [String(x.id), x]));

  const hydrate = (r, m) => ({ item_id: r.id, ref_id: r.ref_id, prioridade: r.prioridade, posicionamento: r.posicionamento, tags: r.tags, nota: r.nota, data: m.get(String(r.ref_id)) || null });
  const proposicoes = items.filter((r) => r.item_kind === "proposicao").map((r) => hydrate(r, propMap));
  const stakeholders = items.filter((r) => r.item_kind === "stakeholder").map((r) => hydrate(r, stakeMap));
  const orgaos = items.filter((r) => r.item_kind === "orgao").map((r) => hydrate(r, orgaoMap));

  const novas_votacoes = dataOf(votRes).map((v) => ({
    proposicao_id: v.proposicao_id,
    titulo: (propMap.get(String(v.proposicao_id)) || {}).titulo || v.proposicao_id,
    descricao: v.descricao, data_votacao: v.data_votacao, resultado: v.resultado, casa: v.casa
  }));

  const counts = { proposicoes: proposicoes.length, stakeholders: stakeholders.length, orgaos: orgaos.length, novas_votacoes: novas_votacoes.length };
  return { painel, since: sinceIso, proposicoes, stakeholders, orgaos, novas_votacoes, counts, has_novidade: novas_votacoes.length > 0 };
}

const d10 = (s) => String(s || "").slice(0, 10);
// Escapa `|` e quebras de linha p/ nao estourar celula de tabela markdown.
const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
// Escape HTML (corpo de e-mail).
const eh = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Markdown limpo p/ o handoff ao Claude Design (o que o botao "Exportar" baixa).
function toMarkdown(digest) {
  if (!digest) return "";
  const p = digest.painel;
  const L = [];
  L.push(`# Painel: ${p.nome}${p.cliente ? ` — ${p.cliente}` : ""}`);
  L.push("");
  L.push(`_Relatório gerado em ${d10(new Date().toISOString())} · fonte: LINCE (Câmara/Senado Dados Abertos, TSE)_`);
  if (p.descricao) { L.push(""); L.push(cell(p.descricao)); }
  L.push("");
  L.push(`**Resumo:** ${digest.counts.proposicoes} proposição(ões) · ${digest.counts.stakeholders} stakeholder(s) · ${digest.counts.orgaos} órgão(s)`);

  L.push("");
  L.push(`## Novas votações desde ${d10(digest.since)}`);
  L.push("");
  if (digest.novas_votacoes.length) {
    L.push("| Data | Proposição | Resultado | Casa |");
    L.push("| --- | --- | --- | --- |");
    for (const v of digest.novas_votacoes) L.push(`| ${d10(v.data_votacao)} | ${cell(v.titulo)} | ${cell(v.resultado || "—")} | ${cell(v.casa || "—")} |`);
  } else {
    L.push("_Sem novas votações no período._");
  }

  L.push("");
  L.push(`## Proposições monitoradas (${digest.proposicoes.length})`);
  L.push("");
  if (digest.proposicoes.length) {
    L.push("| Proposição | Situação | Posição | Prioridade | Tema |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const it of digest.proposicoes) {
      const dd = it.data || {};
      const tema = Array.isArray(dd.themes) ? dd.themes.join(", ") : "";
      L.push(`| ${cell(dd.titulo || it.ref_id)} | ${cell(dd.situacao || "—")} | ${cell(it.posicionamento || "—")} | ${cell(it.prioridade || "—")} | ${cell(tema)} |`);
    }
  } else {
    L.push("_Nenhuma proposição no painel._");
  }

  if (digest.stakeholders.length) {
    L.push("");
    L.push(`## Stakeholders (${digest.stakeholders.length})`);
    L.push("");
    for (const it of digest.stakeholders) {
      const dd = it.data || {};
      L.push(`- **${cell(dd.full_name || it.ref_id)}**${dd.role ? ` — ${cell(dd.role)}` : ""}${dd.uf ? ` (${cell(dd.uf)})` : ""}`);
    }
  }

  if (digest.orgaos.length) {
    L.push("");
    L.push(`## Órgãos (${digest.orgaos.length})`);
    L.push("");
    for (const it of digest.orgaos) {
      const dd = it.data || {};
      L.push(`- ${cell(dd.acronym || it.ref_id)}${dd.name ? ` — ${cell(dd.name)}` : ""}`);
    }
  }

  L.push("");
  L.push("---");
  L.push("_LINCE · inteligência regulatória. Dados públicos (Câmara/Senado Dados Abertos, TSE). Conteúdo para arte final no Claude Design._");
  return L.join("\n");
}

// Texto curto p/ webhook (Slack/Discord/genérico) — foca nas novidades.
function toText(digest) {
  if (!digest) return "";
  const p = digest.painel;
  const nv = digest.novas_votacoes || [];
  const head = `📋 Painel "${p.nome}"${p.cliente ? ` (${p.cliente})` : ""} — ${nv.length} nova(s) votação(ões) desde ${d10(digest.since)}`;
  const lines = nv.slice(0, 15).map((v) => `• ${d10(v.data_votacao)} — ${v.titulo} — ${v.resultado || "?"} (${v.casa || "?"})`);
  const extra = nv.length > 15 ? `\n… +${nv.length - 15} outra(s)` : "";
  return `${head}${lines.length ? "\n" + lines.join("\n") : ""}${extra}`;
}

// Corpo HTML do e-mail (inline styles p/ compatibilidade com clientes de e-mail).
function toEmailHtml(digest) {
  if (!digest) return "";
  const p = digest.painel;
  const styTh = "padding:6px 10px;text-align:left;border-bottom:2px solid #ccc;font-size:12px;color:#444;text-transform:uppercase;letter-spacing:.04em";
  const styTd = "padding:6px 10px;border-bottom:1px solid #eee;font-size:13px";
  const table = (headers, rows) => rows.length
    ? `<table style="border-collapse:collapse;width:100%;margin:6px 0 14px"><thead><tr>${headers.map((h) => `<th style="${styTh}">${eh(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((cs) => `<tr>${cs.map((c) => `<td style="${styTd}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : "";
  const votRows = digest.novas_votacoes.map((v) => [eh(d10(v.data_votacao)), eh(v.titulo), eh(v.resultado || "—"), eh(v.casa || "—")]);
  const propRows = digest.proposicoes.map((it) => { const dd = it.data || {}; return [eh(dd.titulo || it.ref_id), eh(dd.situacao || "—"), eh(it.posicionamento || "—"), eh(it.prioridade || "—")]; });
  const stakes = digest.stakeholders.map((it) => { const dd = it.data || {}; return `<li><b>${eh(dd.full_name || it.ref_id)}</b>${dd.role ? " — " + eh(dd.role) : ""}${dd.uf ? " (" + eh(dd.uf) + ")" : ""}</li>`; }).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:680px;margin:0 auto;padding:8px">
  <h1 style="font-size:20px;margin:0 0 2px">Painel: ${eh(p.nome)}${p.cliente ? ` — ${eh(p.cliente)}` : ""}</h1>
  <p style="color:#666;font-size:12px;margin:0 0 14px">Relatório gerado em ${eh(d10(new Date().toISOString()))} · LINCE · dados públicos (Câmara/Senado, TSE)</p>
  <p style="font-size:14px;margin:0 0 6px"><b>Resumo:</b> ${digest.counts.proposicoes} proposição(ões) · ${digest.counts.stakeholders} stakeholder(s) · ${digest.counts.orgaos} órgão(s)</p>
  <h2 style="font-size:15px;margin:18px 0 4px">Novas votações desde ${eh(d10(digest.since))}</h2>
  ${digest.novas_votacoes.length ? table(["Data", "Proposição", "Resultado", "Casa"], votRows) : `<p style="color:#666;font-size:13px">Sem novas votações no período.</p>`}
  <h2 style="font-size:15px;margin:18px 0 4px">Proposições monitoradas (${digest.proposicoes.length})</h2>
  ${digest.proposicoes.length ? table(["Proposição", "Situação", "Posição", "Prioridade"], propRows) : `<p style="color:#666;font-size:13px">Nenhuma proposição.</p>`}
  ${digest.stakeholders.length ? `<h2 style="font-size:15px;margin:18px 0 4px">Stakeholders (${digest.stakeholders.length})</h2><ul style="font-size:13px;padding-left:18px;margin:4px 0">${stakes}</ul>` : ""}
  ${digest.orgaos.length ? `<h2 style="font-size:15px;margin:18px 0 4px">Órgãos (${digest.orgaos.length})</h2><ul style="font-size:13px;padding-left:18px;margin:4px 0">${digest.orgaos.map((it) => { const dd = it.data || {}; return `<li>${eh(dd.acronym || it.ref_id)}${dd.name ? " — " + eh(dd.name) : ""}</li>`; }).join("")}</ul>` : ""}
  <hr style="border:none;border-top:1px solid #eee;margin:18px 0 8px">
  <p style="color:#999;font-size:11px">LINCE · inteligência regulatória. Você recebe este e-mail como responsável por este painel.</p>
</div>`;
}

module.exports = { buildPainelDigest, toMarkdown, toText, toEmailHtml };
