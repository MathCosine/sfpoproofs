// =====================================================================
//  CSV out — results exports. parseCsv is kept because the round-trip
//  test is what proves toCsv's quoting is right.
// =====================================================================

/** Minimal RFC4180-ish parser: handles quotes, embedded commas, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Spreadsheets treat a cell starting with = + - @ (or a tab/return) as a
 * formula, so a team calling itself `=HYPERLINK(...)` would execute when
 * somebody opens the results in Excel. Prefixing a single quote makes it
 * text; the quote is not shown by any spreadsheet that honours it.
 */
function deFormula(text) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function toCsv(header, rows) {
  const esc = (v) => {
    const s = deFormula(v == null ? '' : String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

export function downloadCsv(filename, csv) {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
