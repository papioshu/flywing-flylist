// RFC 4180 CSV with spreadsheet formula-injection protection.

// Cells starting with these characters can be interpreted as formulas by
// Excel / Google Sheets / LibreOffice (OWASP "CSV Injection").
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"]);

export function neutralizeFormula(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGERS.has(value[0])) return `'${value}`;
  return value;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(typeof value === "string" ? value : String(value));
  // Always quote: commas, quotes and newlines are then always safe, and every
  // spreadsheet app treats a quoted cell as text.
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

/** UTF-8 BOM so Excel detects the encoding; Sheets and LibreOffice ignore it. */
export const CSV_BOM = "﻿";

export function toCsv(header: string[], rows: unknown[][]): string {
  return CSV_BOM + [header.map(csvCell).join(","), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}
