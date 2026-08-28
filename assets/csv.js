// =====================================================================
//  CSV in (guts scores) and CSV out (grades, leaderboards).
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

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Guts import. The agreed shape is `team,score`, but a header is
 * optional and an extra `division` column is honoured if present — that
 * saves assigning divisions by hand for teams whose proofs are not
 * graded yet.
 */
export function parseGutsCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], errors: ['That file had no rows in it.'] };

  let teamCol = 0; let scoreCol = 1; let divCol = -1;
  let start = 0;

  const head = rows[0].map(norm);
  const looksLikeHeader = head.some((h) => ['team', 'team #', 'team_number', 'score', 'guts', 'points', 'division', 'div'].includes(h));
  if (looksLikeHeader) {
    start = 1;
    const find = (...names) => head.findIndex((h) => names.includes(h));
    const t = find('team', 'team #', 'team_number', 'teamid', 'team id');
    const s = find('score', 'guts', 'guts score', 'points', 'total');
    const d = find('division', 'div');
    if (t >= 0) teamCol = t;
    if (s >= 0) scoreCol = s;
    divCol = d;
  }

  const out = [];
  const errors = [];
  const seen = new Set();

  for (let i = start; i < rows.length; i += 1) {
    const cells = rows[i];
    const line = i + 1;
    const rawTeam = (cells[teamCol] ?? '').trim();
    const rawScore = (cells[scoreCol] ?? '').trim();
    if (!rawTeam && !rawScore) continue;

    const team = Number(String(rawTeam).replace(/[^0-9]/g, ''));
    const score = Number(rawScore);

    if (!Number.isInteger(team) || team < 1) {
      errors.push(`Line ${line}: "${rawTeam}" is not a team number.`);
      continue;
    }
    if (!Number.isFinite(score) || score < 0) {
      errors.push(`Line ${line}: "${rawScore}" is not a score.`);
      continue;
    }
    if (seen.has(team)) {
      errors.push(`Line ${line}: team ${team} appears twice — the later row wins.`);
    }
    seen.add(team);

    const entry = { team, score };
    if (divCol >= 0) {
      const d = (cells[divCol] ?? '').trim().toUpperCase().replace(/^DIVISION\s*/, '');
      if (d === 'A' || d === 'B') entry.division = d;
    }
    // Later duplicates replace earlier ones.
    const existing = out.findIndex((r) => r.team === team);
    if (existing >= 0) out[existing] = entry; else out.push(entry);
  }
  return { rows: out, errors };
}

export function toCsv(header, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
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
