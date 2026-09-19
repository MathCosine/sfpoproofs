// =====================================================================
//  Pure scoring logic for an answer-key contest.
//  No DOM, no network — plain functions over plain data.
// =====================================================================

/**
 * Individual IDs read <division><team><member>, e.g. A011 is Division A,
 * team 01, member 1. Each division numbers its own teams, so A01 and B01
 * are different teams — which is why the team key carries the letter.
 */
const ID_RE = /^([AB])(\d{1,3})([1-9])$/;
const PARTIAL_RE = /^([AB])(\d{0,3})$/;

export function teamKey(division, teamNo) {
  return `${division}${String(teamNo).padStart(2, '0')}`;
}

export function divisionOfTeam(team) {
  const d = String(team ?? '').charAt(0).toUpperCase();
  return d === 'A' || d === 'B' ? d : null;
}

export function teamNumberOf(team) {
  const n = Number(String(team ?? '').slice(1));
  return Number.isFinite(n) ? n : null;
}

/**
 * 'a011' -> { ok, id:'A011', division:'A', team:'A01', teamNo:1, member:'1' }
 * A prefix that is not yet a whole ID comes back as a partial, so the
 * division and team boxes can fill in while somebody is still typing.
 */
export function parseIndividualId(raw) {
  const cleaned = String(raw ?? '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
  const m = ID_RE.exec(cleaned);
  if (m) {
    const [, division, digits, member] = m;
    const teamNo = Number(digits);
    // 'A01' is ambiguous: team 0 member 1, or team 01 still being typed.
    // Team 0 does not exist, so it is the latter.
    if (teamNo >= 1) {
      const team = teamKey(division, teamNo);
      return { ok: true, id: `${team}${member}`, division, team, teamNo, member };
    }
  }
  const partial = PARTIAL_RE.exec(cleaned);
  if (partial) {
    const teamNo = partial[2] ? Number(partial[2]) : null;
    return {
      ok: false,
      partial: true,
      division: partial[1],
      teamNo,
      error: 'Add the member number, like A011.',
    };
  }
  return { ok: false, error: 'Use division, team, member — like A011.' };
}

export function isMemberNumber(raw) {
  return /^[1-9]$/.test(String(raw ?? '').trim());
}

/** A contestant answer: blank, or a non-negative integer. */
export function parseAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, error: 'Whole numbers, zero or more.' };
  return { ok: true, value: Number(text) };
}

/** Guts problem numbers belonging to a set: set 1 -> [1,2,3,4]. */
export function problemsInSet(setNo, cfg) {
  const first = (setNo - 1) * cfg.GUTS_PER_SET + 1;
  return Array.from({ length: cfg.GUTS_PER_SET }, (_, i) => first + i);
}

export function setOfProblem(problem, cfg) {
  return Math.ceil(problem / cfg.GUTS_PER_SET);
}

export function gutsProblemCount(cfg) {
  return cfg.GUTS_SETS * cfg.GUTS_PER_SET;
}

// ---------------------------------------------------------------------
// The answer key
// ---------------------------------------------------------------------

/**
 * The two divisions sit different individual papers, so there are two
 * individual keys. Guts is one paper for everybody and is stored under
 * the division '*'.
 *
 *   { individual: { A: Map, B: Map }, guts: Map }
 */
export const GUTS_DIVISION = '*';

export function indexKey(rows) {
  const key = { individual: { A: new Map(), B: new Map() }, guts: new Map() };
  for (const row of rows) {
    const problem = Number(row.problem);
    const entry = {
      answer: row.answer == null ? null : Number(row.answer),
      points: Number(row.points ?? 1),
    };
    if (row.round === 'guts') key.guts.set(problem, entry);
    else if (key.individual[row.division]) key.individual[row.division].set(problem, entry);
  }
  return key;
}

/** The individual key for one division, or an empty one if unknown. */
export function individualKey(key, division) {
  return key.individual[division] ?? new Map();
}

/**
 * Problems still missing an answer. `division` picks the individual
 * paper; pass GUTS_DIVISION for the guts key.
 */
