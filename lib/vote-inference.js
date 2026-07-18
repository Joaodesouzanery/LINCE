// M-votos — Inferência de votos (nominal + inferido por mandato) e is_divergente vs resultado.
// Portado de IRIS voto-diretores/src/lib/server/vote-inference.ts (JS vanilla / CommonJS).
// Mantém os nomes de campo do IRIS (tipo_voto, is_divergente, is_nominal, diretor_id, etc.).
// Uma camada de mapeamento no endpoint do LINCE fará a tradução dos campos depois.

const { findBestMatch } = require("./name-matcher");

// Tipos originais (apenas documentação — JS não tem tipos):
//   DiretorVoteRecord = { id, nome, nome_variantes: string[] }
//   TipoVoto = "Favoravel" | "Desfavoravel" | "Abstencao" | "Ausente"
//   VotoInsertRow = { deliberacao_id, diretor_id, tipo_voto, is_divergente, is_nominal }

function isFinalVoteDocument(input) {
  if (input.import_counts_as_final === false) return false;
  return !["pauta", "voto_individual", "documento_apoio"].includes(String(input.tipo_documento ?? ""));
}

/**
 * Decide se devemos COMPLETAR os votos por mandato (diretores ativos sem voto
 * nominal recebem o voto da decisão). Conservador e baseado em evidência:
 *  - precisa de data_reuniao (sem ela não há como saber quem estava na diretoria);
 *  - infere apenas quando há divergência NOMEADA (completa o restante como a decisão)
 *    OU unanimidade TEXTUAL sem nomes extraídos.
 *  - quórum por assinatura NÃO é evidência de "todos a favor" → não infere.
 */
function shouldInferVotesFromMandate(input) {
  if (!isFinalVoteDocument(input)) return false;
  if (!input.resultado || input.resultado === "Retirado de Pauta") return false;
  if (!input.dataReuniao) return false;
  const isUnanimous = Boolean(input.unanimidadeDetectada) || input.resultado === "Aprovado por Unanimidade";
  // Divergência/abstenção nomeada: a decisão prevaleceu → completa o restante por mandato.
  const hasDivergence = Boolean(input.nomesContra?.length) || Boolean(input.nomesAbstencao?.length);
  const hasNominalNames = Boolean(input.nomes?.length);
  return hasDivergence || (isUnanimous && !hasNominalNames);
}

/**
 * Diretores que estavam na diretoria NA DATA da reunião (base para inferência).
 * Conservador: sem data ou sem mandato cadastrado na data → retorna [] (não infere),
 * evitando atribuir voto a quem não estava no colegiado (diretores fantasma).
 */
async function getActiveDiretoresForVote(db, agenciaId, dataReuniao, _fallback) {
  if (!dataReuniao) return [];

  const { data, error } = await db
    .from("mandatos")
    .select("diretor_id, data_inicio, data_fim, diretores!inner(id, nome, nome_variantes, agencia_id)")
    .eq("diretores.agencia_id", agenciaId)
    .lte("data_inicio", dataReuniao)
    .or(`data_fim.is.null,data_fim.gte.${dataReuniao}`);

  if (error || !data?.length) return [];

  const unique = new Map();
  for (const row of data) {
    const diretor = row.diretores;
    if (!diretor?.id) continue;
    unique.set(diretor.id, {
      id: diretor.id,
      nome: diretor.nome,
      nome_variantes: Array.isArray(diretor.nome_variantes) ? diretor.nome_variantes : [],
    });
  }

  return [...unique.values()];
}

function buildVotoRows(input) {
  const resultado = input.resultado ?? null;
  const contraIds = matchIds(input.nomesContra, input.diretoresList);
  const ausenteIds = matchIds(input.nomesAusente ?? [], input.diretoresList);
  const abstencaoIds = matchIds(input.nomesAbstencao ?? [], input.diretoresList);
  const rows = new Map();

  for (const nome of input.nomes) {
    const match = findBestMatch(nome, input.diretoresList);
    // Só atribui voto nominal com alta confiança. Matches "needsReview"
    // (0.6–0.85) ficam de fora para não atribuir voto ao diretor errado —
    // o revisor humano resolve esses casos manualmente.
    if (!match.diretorId || match.needsReview) continue;
    // Precedência: Ausente > Abstencao > Desfavoravel > Favoravel.
    if (ausenteIds.has(match.diretorId)) {
      rows.set(match.diretorId, rowFor(input.deliberacao_id, match.diretorId, "Ausente", true, resultado));
    } else if (abstencaoIds.has(match.diretorId)) {
      rows.set(match.diretorId, rowFor(input.deliberacao_id, match.diretorId, "Abstencao", true, resultado));
    } else if (contraIds.has(match.diretorId)) {
      rows.set(match.diretorId, rowFor(input.deliberacao_id, match.diretorId, "Desfavoravel", true, resultado));
    } else {
      rows.set(match.diretorId, rowFor(input.deliberacao_id, match.diretorId, "Favoravel", true, resultado));
    }
  }

  for (const diretorId of contraIds) {
    if (ausenteIds.has(diretorId) || abstencaoIds.has(diretorId)) continue;
    rows.set(diretorId, rowFor(input.deliberacao_id, diretorId, "Desfavoravel", true, resultado));
  }

  for (const diretorId of abstencaoIds) {
    if (ausenteIds.has(diretorId)) continue;
    rows.set(diretorId, rowFor(input.deliberacao_id, diretorId, "Abstencao", true, resultado));
  }

  for (const diretorId of ausenteIds) {
    rows.set(diretorId, rowFor(input.deliberacao_id, diretorId, "Ausente", true, resultado));
  }

  if (input.inferFromMandate) {
    // Não fabricar "Favoravel" para diretores que o documento indica como
    // divergentes/ausentes, MESMO que o match tenha ficado na faixa de revisão
    // (0.6–0.85) e por isso não tenha virado voto nominal acima. Evita o pior
    // caso: perder um "Desfavoravel" real e ainda inventar um "Favoravel".
    const divergentIntent = collectDivergentIntentIds(
      [...input.nomesContra, ...(input.nomesAbstencao ?? []), ...(input.nomesAusente ?? [])],
      input.diretoresList,
    );
    for (const diretor of input.activeDiretoresList) {
      if (rows.has(diretor.id)) continue;
      if (divergentIntent.has(diretor.id)) continue;
      rows.set(diretor.id, rowFor(input.deliberacao_id, diretor.id, "Favoravel", false, resultado));
    }
  }

  return [...rows.values()];
}

