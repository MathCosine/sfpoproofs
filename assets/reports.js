// =====================================================================
//  Score reports: a page per student and a page per team, to print or
//  save as a PDF.
//
//  What a report shows is decided here, once: scores, places (the
//  individual tiebreak splits equal scores once it is entered; otherwise,
//  and for teams, equal scores share a place), which problems were right,
//  wrong or blank, and where the score sits among the division. What it
//  never shows is what anybody wrote -- a report is handed to a student,
//  and the answers on the sheet are not theirs to take home from it.
//
//  Pure functions over the standings the portal already holds, and a
//  string of HTML at the end, so the numbers on paper are the numbers on
//  the leaderboard and all of it can be tested without a browser.
// =====================================================================

import {
  competitionRanks, ordinal, summarise, keyMaxPoints, gutsKey, problemsInSet,
  divisionOfTeam, compareIndividuals, individualRankKey, hasTiebreak,
} from './scoring.js?v=2026.09.30.1';

const byId = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/** "tied with 2 others", or nothing when the score is nobody else's. */
export function tiedPhrase(others) {
  if (!others) return '';
  return `tied with ${others} other${others === 1 ? '' : 's'}`;
}

/**
 * Places within one division, the way the leaderboard shows them: the
 * disqualified are left out, the rest sorted best first and placed with
 * competition ranking, so two firsts are both first and nobody is second.
 * `compare` and `rankKey` default to the plain value; students pass the
 * tiebreak-aware pair, so a tiebreak splits them here as it does there.
 */
function placed(rows, valueOf, idOf, {
  compare = (a, b) => valueOf(b) - valueOf(a),
  rankKey = valueOf,
} = {}) {
  const sorted = [...rows].sort((a, b) => compare(a, b) || byId(idOf(a), idOf(b)));
  const places = competitionRanks(sorted, rankKey);
  const counts = new Map();
  for (const r of sorted) counts.set(rankKey(r), (counts.get(rankKey(r)) ?? 0) + 1);
  const out = new Map();
  sorted.forEach((r, i) => out.set(idOf(r), {
    place: places[i], of: sorted.length, tiedWith: counts.get(rankKey(r)) - 1,
  }));
  return out;
}

/** Student places: score, then the tiebreak list when there is one. */
const placeStudents = (cohort) => placed(cohort, (p) => p.score, (p) => p.individualId,
  { compare: compareIndividuals, rankKey: individualRankKey });

// ---------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------

/**
 * One report per contestant who sat the paper and was not disqualified.
 * `teams` supplies team names; `individuals` is individualStandings().
 */
