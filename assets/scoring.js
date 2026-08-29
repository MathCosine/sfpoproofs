// =====================================================================
//  Pure scoring + coverage logic.  No DOM, no network — everything in
//  here is a plain function over plain data, which is what makes the
//  results auditable and the unit tests worth having.
// =====================================================================

const ID_RE = /^(\d{1,3})\s*([A-Z])$/;

/** '  12c ' -> { ok:true, id:'12C', team:12, member:'C' } */
export function parseContestantId(raw) {
  const cleaned = String(raw ?? '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
  const m = ID_RE.exec(cleaned);
  if (!m) return { ok: false, error: 'Use a team number then a member letter, like 12C.' };
  const team = Number(m[1]);
  if (team < 1) return { ok: false, error: 'Team numbers start at 1.' };
  return { ok: true, id: `${team}${m[2]}`, team, member: m[2] };
}

/** 'A2' -> 'A' */
export function divisionOfProblem(problem) {
  return String(problem ?? '').trim().toUpperCase().charAt(0);
}

export function problemsFor(division, cfg) {
  return cfg.PROBLEMS[division] ?? [];
}

export function allProblems(cfg) {
  return [...cfg.PROBLEMS.A, ...cfg.PROBLEMS.B];
}

export function cellKey(contestantId, problem) {
  return `${contestantId}|${problem}`;
}

// ---------------------------------------------------------------------
// Cell state
// ---------------------------------------------------------------------

/**
 * Collapse every read of one (contestant, problem) into the single
 * status the matrix paints.
 *
 * Scoring rule: when a proof has been read twice the MOST RECENT read
 * wins, because the second read exists to settle the first. Both scores
 * stay visible so a conflict is never silently resolved.
 */
export function summariseCell(reads, cfg) {
  if (!reads || reads.length === 0) {
    return { state: 'ungraded', reads: 0, score: null, scores: [], graders: [] };
  }
  const ordered = [...reads].sort(
    (a, b) => new Date(a.updated_at ?? a.created_at) - new Date(b.updated_at ?? b.created_at));
  const scores = ordered.map((r) => Number(r.score));
  const graders = ordered.map((r) => r.grader_name);
  const score = scores[scores.length - 1];
  const spread = Math.max(...scores) - Math.min(...scores);

  let state = 'graded';
  if (ordered.length === 1 && score >= cfg.SECOND_READ_THRESHOLD) state = 'needs-second';
  if (ordered.length > 1 && spread >= cfg.DISAGREEMENT_DELTA) state = 'conflict';

  return {
    state,
    reads: ordered.length,
    score,
    scores,
    graders,
    spread,
    feedback: ordered[ordered.length - 1].feedback ?? '',
    latest: ordered[ordered.length - 1],
  };
}

/** contestantId|problem -> array of reads */
export function indexGrades(grades) {
  const byCell = new Map();
  for (const g of grades) {
    const k = cellKey(g.contestant_id, g.problem);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(g);
  }
  return byCell;
}

/** Claims that have not been refreshed inside the TTL are abandoned. */
export function liveClaims(claims, cfg, now = Date.now()) {
  const live = new Map();
  for (const c of claims) {
    if (now - new Date(c.claimed_at).getTime() <= cfg.CLAIM_TTL_MS) {
      live.set(cellKey(c.contestant_id, c.problem), c);
    }
  }
  return live;
}

// ---------------------------------------------------------------------
// Division bookkeeping
// ---------------------------------------------------------------------

/**
 * Every team's division. A team declares itself the moment one of its
 * proofs is graded (the problem code carries the division), so the
 * explicit teams table only has to cover teams nobody has touched yet.
 */
export function divisionByTeam(grades, teams, guts = []) {
  const div = new Map();
  for (const t of teams) if (t.division) div.set(t.team, t.division);
  for (const g of grades) if (!div.has(g.team)) div.set(g.team, g.division);
  for (const row of guts) if (row.division && !div.has(row.team)) div.set(row.team, row.division);
  return div;
}

/** Team numbers a head grader has disqualified. */
export function dqTeams(teams) {
  return new Set(teams.filter((t) => t.disqualified).map((t) => t.team));
}

/**
 * The most a team could possibly score on proofs in this division:
 * a full roster, every problem, full marks. Small teams are measured
 * against the same ceiling, which keeps this consistent with the team
 * total being the plain sum of its members.
 */
export function proofMaxFor(division, cfg) {
  return cfg.MEMBERS.length * problemsFor(division, cfg).length * cfg.MAX_SCORE;
}

/**
 * The roster we can't be given: every team in range, every member
 * letter, tagged with what we know. Teams with no division yet are
 * returned separately so the UI can ask instead of guessing.
 */
export function buildRoster(cfg, divByTeam, seenContestants, dq = new Set()) {
  const rows = { A: [], B: [], unassigned: [] };
  for (let team = 1; team <= cfg.TEAM_COUNT; team += 1) {
    const division = divByTeam.get(team) ?? null;
    const members = cfg.MEMBERS.map((m) => ({
      contestantId: `${team}${m}`,
      team,
      member: m,
      seen: seenContestants.has(`${team}${m}`),
    }));
    const entry = { team, division, members, disqualified: dq.has(team) };
    if (division === 'A' || division === 'B') rows[division].push(entry);
    else rows.unassigned.push(entry);
  }
  // Teams outside the configured range still deserve a home if someone
  // graded them — better a visible surprise than a silent drop.
  const extra = new Map();
  for (const id of seenContestants) {
    const parsed = parseContestantId(id);
    if (!parsed.ok || parsed.team <= cfg.TEAM_COUNT) continue;
    if (!extra.has(parsed.team)) extra.set(parsed.team, new Set());
    extra.get(parsed.team).add(parsed.member);
  }
  for (const [team, letters] of [...extra].sort((a, b) => a[0] - b[0])) {
    const division = divByTeam.get(team) ?? null;
    const entry = {
      team,
      division,
      beyondRange: true,
      disqualified: dq.has(team),
      members: [...letters].sort().map((m) => ({
        contestantId: `${team}${m}`, team, member: m, seen: true,
      })),
    };
    if (division === 'A' || division === 'B') rows[division].push(entry);
    else rows.unassigned.push(entry);
  }
  return rows;
}

// ---------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------

/** Per-contestant totals for the individual proof round. */
export function individualStandings(grades, divByTeam, cfg, dq = new Set()) {
  const byCell = indexGrades(grades);
  const people = new Map();

  for (const [key, reads] of byCell) {
    const [contestantId, problem] = key.split('|');
    const summary = summariseCell(reads, cfg);
    const parsed = parseContestantId(contestantId);
    const division = divByTeam.get(parsed.ok ? parsed.team : null)
      ?? divisionOfProblem(problem);
    if (!people.has(contestantId)) {
      people.set(contestantId, {
        contestantId,
        team: parsed.ok ? parsed.team : null,
        member: parsed.ok ? parsed.member : '?',
        division,
        disqualified: parsed.ok && dq.has(parsed.team),
        total: 0,
        byProblem: {},
        gradedCount: 0,
        openFlags: 0,
      });
    }
    const person = people.get(contestantId);
    person.total += summary.score;
    person.byProblem[problem] = summary;
    person.gradedCount += 1;
    if (summary.state === 'needs-second' || summary.state === 'conflict') person.openFlags += 1;
  }

  for (const person of people.values()) {
    const expected = problemsFor(person.division, cfg).length;
    person.expected = expected;
    person.complete = expected > 0 && person.gradedCount >= expected;
  }
  // Disqualified contestants keep every score but always sort last, so a
  // ranked list can be read straight down without special-casing.
  return [...people.values()].sort(
    (a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.total - a.total
      || a.contestantId.localeCompare(b.contestantId));
}

/** Team proof score = the sum of its members' individual totals. */
export function teamProofStandings(individuals, divByTeam, cfg, dq = new Set()) {
  const teamsMap = new Map();
  for (const person of individuals) {
    if (person.team == null) continue;
    if (!teamsMap.has(person.team)) {
      teamsMap.set(person.team, {
        team: person.team,
        division: divByTeam.get(person.team) ?? person.division,
        disqualified: dq.has(person.team),
        proof: 0,
        members: [],
        complete: true,
        openFlags: 0,
      });
    }
    const t = teamsMap.get(person.team);
    t.proof += person.total;
    t.members.push(person);
    t.openFlags += person.openFlags;
    if (!person.complete) t.complete = false;
  }
  for (const t of teamsMap.values()) {
    t.members.sort((a, b) => a.member.localeCompare(b.member));
  }
  return [...teamsMap.values()].sort(
    (a, b) => Number(a.disqualified) - Number(b.disqualified)
      || b.proof - a.proof || a.team - b.team);
}

export function gutsStandings(guts, divByTeam) {
  return [...guts]
    .map((row) => ({
      team: row.team,
      score: Number(row.score),
      division: divByTeam.get(row.team) ?? null,
    }))
    .sort((a, b) => b.score - a.score || a.team - b.team);
}

/**
 * Combined standing = a weighted blend of proof and guts.
 *
 * The weights are applied to each side's PERCENTAGE of its own maximum,
 * never to the raw points. That distinction matters: a Division B team
 * can score 140 on proofs where Division A tops out at 84, and guts is
 * on a third scale entirely — so weighting raw points would hand guts a
 * different real share in each division (roughly 18% in B against 26% in
 * A for the same nominal "20%"). Normalising first makes 80/20 mean 80/20
 * everywhere.
 *
 *   proofPct = team proof / (members x problems x max score)
 *   gutsPct  = team guts  / gutsMax
 *   combined = 100 x (Wp x proofPct + Wg x gutsPct) / (Wp + Wg)
 *
 * gutsMax comes from cfg.GUTS_MAX, or the highest guts score present when
 * that is 0 — which makes the top guts team the 100% reference.
 *
 * A team that has one half but not the other still ranks, flagged, so a
 * missing guts import is obvious rather than quietly scored as zero.
 * Disqualified teams keep every point and always sort last.
 */
export function combinedStandings(teamProof, guts, divByTeam, cfg, dq = new Set()) {
  const gutsByTeam = new Map(guts.map((g) => [g.team, Number(g.score)]));
  const observedMax = gutsByTeam.size ? Math.max(...gutsByTeam.values()) : 0;
  const gutsMax = Number(cfg?.GUTS_MAX) > 0 ? Number(cfg.GUTS_MAX) : observedMax;

  const wProof = Number(cfg?.PROOF_WEIGHT ?? 80);
  const wGuts = Number(cfg?.GUTS_WEIGHT ?? 20);
  const wTotal = wProof + wGuts;

  const rows = new Map();
  for (const t of teamProof) {
    rows.set(t.team, {
      team: t.team,
      division: t.division ?? divByTeam.get(t.team) ?? null,
      proof: t.proof,
      guts: gutsByTeam.get(t.team) ?? null,
      hasProof: true,
      complete: t.complete,
      openFlags: t.openFlags,
      members: t.members,
      disqualified: t.disqualified || dq.has(t.team),
    });
  }
  for (const [team, score] of gutsByTeam) {
    if (rows.has(team)) continue;
    rows.set(team, {
      team,
      division: divByTeam.get(team) ?? null,
      proof: 0,
      guts: score,
      hasProof: false,
      complete: false,
      openFlags: 0,
      members: [],
      disqualified: dq.has(team),
    });
  }

  return [...rows.values()]
    .map((r) => {
      const proofMax = r.division ? proofMaxFor(r.division, cfg) : 0;
      const proofPct = proofMax ? r.proof / proofMax : 0;
      const gutsPct = gutsMax && r.guts != null ? r.guts / gutsMax : 0;
      const total = wTotal ? ((wProof * proofPct + wGuts * gutsPct) / wTotal) * 100 : 0;

      let status = 'final';
      if (r.disqualified) status = 'disqualified';
      else if (!r.hasProof) status = 'guts only';
      else if (r.guts == null) status = 'awaiting guts';
      else if (!r.complete) status = 'grading';

      return {
        ...r,
        proofPct: proofPct * 100,
        gutsPct: gutsPct * 100,
        proofMax,
        gutsMax,
        total,
        raw: r.proof + (r.guts ?? 0),
        status,
        partial: status !== 'final' && status !== 'disqualified',
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
// What should I grade next?
// ---------------------------------------------------------------------

/**
 * Ranked queue of cells worth opening, best first. The ordering is the
 * whole point of the panel:
 *
 *   1. conflicts        — two reads that disagree, someone must settle it
 *   2. second reads     — a high score seen by only one grader
 *   3. finish a person  — they already have a read, close out the rest
 *   4. everything else  — untouched slots, lowest team number first
 *
 * Cells another grader currently holds are never suggested, and a cell
 * you have already read yourself is never suggested back to you.
 */
export function suggestQueue({ roster, byCell, claims, cfg, myGraderId, limit = 12 }) {
  const out = [];
  const touchedByPerson = new Map();

  for (const [key, reads] of byCell) {
    const [contestantId] = key.split('|');
    touchedByPerson.set(contestantId, (touchedByPerson.get(contestantId) ?? 0) + reads.length);
  }

  const consider = (entry, member) => {
    const division = entry.division;
    if (division !== 'A' && division !== 'B') return;
    // Grading a disqualified team's remaining proofs is wasted effort.
    if (entry.disqualified) return;
    for (const problem of problemsFor(division, cfg)) {
      const key = cellKey(member.contestantId, problem);
      const claim = claims.get(key);
      if (claim && claim.grader_id !== myGraderId) continue;

      const reads = byCell.get(key) ?? [];
      const summary = summariseCell(reads, cfg);
      const mine = reads.some((r) => r.grader_id === myGraderId);

      let priority = null;
      let reason = '';
      if (summary.state === 'conflict' && !mine) {
        priority = 0; reason = `two reads ${summary.scores.join(' vs ')} — settle it`;
      } else if (summary.state === 'needs-second' && !mine) {
        priority = 1; reason = `scored ${summary.score} — needs a second read`;
      } else if (summary.state === 'ungraded' && (touchedByPerson.get(member.contestantId) ?? 0) > 0) {
        priority = 2; reason = 'finish this contestant';
      } else if (summary.state === 'ungraded' && member.seen) {
        priority = 3; reason = 'not graded yet';
      } else if (summary.state === 'ungraded') {
        priority = 4; reason = 'not graded yet';
      }
      if (priority === null) continue;
      out.push({
        contestantId: member.contestantId,
        problem,
        division,
        priority,
        reason,
        score: summary.score,
      });
    }
  };

  for (const division of ['A', 'B']) {
    for (const entry of roster[division]) for (const member of entry.members) consider(entry, member);
  }

  out.sort((a, b) => a.priority - b.priority
    || a.contestantId.localeCompare(b.contestantId, undefined, { numeric: true })
    || a.problem.localeCompare(b.problem));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------

/** Coverage for one division, counting only contestants we have seen. */
export function progressFor(division, roster, byCell, cfg) {
  const problems = problemsFor(division, cfg);
  let expected = 0; let done = 0; let flagged = 0;
  for (const entry of roster[division]) {
    if (entry.disqualified) continue;
    for (const member of entry.members) {
      if (!member.seen) continue;
      for (const problem of problems) {
        expected += 1;
        const summary = summariseCell(byCell.get(cellKey(member.contestantId, problem)), cfg);
        if (summary.state !== 'ungraded') done += 1;
        if (summary.state === 'needs-second' || summary.state === 'conflict') flagged += 1;
      }
    }
  }
  return { expected, done, flagged, pct: expected ? Math.round((done / expected) * 100) : 0 };
}