function buildVotoRowsFromSuggestions(input) {
  const resultado = input.resultado ?? null;
  const rows = new Map();
  for (const voto of input.votosSugeridos) {
    if (!voto.diretor_id) continue;
    rows.set(voto.diretor_id, rowFor(
      input.deliberacao_id,
      voto.diretor_id,
      voto.tipo_voto,
      voto.is_nominal,
      resultado,
    ));
  }
  return [...rows.values()];
}

function buildVoteSuggestions(input) {
  const rows = buildVotoRows({
    deliberacao_id: "preview",
    ...input,
  });

  return rows.map((row) => {
    const diretor = input.diretoresList.find((dir) => dir.id === row.diretor_id)
      ?? input.activeDiretoresList.find((dir) => dir.id === row.diretor_id);
    return {
      nome: diretor?.nome ?? row.diretor_id,
      diretor_id: row.diretor_id,
      tipo_voto: row.tipo_voto,
      origem: row.tipo_voto === "Ausente"
        ? "ausente"
        : row.tipo_voto === "Abstencao"
          ? "abstencao"
          : row.tipo_voto === "Desfavoravel"
            ? "contrario"
            : row.is_nominal
              ? "nominal"
              : "inferido_mandato",
      is_nominal: row.is_nominal,
    };
  });
}

function matchIds(names, diretoresList) {
  const ids = new Set();
  for (const nome of names) {
    const match = findBestMatch(nome, diretoresList);
    // Apenas matches de alta confiança contam como voto contra/ausente/abstenção.
    if (match.diretorId && !match.needsReview) ids.add(match.diretorId);
  }
  return ids;
}

/**
 * IDs de diretores com INTENÇÃO divergente no documento, incluindo matches de
 * confiança média (faixa 0.6–0.85). Usado só para BLOQUEAR a inferência de
 * "Favoravel" sobre eles — nunca para gravar voto (isso exige revisão humana).
 */
function collectDivergentIntentIds(names, diretoresList) {
  const ids = new Set();
  for (const nome of names) {
    const match = findBestMatch(nome, diretoresList);
    if (match.diretorId && match.score >= 0.6) ids.add(match.diretorId);
  }
  return ids;
}

/** Resultado "positivo" (decisão prevaleceu), negativo (Indeferido) ou neutro/desconhecido. */
function isPositiveResult(resultado) {
  if (!resultado || resultado === "Retirado de Pauta") return null;
  if (resultado === "Indeferido") return false;
  return true;
}

/**
 * Divergência relativa ao RESULTADO da maioria:
 *  - Abstenção sempre conta como não-consenso (divergente).
 *  - Resultado positivo → divergente quem votou Desfavorável.
 *  - Resultado negativo (Indeferido) → divergente quem votou Favorável.
 *  - Sem resultado conhecido → cai no comportamento anterior (Desfavorável).
 */
function isDivergentVote(tipoVoto, resultado) {
  if (tipoVoto === "Ausente") return false;
  if (tipoVoto === "Abstencao") return true;
  const positive = isPositiveResult(resultado);
  if (positive === null) return tipoVoto === "Desfavoravel";
  return positive ? tipoVoto === "Desfavoravel" : tipoVoto === "Favoravel";
}

function rowFor(deliberacaoId, diretorId, tipoVoto, isNominal, resultado = null) {
  return {
    deliberacao_id: deliberacaoId,
    diretor_id: diretorId,
    tipo_voto: tipoVoto,
    is_divergente: isDivergentVote(tipoVoto, resultado),
    is_nominal: isNominal,
  };
}

module.exports = {
  isFinalVoteDocument,
  shouldInferVotesFromMandate,
  getActiveDiretoresForVote,
  buildVotoRows,
  buildVotoRowsFromSuggestions,
  buildVoteSuggestions,
  isDivergentVote,
};