export function keyGaps(key, round, count, division = 'A') {
  const table = round === 'guts' ? key.guts : individualKey(key, division);
  const missing = [];
  for (let p = 1; p <= count; p += 1) if (table.get(p)?.answer == null) missing.push(p);
  return missing;
}

export function keyMaxPoints(key, round, count, division = 'A') {
  const table = round === 'guts' ? key.guts : individualKey(key, division);
  let total = 0;
  for (let p = 1; p <= count; p += 1) total += table.get(p)?.points ?? 0;
  return total;
}

// ---------------------------------------------------------------------
// Individual round
// ---------------------------------------------------------------------

/**
 * Score one answer sheet. An unset key entry never scores — a blank key
 * must not silently mark every blank answer correct.
 */
export function scoreSheet(answers, key, cfg, division) {
  const table = individualKey(key, division);
  const marks = [];
  let score = 0;
  let answered = 0;
  for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
    const given = answers?.[p - 1] ?? null;
    const entry = table.get(p);
    const expected = entry?.answer ?? null;
    if (given != null) answered += 1;
    let mark = 'blank';
    if (given == null) mark = 'blank';
    else if (expected == null) mark = 'unkeyed';
    else if (given === expected) { mark = 'correct'; score += entry.points; }
    else mark = 'wrong';
    marks.push(mark);
  }
  return { score, answered, marks, correct: marks.filter((m) => m === 'correct').length };
}

