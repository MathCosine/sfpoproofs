// =====================================================================
//  Pure scoring logic for an answer-key contest.
//  No DOM, no network — plain functions over plain data.
// =====================================================================

const ID_RE = /^(\d{1,3})\s*([A-Z]?)$/;

/**
 * '12c' -> { ok, id:'12C', team:12, member:'C' }
 * A bare team number is allowed so the entry box can fill the team in
 * before a member letter has been typed.
 */
export function isMemberLetter(raw) {
  return /^[A-Z]$/.test(String(raw ?? '').trim().toUpperCase());
}

export function parseIndividualId(raw) {
  const cleaned = String(raw ?? '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
  const m = ID_RE.exec(cleaned);
  if (!m) return { ok: false, error: 'Use a team number then a member letter, like 12C.' };
  const team = Number(m[1]);
  if (team < 1) return { ok: false, error: 'Team numbers start at 1.' };
  const member = m[2];
  if (!member) {
    return { ok: false, partial: true, team, error: 'Add the member letter, like 12C.' };
  }
  return { ok: true, id: `${team}${member}`, team, member };
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
        team: Number(c.team),
        member: c.member ?? '',
        name: c.name ?? '',
        division: c.division ?? null,
        entered: Array.isArray(c.answers) && c.answers.length > 0,
        enteredBy: c.entered_by_name ?? '',
        disqualified: dq.has(Number(c.team)),
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
    const team = Number(row.team);
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
      const result = scoreGutsTeam(gutsByTeam.get(Number(t.team)), key, cfg);
      return {
        team: Number(t.team),
        name: t.name ?? '',
        division: t.division ?? null,
        disqualified: t.disqualified || dq.has(Number(t.team)),
        ...result,
      };
    })
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.score - a.score || a.team - b.team);
}

// ---------------------------------------------------------------------
// Teams and the combined standing
// ---------------------------------------------------------------------

export function dqTeams(teams) {
  return new Set(teams.filter((t) => t.disqualified).map((t) => Number(t.team)));
}

export function individualMaxPoints(key, cfg, division = 'A') {
  return keyMaxPoints(key, 'individual', cfg.INDIVIDUAL_PROBLEMS, division) * cfg.MEMBERS.length;
}

export function gutsMaxPoints(key, cfg) {
  return keyMaxPoints(key, 'guts', gutsProblemCount(cfg), GUTS_DIVISION);
}

/**
 * Combined = a weighted blend of the two rounds, each taken as a share
 * of its own maximum. The rounds are on different scales (a full team
 * can bank 80 individual points against 70 from guts), so weighting raw
 * points would not give the weights you asked for.
 */
export function combinedStandings(individuals, guts, key, cfg, teams = []) {
  const meta = new Map(teams.map((t) => [Number(t.team), t]));
  const gutsByTeam = new Map(guts.map((g) => [g.team, g]));

  const gutsMax = gutsMaxPoints(key, cfg);
  const wInd = Number(cfg.INDIVIDUAL_WEIGHT);
  const wGuts = Number(cfg.GUTS_WEIGHT);
  const wTotal = wInd + wGuts;

  const rows = new Map();
  const ensure = (team) => {
    if (!rows.has(team)) {
      const t = meta.get(team);
      rows.set(team, {
        team,
        name: t?.name ?? '',
        division: t?.division ?? null,
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
    row.individual += person.score;
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
      r.members.sort((a, b) => a.member.localeCompare(b.member));
      // Each division sits its own paper, so a team is measured against
      // the maximum of the paper it actually took.
      const indMax = individualMaxPoints(key, cfg, r.division);
      const indPct = indMax ? (r.individual / indMax) * 100 : 0;
      const gutsPct = gutsMax && r.guts != null ? (r.guts / gutsMax) * 100 : 0;
      const total = wTotal ? (wInd * indPct + wGuts * gutsPct) / wTotal : 0;
      return {
        ...r,
        indPct,
        gutsPct,
        indMax,
        gutsMax,
        total,
        entered: r.members.length,
      };
    })
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.total - a.total || a.team - b.team);
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
