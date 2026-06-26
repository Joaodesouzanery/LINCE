// Parser CSV minimo com suporte a campos entre aspas. Para dumps grandes
// (Receita CNPJ, TSE, TCU) pre-filtre o arquivo antes de carregar.
function parseCsv(text, { delimiter = ";" } = {}) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length === header.length).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx]; });
    return obj;
  });
}

module.exports = { parseCsv };