export function individualStandings(contestants, key, cfg, dq = new Set()) {
  return contestants
    .map((c) => {
      const result = scoreSheet(c.answers, key, cfg, c.division);
      return {
        individualId: c.individual_id,
        team: String(c.team),
        member: c.member ?? '',
        name: c.name ?? '',
        division: c.division ?? null,
        entered: Array.isArray(c.answers) && c.answers.length > 0,
        enteredBy: c.entered_by_name ?? '',
        // A contestant is out either on their own account or with their
        // team. Both rank the same, but only their own disqualification
        // takes their paper out of the team's best three — a whole team
        // being out must not erase the record of what it scored.
        disqualified: dq.has(String(c.team)) || Boolean(c.disqualified),
        selfDisqualified: Boolean(c.disqualified),
        dqReason: c.disqualified ? (c.dq_reason ?? '') : '',
        ...result,
      };
    })
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.score - a.score
      || a.individualId.localeCompare(b.individualId, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------
// Guts round
// ---------------------------------------------------------------------

/** team -> problem -> answer */
export function indexGutsAnswers(rows) {
  const byTeam = new Map();
  for (const row of rows) {
    const team = String(row.team);
    if (!byTeam.has(team)) byTeam.set(team, new Map());
    byTeam.get(team).set(Number(row.problem), row.answer == null ? null : Number(row.answer));
  }
  return byTeam;
}

export function scoreGutsTeam(answersByProblem, key, cfg) {
  let score = 0;
  let correct = 0;
  let answered = 0;
  const perSet = [];
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    let setScore = 0;
    let setAnswered = 0;
    for (const p of problemsInSet(set, cfg)) {
      const given = answersByProblem?.get(p) ?? null;
      const entry = key.guts.get(p);
      if (given != null) { answered += 1; setAnswered += 1; }
      if (given != null && entry?.answer != null && given === entry.answer) {
        score += entry.points;
        setScore += entry.points;
        correct += 1;
      }
    }
    perSet.push({ set, score: setScore, answered: setAnswered, complete: setAnswered === cfg.GUTS_PER_SET });
  }
  return { score, correct, answered, perSet };
}

export function gutsStandings(teams, gutsByTeam, key, cfg, dq = new Set()) {
  return teams
    .map((t) => {
      const result = scoreGutsTeam(gutsByTeam.get(String(t.team)), key, cfg);
      return {
        team: String(t.team),
        name: t.name ?? '',
        division: t.division ?? divisionOfTeam(t.team),
        disqualified: t.disqualified || dq.has(String(t.team)),
        ...result,
      };
    })
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.score - a.score || a.team.localeCompare(b.team, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------
// Teams and the combined standing
// ---------------------------------------------------------------------

export function dqTeams(teams) {
  return new Set(teams.filter((t) => t.disqualified).map((t) => String(t.team)));
}

/** The ceiling a team is measured against: its best three members, perfect. */
export function individualMaxPoints(key, cfg, division = 'A') {
  return keyMaxPoints(key, 'individual', cfg.INDIVIDUAL_PROBLEMS, division)
    * TEAM_COUNTING_MEMBERS;
}

export function gutsMaxPoints(key, cfg) {
  return keyMaxPoints(key, 'guts', gutsProblemCount(cfg), GUTS_DIVISION);
}

/**
 * Combined = the individual total counted `INDIVIDUAL_MULTIPLIER` times,
 * plus the guts score. Raw points, no normalising: three perfect papers
 * are 60, tripled to 180, against 112 from a perfect guts round.
 */
export const TEAM_COUNTING_MEMBERS = 3;
export const DEFAULT_INDIVIDUAL_MULTIPLIER = 3;

export function individualMultiplier(cfg) {
  const n = Number(cfg?.INDIVIDUAL_MULTIPLIER);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INDIVIDUAL_MULTIPLIER;
}

/** The most a team can score: its best three papers, tripled, plus guts. */
export function combinedMaxPoints(key, cfg, division = 'A') {
  return individualMaxPoints(key, cfg, division) * individualMultiplier(cfg)
    + gutsMaxPoints(key, cfg);
}

export function combinedStandings(individuals, guts, key, cfg, teams = []) {
  const meta = new Map(teams.map((t) => [String(t.team), t]));
  const gutsByTeam = new Map(guts.map((g) => [g.team, g]));

  const gutsMax = gutsMaxPoints(key, cfg);
  const mult = individualMultiplier(cfg);

  const rows = new Map();
  const ensure = (team) => {
    if (!rows.has(team)) {
      const t = meta.get(team);
      rows.set(team, {
        team,
        name: t?.name ?? '',
        division: t?.division ?? divisionOfTeam(team),
        individual: 0,
        members: [],
        guts: gutsByTeam.get(team)?.score ?? null,
        disqualified: Boolean(t?.disqualified),
      });
    }
    return rows.get(team);
  };

  for (const person of individuals) {
    const row = ensure(person.team);
    row.members.push(person);
    if (!row.division) row.division = person.division;
  }
  for (const g of guts) {
    const row = ensure(g.team);
    row.guts = g.score;
    if (!row.division) row.division = g.division;
    if (!row.name) row.name = g.name;
  }

  return [...rows.values()]
    .map((r) => {
      // A team's individual score is its best three of four members, so a
      // team of three is not handicapped and a fourth member can only
      // help. A disqualified contestant is not one of the three: their
      // paper is out of the results, so it cannot carry their team.
      // Everyone is still listed; only the counted ones are summed.
      const eligible = r.members.filter((m) => !m.selfDisqualified);
      const byScore = [...eligible].sort((a, b) => b.score - a.score);
      const counting = new Set(byScore.slice(0, TEAM_COUNTING_MEMBERS).map((m) => m.individualId));
      r.individual = byScore.slice(0, TEAM_COUNTING_MEMBERS)
        .reduce((sum, m) => sum + m.score, 0);
      r.members = r.members
        .map((m) => ({ ...m, counted: counting.has(m.individualId) }))
        .sort((a, b) => a.member.localeCompare(b.member));
      // Each division sits its own paper, so a team is measured against
      // the maximum of the paper it actually took.
      const indMax = individualMaxPoints(key, cfg, r.division);
      const total = r.individual * mult + (r.guts ?? 0);
      return {
        ...r,
        indMax,
        gutsMax,
        multiplier: mult,
        max: indMax * mult + gutsMax,
        total,
        entered: r.members.length,
      };
    })
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.total - a.total || a.team.localeCompare(b.team, undefined, { numeric: true }));
}

export function splitByDivision(rows) {
  return {
    A: rows.filter((r) => r.division === 'A'),
    B: rows.filter((r) => r.division === 'B'),
    unassigned: rows.filter((r) => r.division !== 'A' && r.division !== 'B'),
  };
}

// ---------------------------------------------------------------------
// Live claims
// ---------------------------------------------------------------------

export const claimRef = {
  individual: (individualId) => ({ scope: 'individual', ref: individualId }),
  guts: (team, setNo) => ({ scope: 'guts', ref: `${team}:${setNo}` }),
};

export function liveClaims(claims, cfg, now = Date.now()) {
  const live = new Map();
  for (const c of claims) {
    if (now - new Date(c.claimed_at).getTime() <= cfg.CLAIM_TTL_MS) {
      live.set(`${c.scope}|${c.ref}`, c);
    }
  }
  return live;
}

// ---------------------------------------------------------------------
// The guts clock
// ---------------------------------------------------------------------

/**
 * Seconds left, from whichever of the two stored forms applies. A page
 * that loads mid-round computes the same number as one that has been
 * open the whole time.
 */
export function gutsRemaining(state, now = Date.now()) {
  if (!state) return 0;
  if (state.guts_running && state.guts_ends_at) {
    return Math.max(0, Math.round((new Date(state.guts_ends_at).getTime() - now) / 1000));
  }
  return Math.max(0, Number(state.guts_remaining ?? 0));
}

export function shouldFreeze(state, now = Date.now()) {
  if (!state) return false;
  const remaining = gutsRemaining(state, now);
  return state.guts_running && remaining <= Number(state.freeze_minutes ?? 0) * 60;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Statistics
//
// Everything the problem-setting committee asks for after a contest,
// computed over the contestants who actually sat each division.
// ---------------------------------------------------------------------

/** Population standard deviation — the whole cohort is present, not a sample. */
export function summarise(values) {
  const n = values.length;
  if (!n) {
    return { n: 0, mean: 0, median: 0, stdev: 0, min: 0, max: 0, q1: 0, q3: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const at = (p) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };
  const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    median: at(0.5),
    stdev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    q1: at(0.25),
    q3: at(0.75),
  };
}

/**
 * Per-problem difficulty for one division: how many got each problem
 * right, out of how many attempted the paper at all.
 */
export function problemStats(individuals, division, cfg) {
  const cohort = individuals.filter(
    (p) => p.division === division && p.answered > 0 && !p.disqualified);
  return Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => {
    let correct = 0;
    let answered = 0;
    for (const person of cohort) {
      const mark = person.marks?.[i];
      if (mark === 'correct') { correct += 1; answered += 1; } else if (mark === 'wrong') answered += 1;
    }
    return {
      problem: i + 1,
      correct,
      answered,
      blank: cohort.length - answered,
      pctCorrect: cohort.length ? (correct / cohort.length) * 100 : 0,
    };
  });
}

/** How many contestants scored 0, 1, 2 … out of the paper. */
export function scoreDistribution(individuals, division, cfg, key = null) {
  const cohort = individuals.filter(
    (p) => p.division === division && p.answered > 0 && !p.disqualified);
  const top = key
    ? keyMaxPoints(key, 'individual', cfg.INDIVIDUAL_PROBLEMS, division)
    : cfg.INDIVIDUAL_PROBLEMS;
  const counts = new Array(Math.max(1, top) + 1).fill(0);
  for (const person of cohort) {
    const bucket = Math.max(0, Math.min(counts.length - 1, Math.round(person.score)));
    counts[bucket] += 1;
  }
  return counts.map((count, score) => ({ score, count }));
}

/** Everything above, for one division, in one object. */
export function divisionStatistics(individuals, guts, division, cfg, key = null) {
  const cohort = individuals.filter(
    (p) => p.division === division && p.answered > 0 && !p.disqualified);
  const problems = problemStats(individuals, division, cfg);
  const ranked = [...problems].sort((a, b) => b.correct - a.correct);
  const gutsCohort = guts.filter(
    (g) => g.division === division && g.answered > 0 && !g.disqualified);
  return {
    division,
    contestants: summarise(cohort.map((p) => p.score)),
    guts: summarise(gutsCohort.map((g) => g.score)),
    problems,
    mostSolved: ranked[0] ?? null,
    fewestSolved: ranked[ranked.length - 1] ?? null,
    distribution: scoreDistribution(individuals, division, cfg, key),
  };
}

/** One contestant, in the two lines an award slide wants. */
export function awardLine(person) {
  return `${person.individualId}${person.name ? ` ${person.name}` : ''}\nScore: ${person.score}`;
}

/** One line per awarded contestant, ready to paste onto a slide. */
export function awardLines(individuals, division, count = 10) {
  return individuals
    .filter((p) => p.division === division && !p.disqualified && p.answered > 0)
    .slice(0, count)
    .map((p, i) => ({
      place: i + 1,
      individualId: p.individualId,
      name: p.name,
      score: p.score,
      text: awardLine(p),
    }));
}

// ---------------------------------------------------------------------
// Rosters
//
// Two lists arrive before the contest: who is competing, and who is
// allowed to score. Both are reference data, kept in the database so
// they can be corrected on the morning without a redeploy.
// ---------------------------------------------------------------------

/** Compare names the way a person would: case, spacing and dots aside. */
export function normaliseName(name) {
  return String(name ?? '').toLowerCase().replace(/[.,'’-]/g, '').replace(/\s+/g, ' ').trim();
}

export function parseNameList(text) {
  return String(text ?? '')
    .split(/[\n;,]+/)
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Is this person on the list? An empty list allows everybody, so a
 * contest that has not filled its staff roster in yet is never locked
 * out of its own portal.
 */
export function nameAllowed(list, name) {
  const names = Array.isArray(list) ? list : parseNameList(list);
  if (!names.length) return true;
  const wanted = normaliseName(name);
  return Boolean(wanted) && names.some((n) => normaliseName(n) === wanted);
}

/**
 * Participants pasted from a spreadsheet: one per line, ID first, then
 * the name. Commas, tabs and runs of spaces all separate them, so a
 * copy out of Sheets or a CSV both work without reformatting.
 */
const TEAM_ONLY_RE = /^([AB])(\d{1,3})$/;
const HEADER_WORDS = /^(individual|contestant|student|competitor|participant|id|team|name|division|div|first|last|full\s*name)\b/i;

/**
 * One line into cells. Commas, tabs and semicolons all separate, quotes
 * protect a comma inside a name, and a line with none of those falls back
 * to runs of spaces — so a copy out of Sheets, a CSV, and a hand-typed
 * line all arrive the same way.
 */
export function splitRosterLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') { cur += ch; continue; }
      if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',' || ch === '\t' || ch === ';') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  const trimmed = cells.map((c) => c.trim());
  if (trimmed.filter(Boolean).length > 1) return trimmed;
  // No delimiter found: "A011  Ada Lovelace" or "A011 Ada Lovelace".
  const words = line.trim().split(/\s+/);
  return words.length > 1 ? [words[0], words.slice(1).join(' ')] : trimmed;
}

/**
 * Participants, from whatever shape the list arrives in.
 *
 * The ID is found by trying to parse each cell rather than by trusting a
 * column order, so ID-then-name, name-then-ID, and a spreadsheet with an
 * ID / Team / Name layout all read correctly, with or without a header
 * row and with extra columns in between.
 */
export function parseRoster(text) {
  const rows = [];
  const seen = new Map();
  const problems = [];

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = splitRosterLine(raw).filter((c) => c !== '');
    if (!cells.length) continue;

    let parsed = null;
    let idAt = -1;
    for (let i = 0; i < cells.length; i += 1) {
      const attempt = parseIndividualId(cells[i]);
      if (attempt.ok) { parsed = attempt; idAt = i; break; }
    }
    if (!parsed) {
      // A header row is not a mistake worth reporting; anything else is.
      if (!cells.some((c) => HEADER_WORDS.test(c))) problems.push(raw.trim());
      continue;
    }

    const rest = cells.filter((_, i) => i !== idAt);
    // A column holding the team key is information we already have from
    // the ID — but if it disagrees, that is a typo worth catching.
    let mismatch = null;
    const nameParts = [];
    for (const cell of rest) {
      const team = TEAM_ONLY_RE.exec(cell.toUpperCase().replace(/[\s\-_.]/g, ''));
      if (team) {
        const key = teamKey(team[1], Number(team[2]));
        if (Number(team[2]) >= 1 && key !== parsed.team) mismatch = cell;
        continue;                       // matches, or is being reported
      }
      if (/^[AB]$/i.test(cell)) continue;             // a bare division column
      nameParts.push(cell);
    }
    if (mismatch) {
      problems.push(`${raw.trim()} (says team ${mismatch}, but ${parsed.id} is in ${parsed.team})`);
      continue;
    }

    const name = nameParts.join(' ').trim();
    if (seen.has(parsed.id)) {
      problems.push(`${raw.trim()} (${parsed.id} is already on this list)`);
      continue;
    }
    const row = {
      individual_id: parsed.id,
      name,
      division: parsed.division,
      team: parsed.team,
    };
    seen.set(parsed.id, row);
    rows.push(row);
  }
  return { rows, problems };
}

/** The roster in the order a person reads it: division, team, member. */
export function rosterRows(roster) {
  return [...(roster ?? [])]
    .map((r) => {
      const parsed = parseIndividualId(r.individual_id);
      return {
        individualId: String(r.individual_id),
        name: r.name ?? '',
        team: r.team ?? (parsed.ok ? parsed.team : ''),
        division: r.division ?? (parsed.ok ? parsed.division : ''),
        member: parsed.ok ? parsed.member : '',
      };
    })
    .sort((a, b) => a.individualId.localeCompare(b.individualId, undefined, { numeric: true }));
}

/** Rows whose ID or name contains the search text. */
export function filterRoster(rows, search) {
  const wanted = String(search ?? '').trim().toLowerCase();
  if (!wanted) return rows;
  return rows.filter((r) => r.individualId.toLowerCase().includes(wanted)
    || r.name.toLowerCase().includes(wanted)
    || r.team.toLowerCase().includes(wanted));
}

/** individual_id -> name, for filling the name box as an ID is typed. */
export function indexRoster(rows) {
  return new Map((rows ?? []).map((r) => [String(r.individual_id), r.name ?? '']));
}

// ---------------------------------------------------------------------
// Who has been scoring
//
// The graders table is a live register: a row per person who has signed
// in, refreshed on a heartbeat. This turns it into something an admin can
// act on — who is here, who has gone, and how much each of them keyed.
// ---------------------------------------------------------------------

export function graderActivity(graders, contestants, gutsAnswers, cfg, now = Date.now()) {
  const sheets = new Map();
  for (const c of contestants ?? []) {
    const id = c.entered_by;
    if (id) sheets.set(id, (sheets.get(id) ?? 0) + 1);
  }
  // Guts arrives one answer at a time; a person keyed a *set*, so count
  // the distinct team-and-set pairs rather than the twenty-eight boxes.
  const setsByGrader = new Map();
  for (const g of gutsAnswers ?? []) {
    const id = g.entered_by;
    if (!id) continue;
    if (!setsByGrader.has(id)) setsByGrader.set(id, new Set());
    setsByGrader.get(id).add(`${g.team}:${setOfProblem(Number(g.problem), cfg)}`);
  }
  return (graders ?? [])
    .map((g) => {
      const seen = new Date(g.last_seen).getTime();
      const idle = Number.isFinite(seen) ? now - seen : Infinity;
      return {
        graderId: g.grader_id,
        name: g.name ?? '',
        lastSeen: g.last_seen,
        idleMs: idle,
        online: idle <= cfg.CLAIM_TTL_MS,
        sheets: sheets.get(g.grader_id) ?? 0,
        sets: setsByGrader.get(g.grader_id)?.size ?? 0,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online)
      || a.idleMs - b.idleMs
      || a.name.localeCompare(b.name));
}

/** "just now", "4 min ago", "2 h ago" — enough to tell here from gone. */
export function sinceLabel(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