export function studentReports({ individuals, teams = [], key, cfg, combined = null, guts = [] }) {
  const teamNames = new Map(teams.map((t) => [String(t.team), t.name ?? '']));
  // With the team standings to hand, each page also says how the team did
  // -- its combined score and place, never a teammate's own score.
  const teamLine = combined ? teamSummaries(combined, guts, cfg) : new Map();
  const out = [];
  for (const division of cfg.DIVISIONS) {
    const cohort = individuals.filter((p) => p.division === division && !p.disqualified);
    if (!cohort.length) continue;
    const max = keyMaxPoints(key, 'individual', cfg.INDIVIDUAL_PROBLEMS, division);
    const places = placeStudents(cohort);
    const tiebreaks = cohort.some(hasTiebreak);
    const onScore = new Map();
    for (const p of cohort) onScore.set(p.score, (onScore.get(p.score) ?? 0) + 1);
    const stats = summarise(cohort.map((p) => p.score));
    const top = Math.max(1, Math.round(max));
    const distribution = Array.from({ length: top + 1 }, (_, score) => ({ score, count: 0 }));
    for (const p of cohort) {
      distribution[Math.max(0, Math.min(top, Math.round(p.score)))].count += 1;
    }
    const solveRates = Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) =>
      cohort.filter((p) => p.marks?.[i] === 'correct').length / cohort.length);

    for (const p of [...cohort].sort((a, b) => byId(a.individualId, b.individualId))) {
      const marks = p.marks ?? [];
      out.push({
        kind: 'student',
        id: p.individualId,
        name: p.name ?? '',
        division,
        team: p.team,
        teamName: teamNames.get(String(p.team)) ?? '',
        teamResult: teamLine.get(String(p.team)) ?? null,
        score: p.score,
        max,
        correct: marks.filter((m) => m === 'correct').length,
        wrong: marks.filter((m) => m === 'wrong').length,
        blank: marks.filter((m) => m === 'blank').length,
        marks: marks.map((m) => (m === 'correct' || m === 'wrong' ? m : m === 'unkeyed' ? 'unkeyed' : 'blank')),
        ...places.get(p.individualId),
        // Said on the page only when the tiebreak is what placed them:
        // on the list, and somebody else had the same score.
        tiebreakPlace: p.tiebreakRank ?? null,
        placedByTiebreak: hasTiebreak(p) && onScore.get(p.score) > 1,
        tiebreaks,
        stats,
        distribution,
        solveRates,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------

/**
 * The guts round, problem by problem: right, wrong or blank, and what
 * each set earned. Never the answer given.
 */
export function gutsBreakdown(answersByProblem, key, cfg, division) {
  const table = gutsKey(key, division);
  const sets = [];
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    const problems = problemsInSet(set, cfg);
    const points = table.get(problems[0])?.points ?? set;
    let earned = 0;
    const marks = problems.map((p) => {
      const given = answersByProblem?.get(p) ?? null;
      const expected = table.get(p)?.answer ?? null;
      if (given == null) return 'blank';
      if (expected == null) return 'unkeyed';
      if (given === expected) { earned += table.get(p)?.points ?? 0; return 'correct'; }
      return 'wrong';
    });
    const possible = problems.reduce((sum, p) => sum + (table.get(p)?.points ?? 0), 0);
    sets.push({ set, points, marks, earned, possible });
  }
  return sets;
}

/**
 * The teams that took part in each division -- a member entered or a guts
 * set in -- and were not disqualified, with their combined places.
 */
function teamCohorts(combined, guts, cfg) {
  const gutsRows = new Map(guts.map((g) => [String(g.team), g]));
  const tookPart = (t) => t.members.length > 0
    || (gutsRows.get(String(t.team))?.perSet ?? []).some((s) => s.entered > 0);
  return cfg.DIVISIONS.map((division) => {
    const cohort = combined.filter((t) => (t.division ?? divisionOfTeam(t.team)) === division
      && !t.disqualified && tookPart(t));
    return { division, cohort, byCombined: placed(cohort, (t) => t.total, (t) => t.team) };
  });
}

/** team -> its combined score and place, for the line on a student's page. */
function teamSummaries(combined, guts, cfg) {
  const out = new Map();
  for (const { cohort, byCombined } of teamCohorts(combined, guts, cfg)) {
    for (const t of cohort) {
      out.set(String(t.team), { total: t.total, max: t.max, ...byCombined.get(t.team) });
    }
  }
  return out;
}

/**
 * One report per team that took part and was not disqualified.
 * `combined` is combinedStandings(), `guts` is gutsStandings(),
 * `gutsByTeam` is indexGutsAnswers().
 */
export function teamReports({ combined, guts, individuals, gutsByTeam, key, cfg }) {
  const studentPlaces = new Map();
  const tiebreakDivisions = new Set();
  for (const division of cfg.DIVISIONS) {
    const cohort = individuals.filter((p) => p.division === division && !p.disqualified);
    for (const [id, p] of placeStudents(cohort)) studentPlaces.set(id, p);
    if (cohort.some(hasTiebreak)) tiebreakDivisions.add(division);
  }
  const out = [];
  for (const { division, cohort, byCombined } of teamCohorts(combined, guts, cfg)) {
    if (!cohort.length) continue;
    const gutsOf = (t) => Number(t.guts ?? 0);
    const byIndividual = placed(cohort, (t) => t.individual, (t) => t.team);
    const byGuts = placed(cohort, gutsOf, (t) => t.team);
    const totals = cohort.map((t) => ({ team: String(t.team), total: t.total }));
    const stats = summarise(cohort.map((t) => t.total));

    for (const t of [...cohort].sort((a, b) => byId(a.team, b.team))) {
      const members = [...t.members]
        .sort((a, b) => byId(a.individualId, b.individualId))
        .map((m) => ({
          id: m.individualId,
          name: m.name ?? '',
          score: m.score,
          counted: Boolean(m.counted),
          ranked: !m.selfDisqualified && !m.disqualified,
          ...(studentPlaces.get(m.individualId) ?? { place: null, of: null, tiedWith: 0 }),
        }));
      const counting = members.filter((m) => m.counted).map((m) => m.score)
        .sort((a, b) => b - a);
      out.push({
        kind: 'team',
        team: String(t.team),
        name: t.name ?? '',
        division,
        total: t.total,
        max: t.max,
        individual: t.individual,
        indMax: t.indMax,
        multiplier: t.multiplier,
        counting,
        guts: gutsOf(t),
        gutsMax: t.gutsMax,
        members,
        sets: gutsBreakdown(gutsByTeam.get(String(t.team)), key, cfg, division),
        places: {
          combined: byCombined.get(t.team),
          individual: byIndividual.get(t.team),
          guts: byGuts.get(t.team),
        },
        totals,
        stats,
        tiebreaks: tiebreakDivisions.has(division),
      });
    }
  }
  return out;
}

/**
 * Which reports to print. `only` is whatever was typed in the box: IDs
 * and team keys, separated by anything. A team key picks out its members
 * for student reports; a member's ID picks out their team for team ones.
 */
export function pickReports(reports, { division = '', only = '' } = {}) {
  const wanted = String(only).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return reports.filter((r) => {
    if (division && r.division !== division) return false;
    if (!wanted.length) return true;
    if (r.kind === 'student') return wanted.includes(r.id) || wanted.includes(String(r.team));
    return wanted.includes(r.team) || r.members.some((m) => wanted.includes(m.id));
  });
}

// ---------------------------------------------------------------------
// The spreadsheet versions, for a mail merge
// ---------------------------------------------------------------------

const MARK_LETTER = { correct: 'C', wrong: 'X', blank: 'B', unkeyed: 'U' };

export function studentReportTable(reports, cfg) {
  const header = ['individual_id', 'name', 'division', 'team', 'team_name', 'score', 'out_of',
    'place', 'of', 'tied_with', 'tiebreak_place', 'correct', 'incorrect', 'blank',
    'division_median', 'division_mean', 'division_top',
    ...Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => `p${i + 1}`)];
  const rows = reports.map((r) => [
    r.id, r.name, r.division, r.team, r.teamName, r.score, r.max, r.place, r.of, r.tiedWith,
    r.tiebreakPlace ?? '',
    r.correct, r.wrong, r.blank, round1(r.stats.median), round1(r.stats.mean), r.stats.max,
    ...r.marks.map((m) => MARK_LETTER[m] ?? ''),
  ]);
  return { header, rows };
}

export function teamReportTable(reports, cfg) {
  const header = ['team', 'name', 'division',
    'combined', 'combined_out_of', 'combined_place', 'of', 'combined_tied_with',
    'individual_best_three', 'multiplier', 'individual_counted', 'individual_place',
    'guts', 'guts_out_of', 'guts_place'];
  for (let i = 1; i <= 4; i += 1) {
    header.push(`member${i}_id`, `member${i}_name`, `member${i}_score`, `member${i}_counts`);
  }
  for (let s = 1; s <= cfg.GUTS_SETS; s += 1) header.push(`guts_set${s}`);
  const rows = reports.map((r) => {
    const row = [r.team, r.name, r.division,
      r.total, r.max, r.places.combined.place, r.places.combined.of, r.places.combined.tiedWith,
      r.individual, r.multiplier, r.individual * r.multiplier, r.places.individual.place,
      r.guts, r.gutsMax, r.places.guts.place];
    for (let i = 0; i < 4; i += 1) {
      const m = r.members[i];
      row.push(m?.id ?? '', m?.name ?? '', m?.score ?? '', m ? (m.counted ? 'yes' : 'no') : '');
    }
    for (const s of r.sets) row.push(s.earned);
    return row;
  });
  return { header, rows };
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;

// ---------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));
const MARK_GLYPH = { correct: '✓', wrong: '✗', blank: '–', unkeyed: '·' };
const MARK_WORD = { correct: 'correct', wrong: 'incorrect', blank: 'blank', unkeyed: 'not marked' };

/**
 * Clean axis steps: at most about `most` ticks from 0 to `top`, and never
 * a fraction -- nobody is half a contestant.
 */
function niceStep(top, most = 4) {
  const raw = Math.max(1, top) / most;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return Math.max(1, m * pow);
  return Math.max(1, 10 * pow);
}

/** A column with a 4px rounded data-end and a square foot on the baseline. */
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * The division's scores as columns, one per possible score, with this
 * student's column in the accent and everyone else's in gray. Emphasis,
 * not a legend: the chart is about one person.
 */
export function histogramSvg(distribution, mine, { label = 'You' } = {}) {
  const W = 700; const H = 256;
  const left = 30; const right = 6; const top = 30; const bottom = 26;
  const plotW = W - left - right; const plotH = H - top - bottom;
  const most = Math.max(1, ...distribution.map((d) => d.count));
  const step = niceStep(most, 4);
  const yTop = Math.ceil(most / step) * step;
  const slot = plotW / distribution.length;
  const barW = Math.min(24, slot - 4);
  const y = (v) => top + plotH - (v / yTop) * plotH;
  const parts = [];
  for (let v = 0; v <= yTop; v += step) {
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" class="grid${v === 0 ? ' base' : ''}"/>`,
      `<text x="${left - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v}</text>`);
  }
  const mineBin = Math.max(0, Math.min(distribution.length - 1, Math.round(mine)));
  distribution.forEach((d, i) => {
    const cx = left + slot * i + slot / 2;
    const isMine = i === mineBin;
    if (d.count > 0) {
      const h = (d.count / yTop) * plotH;
      parts.push(`<path d="${columnPath(cx - barW / 2, y(d.count), barW, h)}" class="${isMine ? 'bar bar--mine' : 'bar'}"/>`);
    }
    parts.push(`<text x="${cx}" y="${H - 8}" class="tick${isMine ? ' tick--mine' : ''}" text-anchor="middle">${d.score}</text>`);
    if (isMine) {
      parts.push(`<text x="${cx}" y="${y(d.count) - 9}" class="callout" text-anchor="middle">${esc(label)}</text>`);
    }
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score distribution">${parts.join('')}</svg>`;
}

/**
 * Every team in the division as a dot on one scale, stacked where they
 * land close together, with this team's dot in the accent and named.
 */
export function stripSvg(totals, mineTeam, max, { label = '' } = {}) {
  const W = 700; const H = 132;
  const left = 12; const right = 12; const base = 100;
  const plotW = W - left - right;
  const x = (v) => left + (Math.max(0, Math.min(max, v)) / Math.max(1, max)) * plotW;
  const r = 6; const pitch = 14;
  const parts = [];
  const step = niceStep(max, 6);
  for (let v = 0; v <= max + 1e-9; v += step) {
    parts.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${base}" y2="${base + 5}" class="grid base"/>`,
      `<text x="${x(v)}" y="${base + 20}" class="tick" text-anchor="middle">${fmt(v)}</text>`);
  }
  parts.push(`<line x1="${left}" x2="${W - right}" y1="${base}" y2="${base}" class="grid base"/>`);
  // A dot plot: each dot snaps to a column one dot-and-a-gap wide, and
  // teams in the same column stack upward, so no two dots ever overlap.
  const levels = new Map();
  const placedDots = [...totals].sort((a, b) => a.total - b.total || byId(a.team, b.team)).map((t) => {
    const bin = Math.round((x(t.total) - left) / pitch);
    const level = levels.get(bin) ?? 0;
    levels.set(bin, level + 1);
    return { ...t, cx: left + bin * pitch, cy: base - 9 - Math.min(level, 6) * pitch };
  });
  let mineDot = null;
  for (const d of placedDots) {
    if (d.team === mineTeam) { mineDot = d; continue; }
    parts.push(`<circle cx="${d.cx}" cy="${d.cy}" r="${r}" class="dot"/>`);
  }
  if (mineDot) {
    parts.push(`<circle cx="${mineDot.cx}" cy="${mineDot.cy}" r="${r + 1}" class="dot dot--mine"/>`);
    const anchor = mineDot.cx > W - 110 ? 'end' : mineDot.cx < 110 ? 'start' : 'middle';
    parts.push(`<text x="${mineDot.cx}" y="${Math.min(mineDot.cy - 14, 22)}" class="callout" text-anchor="${anchor}">${esc(label)}</text>`,
      `<line x1="${mineDot.cx}" x2="${mineDot.cx}" y1="${Math.min(mineDot.cy - 14, 22) + 4}" y2="${mineDot.cy - r - 3}" class="leader"/>`);
  }
  return `<svg class="chart chart--strip" viewBox="0 0 ${W} ${H}" role="img" aria-label="Team totals">${parts.join('')}</svg>`;
}

/** A long name steps down a size or two rather than pushing the page over. */
const nameClass = (name) => {
  const n = String(name ?? '').length;
  return n > 44 ? ' who__name--long' : n > 26 ? ' who__name--mid' : '';
};

const tile = (label, value, of, sub, lead = false) => `
  <div class="tile${lead ? ' tile--lead' : ''}">
    <div class="tile__label">${esc(label)}</div>
    <div class="tile__value">${value}${of ? `<span class="tile__of">${of}</span>` : ''}</div>
    <div class="tile__sub">${sub}</div>
  </div>`;

const SEP = '<span class="sep">·</span>';
const placeValue = (p) => (p?.place ? esc(ordinal(p.place)) : '—');
const placeSub = (p, division = null) => (p?.place
  ? `of ${p.of}${division ? ` in Division ${esc(division)}` : ''}`
    + `${p.tiedWith ? ` ${SEP} ${tiedPhrase(p.tiedWith)}` : ''}`
  : 'not ranked');

function studentPage(r, contestName) {
  const cells = r.marks.map((m, i) => `
      <div class="prob prob--${m}">
        <span class="prob__n">${i + 1}</span>
        <span class="prob__mark" aria-label="${MARK_WORD[m]}">${MARK_GLYPH[m]}</span>
        <span class="prob__rate">${Math.round((r.solveRates[i] ?? 0) * 100)}%</span>
      </div>`).join('');
  const team = `Team ${esc(r.team)}${r.teamName ? ` ${SEP} ${esc(r.teamName)}` : ''}`;
  const legend = ['correct', 'wrong', 'blank', ...(r.marks.includes('unkeyed') ? ['unkeyed'] : [])]
    .map((m) => `<span class="key key--${m}"><i>${MARK_GLYPH[m]}</i>${MARK_WORD[m][0].toUpperCase()}${MARK_WORD[m].slice(1)}</span>`)
    .join('');
  return `
  <section class="page">
    <header class="mast">
      <span class="mast__contest">${esc(contestName)}</span>
      <span class="mast__kind">Individual score report</span>
    </header>
    <div class="who">
      <h1 class="who__name${nameClass(r.name || r.id)}">${esc(r.name || r.id)}</h1>
      <div class="who__meta"><span class="mono">${esc(r.id)}</span><span>Division ${esc(r.division)}</span><span>${team}</span></div>
    </div>
    <div class="tiles">
      ${tile('Score', esc(fmt(r.score)), `/ ${esc(fmt(r.max))}`,
    `${r.correct} correct ${SEP} ${r.wrong} incorrect ${SEP} ${r.blank} blank`, true)}
      ${tile(`Place in Division ${r.division}`, placeValue(r), '', placeSub(r)
        + (r.placedByTiebreak ? ` ${SEP} placed by the tiebreak` : ''))}
      ${tile(`Division ${r.division} median`, esc(fmt(r.stats.median)), '',
      `average ${esc(fmt(Math.round(r.stats.mean * 10) / 10))} ${SEP} top score ${esc(fmt(r.stats.max))}`)}
    </div>
    <section class="block">
      <h2>Problem by problem</h2>
      <div class="probs">${cells}</div>
      <div class="legend">${legend}<span class="legend__note">Percentages: the share of Division ${esc(r.division)} who got each problem right.</span></div>
    </section>
    <section class="block">
      <h2>How Division ${esc(r.division)} scored</h2>
      ${histogramSvg(r.distribution, r.score, { label: `You · ${fmt(r.score)}` })}
      <p class="caption">Each column is the number of contestants in Division ${esc(r.division)} with that score, out of ${r.of}. Yours is highlighted.</p>
    </section>
    ${r.teamResult ? `
    <section class="teamline">
      <span class="teamline__label">Your team</span>
      <span class="teamline__name">${esc(r.teamName || `Team ${r.team}`)} <span class="mono muted">${esc(r.team)}</span></span>
      <span class="teamline__score">Combined score <b>${esc(fmt(r.teamResult.total))}</b><span class="muted"> / ${esc(fmt(r.teamResult.max))}</span></span>
      <span class="teamline__place"><b>${esc(ordinal(r.teamResult.place))}</b> of ${r.teamResult.of} teams${r.teamResult.tiedWith ? ` ${SEP} ${tiedPhrase(r.teamResult.tiedWith)}` : ''}</span>
    </section>` : ''}
    <footer class="foot">
      <span>${r.tiebreaks
    ? 'Equal scores are placed by the tiebreak round.'
    : 'Places are before any tiebreak: equal scores share a place.'}</span>
      <span class="mono">${esc(r.id)}</span>
    </footer>
  </section>`;
}

function teamPage(r, contestName) {
  const rows = r.members.map((m) => `
        <tr>
          <td class="mono">${esc(m.id)}</td>
          <td>${esc(m.name || '—')}</td>
          <td class="num">${esc(fmt(m.score))}</td>
          <td class="num">${m.ranked && m.place ? `${esc(ordinal(m.place))}<span class="muted"> of ${m.of}</span>` : '<span class="muted">not ranked</span>'}</td>
          <td class="counts">${m.counted ? '<span class="pill">Counts</span>' : ''}</td>
        </tr>`).join('');
  const sum = r.counting.map((s) => fmt(s)).join(' + ');
  const sets = r.sets.map((s) => `
        <tr>
          <td>Set ${s.set}</td>
          <td class="muted">${esc(fmt(s.points))} point${Number(s.points) === 1 ? '' : 's'} each</td>
          <td><span class="marks">${s.marks.map((m) => `<span class="mk mk--${m}" aria-label="${MARK_WORD[m]}">${MARK_GLYPH[m]}</span>`).join('')}</span></td>
          <td class="num"><b>${esc(fmt(s.earned))}</b><span class="muted"> / ${esc(fmt(s.possible))}</span></td>
        </tr>`).join('');
  return `
  <section class="page">
    <header class="mast">
      <span class="mast__contest">${esc(contestName)}</span>
      <span class="mast__kind">Team score report</span>
    </header>
    <div class="who">
      <h1 class="who__name${nameClass(r.name || `Team ${r.team}`)}">${esc(r.name || `Team ${r.team}`)}</h1>
      <div class="who__meta"><span class="mono">Team ${esc(r.team)}</span><span>Division ${esc(r.division)}</span></div>
    </div>
    <div class="tiles">
      ${tile('Combined score', esc(fmt(r.total)), `/ ${esc(fmt(r.max))}`,
    `${placeValue(r.places.combined)} ${placeSub(r.places.combined, r.division)}`, true)}
      ${tile('Individual round', esc(fmt(r.individual * r.multiplier)), '',
      `best three ${esc(fmt(r.individual))} × ${esc(fmt(r.multiplier))} ${SEP} ${placeValue(r.places.individual)} of ${r.places.individual.of}`)}
      ${tile('Guts round', esc(fmt(r.guts)), `/ ${esc(fmt(r.gutsMax))}`,
      `${placeValue(r.places.guts)} of ${r.places.guts.of}${r.places.guts.tiedWith ? ` ${SEP} ${tiedPhrase(r.places.guts.tiedWith)}` : ''}`)}
    </div>
    <section class="block">
      <h2>Individual round</h2>
      <table class="tbl">
        <thead><tr><th>ID</th><th>Name</th><th class="num">Score</th><th class="num">Place in Division ${esc(r.division)}</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No individual papers entered.</td></tr>'}</tbody>
      </table>
      <p class="note">The team's individual score is its best three: ${sum ? `${esc(sum)} = ` : ''}${esc(fmt(r.individual))}, counted ${esc(fmt(r.multiplier))} times.</p>
    </section>
    <section class="block">
      <h2>Guts round</h2>
      <table class="tbl tbl--guts">
        <tbody>${sets}</tbody>
      </table>
    </section>
    <section class="block">
      <h2>How Division ${esc(r.division)} teams scored</h2>
      ${stripSvg(r.totals, r.team, r.max, { label: `${r.name || r.team} · ${fmt(r.total)}` })}
      <p class="caption">Each dot is a team's combined score, out of ${esc(fmt(r.max))}. ${r.totals.length} teams; median ${esc(fmt(r.stats.median))}. Yours is highlighted.</p>
    </section>
    <footer class="foot">
      <span>${r.tiebreaks
    ? 'Equal team scores share a place. Members\u2019 places include the individual tiebreak.'
    : 'Places are before any tiebreak: equal scores share a place.'}</span>
      <span class="mono">Team ${esc(r.team)}</span>
    </footer>
  </section>`;
}

const STYLE = `
:root{
  --ink:#16181d; --ink-2:#4d525c; --ink-3:#7d828d;
  --rule:#e2e4e8; --rule-soft:#eef0f3; --paper:#ffffff; --desk:#e9ebef;
  --accent:#2a78d6; --accent-soft:#eaf2fc;
  --good:#0b7a0b; --good-soft:#e6f4e6;
  --bad:#c0342f;  --bad-soft:#fbeaea;
  --blank:#8b909b; --blank-soft:#f1f2f4;
  --bar:#c6cad2;
  --sans:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme: light;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--desk);color:var(--ink);font-family:var(--sans);word-spacing:.05em;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono);letter-spacing:-.01em}
.muted{color:var(--ink-3)}
.sep{display:inline-block;margin:0 .28em;color:var(--ink-3)}

/* The page box fits both Letter and A4 inside half-inch margins. */
@page{margin:0.45in}
.page{width:7.3in;height:9.9in;position:relative;display:flex;flex-direction:column;
  background:var(--paper);overflow:hidden}
.page + .page{break-before:page}
@media screen{
  body{padding:84px 0 40px}
  .page{margin:0 auto 28px;box-shadow:0 1px 2px rgba(16,19,26,.08),0 8px 28px rgba(16,19,26,.10);
    padding:0.45in;width:calc(7.3in + 0.9in);height:calc(9.9in + 0.9in)}
}
@media print{html,body{background:#fff}.bar-tools{display:none!important}}

.mast{display:flex;align-items:baseline;justify-content:space-between;gap:16px;
  padding-bottom:10px;border-bottom:1.5px solid var(--ink)}
.mast__contest{font-size:9.5pt;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
.mast__kind{font-size:9.5pt;color:var(--ink-2);letter-spacing:.04em}

.who{padding:22px 0 18px}
.who__name{margin:0;font-size:27pt;line-height:1.08;font-weight:600;letter-spacing:-.02em}
.who__name--mid{font-size:21pt}
.who__name--long{font-size:16.5pt;line-height:1.15}
.who__meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:10.5pt;color:var(--ink-2)}

.tiles{display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:10px}
.tile{border:1px solid var(--rule);border-radius:8px;padding:12px 14px 11px}
.tile--lead{border-color:transparent;background:var(--accent-soft)}
.tile__label{font-size:8.5pt;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2)}
.tile__value{margin-top:6px;font-size:25pt;font-weight:600;line-height:1;letter-spacing:-.02em}
.tile__of{font-size:12pt;font-weight:500;color:var(--ink-2);margin-left:5px;letter-spacing:0}
.tile__sub{margin-top:7px;font-size:9pt;color:var(--ink-2);line-height:1.35}

.block{margin-top:22px}
.block h2{margin:0 0 10px;font-size:10pt;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink);padding-bottom:6px;border-bottom:1px solid var(--rule)}

.probs{display:grid;grid-template-columns:repeat(10,1fr);gap:6px}
.prob{position:relative;height:0.74in;border-radius:6px;display:flex;flex-direction:column;
  align-items:center;justify-content:center}
.prob__n{position:absolute;top:5px;left:7px;font-size:8pt;font-weight:600;color:var(--ink-2)}
.prob__mark{font-size:19pt;font-weight:700;line-height:1}
.prob__rate{position:absolute;bottom:4px;font-size:7.5pt;color:var(--ink-2);font-variant-numeric:tabular-nums}
.prob--correct{background:var(--good-soft)} .prob--correct .prob__mark{color:var(--good)}
.prob--wrong{background:var(--bad-soft)} .prob--wrong .prob__mark{color:var(--bad)}
.prob--blank,.prob--unkeyed{background:var(--blank-soft)} .prob--blank .prob__mark,.prob--unkeyed .prob__mark{color:var(--blank)}

.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:10px;font-size:8.5pt;color:var(--ink-2)}
.key{display:inline-flex;align-items:center;gap:6px}
.key i{font-style:normal;display:inline-grid;place-items:center;width:17px;height:17px;border-radius:4px;font-weight:700;font-size:10pt}
.key--correct i{background:var(--good-soft);color:var(--good)}
.key--wrong i{background:var(--bad-soft);color:var(--bad)}
.key--blank i,.key--unkeyed i{background:var(--blank-soft);color:var(--blank)}
.legend__note{margin-left:auto}

.chart{display:block;width:100%;height:auto}
.chart .grid{stroke:var(--rule);stroke-width:1}
.chart .grid.base{stroke:#c9cdd4}
.chart .tick{font:500 10px var(--sans);fill:var(--ink-3);font-variant-numeric:tabular-nums}
.chart .tick--mine{fill:var(--ink);font-weight:700}
.chart .bar{fill:var(--bar)}
.chart .bar--mine{fill:var(--accent)}
.chart .callout{font:600 12px var(--sans);fill:var(--ink)}
.chart .dot{fill:var(--bar);stroke:var(--paper);stroke-width:2}
.chart .dot--mine{fill:var(--accent)}
.chart .leader{stroke:var(--ink-3);stroke-width:1}
.caption{margin:6px 0 0;font-size:8.5pt;color:var(--ink-2)}

.tbl{width:100%;border-collapse:collapse;font-size:10pt}
.tbl th{text-align:left;font-size:8.5pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;
  color:var(--ink-2);padding:0 8px 6px;border-bottom:1px solid var(--rule)}
.tbl td{padding:6px 8px;border-bottom:1px solid var(--rule-soft);vertical-align:middle}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl .counts{width:1%;white-space:nowrap;text-align:right}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--accent-soft);color:#1c5aa6;
  font-size:8pt;font-weight:600;letter-spacing:.03em}
.tbl--guts td{padding:4px 8px}
.tbl--guts td:first-child{font-weight:600;width:1%;white-space:nowrap}
.marks{display:inline-flex;gap:5px;vertical-align:middle}
.mk{display:inline-grid;place-items:center;width:24px;height:22px;border-radius:5px;font-weight:700;font-size:11pt}
.mk--correct{background:var(--good-soft);color:var(--good)}
.mk--wrong{background:var(--bad-soft);color:var(--bad)}
.mk--blank,.mk--unkeyed{background:var(--blank-soft);color:var(--blank)}
.note{margin:8px 0 0;font-size:9pt;color:var(--ink-2)}

.teamline{margin-top:20px;display:flex;align-items:baseline;gap:8px 22px;flex-wrap:wrap;
  padding:12px 16px;border:1px solid var(--rule);border-radius:8px;font-size:10pt;color:var(--ink-2)}
.teamline__label{font-size:8.5pt;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2)}
.teamline__name{color:var(--ink);font-weight:600}
.teamline b{color:var(--ink);font-weight:600}
.teamline__place{margin-left:auto}
.foot{margin-top:auto;padding-top:10px;border-top:1px solid var(--rule);display:flex;
  justify-content:space-between;font-size:8pt;color:var(--ink-3)}

/* When a page still runs long -- a name that fills two lines, a team of
   five -- it tightens itself: first the spacing, then the chart. The
   script at the bottom decides, by measuring, before anything prints. */
.page--tight .who{padding:14px 0 12px}
.page--tight .block{margin-top:14px}
.page--tight .teamline{margin-top:12px}
.page--tighter .prob{height:0.6in}
.page--tighter .tbl td{padding-top:4px;padding-bottom:4px}
.bar-tools{position:fixed;inset:0 0 auto 0;z-index:5;display:flex;align-items:center;gap:14px;
  padding:14px 22px;background:rgba(255,255,255,.96);border-bottom:1px solid var(--rule);
  font-size:13px;color:var(--ink-2)}
.bar-tools b{color:var(--ink);font-size:14px}
.bar-tools .spacer{flex:1}
.bar-tools button{font:600 13px var(--sans);border-radius:8px;padding:9px 16px;cursor:pointer;
  border:1px solid var(--rule);background:#fff;color:var(--ink)}
.bar-tools button.go{background:var(--ink);border-color:var(--ink);color:#fff}
.empty{max-width:560px;margin:60px auto;text-align:center;color:var(--ink-2);font-size:15px}
`;

/**
 * The whole printable document. `reports` is a mix of student and team
 * reports in the order they should print.
 */
/**
 * What a printed page has to say for it to be this report, as it is now:
 * who it is for, the score, and the place. Emailing checks each page of a
 * saved PDF against these, so a page never goes to the wrong family and a
 * PDF saved before a score or a tiebreak changed is not sent at all.
 */
export function reportFingerprint(r) {
  if (r.kind === 'team') {
    const p = r.places.combined;
    return [`Team ${r.team}`, r.name || null, `${fmt(r.total)} / ${fmt(r.max)}`,
      p?.place ? `${ordinal(p.place)} of ${p.of}` : null].filter(Boolean);
  }
  return [r.id, r.name || null, `${fmt(r.score)} / ${fmt(r.max)}`,
    r.place ? `${ordinal(r.place)} of ${r.of}` : null].filter(Boolean);
}

export function renderReportsDocument(reports, { contestName = 'Contest', title = 'Score reports' } = {}) {
  const pages = reports.map((r) => (r.kind === 'team' ? teamPage(r, contestName) : studentPage(r, contestName)))
    .join('');
  const count = reports.length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(contestName)} — ${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>${STYLE}</style></head>
<body>
<div class="bar-tools">
  <b>${esc(title)}</b><span>${count} page${count === 1 ? '' : 's'} · one each</span>
  <span class="spacer"></span>
  <span>In the print dialog choose <b>Save as PDF</b> and turn off <b>Headers and footers</b>.</span>
  <button class="go" id="printIt">Print / Save as PDF</button>
</div>
${count ? pages : '<p class="empty">No reports match. Check the division and the IDs typed.</p>'}
<script>
  // Measure every page and tighten any that runs over, so nothing is ever
  // cut off at the foot of a sheet. Again once the fonts have arrived, and
  // again just before printing.
  function fit() {
    document.querySelectorAll('section.page').forEach(function (pg) {
      var over = function () { return pg.scrollHeight > pg.clientHeight + 1; };
      var chart = pg.querySelector('.chart');
      pg.classList.remove('page--tight', 'page--tighter');
      if (chart) chart.style.maxHeight = '';
      if (!over()) return;
      pg.classList.add('page--tight');
      // The chart gives way a tenth of an inch at a time, only as far as needed.
      for (var h = 2.4; chart && over() && h >= 1.0; h -= 0.1) chart.style.maxHeight = h.toFixed(1) + 'in';
      if (over()) pg.classList.add('page--tighter');
    });
  }
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  window.addEventListener('beforeprint', fit);
  document.getElementById('printIt').addEventListener('click', function () {
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
      .then(function () { fit(); window.print(); });
  });
</script>
</body></html>`;
}
