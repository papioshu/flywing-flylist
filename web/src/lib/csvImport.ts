// Turns an admin-uploaded CSV into { line, wallet, twitter } rows for POST /admin/import.
// The server re-validates every row; this only finds the two columns.
// Columns are picked by header name (wallet/address, twitter/x/handle/username) when a header row exists,
// otherwise column 1 = wallet, column 2 = X handle. A FLYLIST export re-imports as-is.
export type ImportRow = { line: number; wallet: string; twitter: string };

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseImportCsv(text: string): ImportRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = splitCsvLine(lines[0] ?? "");
  const hasHeader = !/^0x[0-9a-fA-F]{40}$/.test(first[0] ?? "") && first.some((c) => /[a-z]/i.test(c));
  let walletCol = 0;
  let twitterCol = 1;
  if (hasHeader) {
    const h = first.map((c) => c.toLowerCase());
    const w = h.findIndex((c) => /wallet|address/.test(c));
    const t = h.findIndex((c) => /twitter|^x$|x_|handle|username/.test(c) && !/url/.test(c));
    if (w >= 0) walletCol = w;
    if (t >= 0) twitterCol = t;
  }
  const rows: ImportRow[] = [];
  lines.forEach((raw, i) => {
    if ((hasHeader && i === 0) || raw.trim() === "") return;
    const cells = splitCsvLine(raw);
    rows.push({ line: i + 1, wallet: cells[walletCol] ?? "", twitter: cells[twitterCol] ?? "" });
  });
  return rows;
}
