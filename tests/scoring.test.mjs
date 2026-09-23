// Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIndividualId, parseAnswer, problemsInSet, setOfProblem, gutsProblemCount,
  indexKey, keyGaps, keyMaxPoints, scoreSheet, individualStandings, indexGutsAnswers,
  individualKey, GUTS_DIVISION, teamKey, divisionOfTeam, teamNumberOf, isMemberNumber,
  summarise, problemStats, scoreDistribution, divisionStatistics, awardLines,
  competitionRanks, ordinal,
  TEAM_COUNTING_MEMBERS,
  scoreGutsTeam, gutsStandings, combinedStandings, combinedMaxPoints, splitByDivision, dqTeams,
  liveClaims, claimRef, gutsRemaining, shouldFreeze, formatClock,
  individualMaxPoints, gutsMaxPoints,
  awardLine, nameAllowed, parseNameList, parseRoster, indexRoster,
  graderActivity, sinceLabel, rosterRows, filterRoster,
} from '../assets/scoring.js';
import { applyPatch } from '../assets/store.js';
import { parseCsv, toCsv } from '../assets/csv.js';

const cfg = {
  INDIVIDUAL_PROBLEMS: 20,
  INDIVIDUAL_POINTS: 1,
  GUTS_SETS: 7,
  GUTS_PER_SET: 4,
  INDIVIDUAL_MULTIPLIER: 3,
  MEMBERS: ['1', '2', '3', '4'],
  DIVISIONS: ['A', 'B'],
  CLAIM_TTL_MS: 120000,
};

/**
 * Division A's individual problem n has answer n; Division B's has n+100
 * — deliberately disjoint, so a sheet marked against the wrong paper
 * scores zero rather than accidentally matching.
 * Guts problem n has answer n*2 and is the same paper for both.
 */
const fullKey = () => {
  const rows = [];
  for (let p = 1; p <= 20; p += 1) {
    rows.push({ round: 'individual', division: 'A', problem: p, answer: p, points: 1 });
    rows.push({ round: 'individual', division: 'B', problem: p, answer: p + 100, points: 1 });
  }
  for (let p = 1; p <= 28; p += 1) {
    rows.push({ round: 'guts', division: '*', problem: p, answer: p * 2, points: Math.ceil(p / 4) });
  }
  return indexKey(rows);
};

// ---------------------------------------------------------------------
test('individual IDs split into division, team and member', () => {
  const p = parseIndividualId('A011');
  assert.equal(p.ok, true);
  assert.equal(p.id, 'A011');
  assert.equal(p.division, 'A');
  assert.equal(p.team, 'A01');
  assert.equal(p.teamNo, 1);
  assert.equal(p.member, '1');
});

test('IDs are case- and whitespace-forgiving', () => {
  assert.equal(parseIndividualId(' b124 ').id, 'B124');
  assert.equal(parseIndividualId('b-12-4').team, 'B12');
});

test('each division numbers its own teams', () => {
  assert.notEqual(parseIndividualId('A011').team, parseIndividualId('B011').team);
  assert.equal(teamKey('A', 1), 'A01');
  assert.equal(teamKey('B', 12), 'B12');
  assert.equal(divisionOfTeam('B07'), 'B');
  assert.equal(teamNumberOf('B07'), 7);
});

test('a three-digit team still parses', () => {
  const p = parseIndividualId('A1004');
  assert.equal(p.team, 'A100');
  assert.equal(p.member, '4');
});

test('a partial ID fills what it can while you type', () => {
  const p = parseIndividualId('A01');
  assert.equal(p.ok, false);
  assert.equal(p.partial, true);
  assert.equal(p.division, 'A');
  assert.equal(p.teamNo, 1);
});

test('nonsense IDs are rejected', () => {
  assert.equal(parseIndividualId('C011').ok, false);
  assert.equal(parseIndividualId('12C').ok, false);
  assert.equal(parseIndividualId('A000').ok, false, 'team 0 does not exist');
  assert.equal(parseIndividualId('A010').ok, false, 'member 0 does not exist');
});

test('member numbers are 1 to 9', () => {
  assert.equal(isMemberNumber('1'), true);
  assert.equal(isMemberNumber('4'), true);
  assert.equal(isMemberNumber('0'), false);
  assert.equal(isMemberNumber('A'), false);
});

test('answers are blank or non-negative integers', () => {
  assert.deepEqual(parseAnswer(''), { ok: true, value: null });
  assert.deepEqual(parseAnswer('  '), { ok: true, value: null });
  assert.deepEqual(parseAnswer('0'), { ok: true, value: 0 });
  assert.deepEqual(parseAnswer('42'), { ok: true, value: 42 });
  assert.equal(parseAnswer('-3').ok, false);
  assert.equal(parseAnswer('3.5').ok, false);
  assert.equal(parseAnswer('twelve').ok, false);
});

test('guts sets map to problem numbers', () => {
  assert.deepEqual(problemsInSet(1, cfg), [1, 2, 3, 4]);
  assert.deepEqual(problemsInSet(7, cfg), [25, 26, 27, 28]);
  assert.equal(setOfProblem(5, cfg), 2);
  assert.equal(setOfProblem(28, cfg), 7);
  assert.equal(gutsProblemCount(cfg), 28);
});

// ---------------------------------------------------------------------
test('a perfect sheet scores every point', () => {
  const answers = Array.from({ length: 20 }, (_, i) => i + 1);
  const out = scoreSheet(answers, fullKey(), cfg, 'A');
  assert.equal(out.score, 20);
  assert.equal(out.correct, 20);
  assert.equal(out.answered, 20);
});

test('wrong and blank both score zero, and are told apart', () => {
  const answers = [1, 999, null, 4, ...Array(16).fill(null)];
  const out = scoreSheet(answers, fullKey(), cfg, 'A');
  assert.equal(out.score, 2);
  assert.equal(out.answered, 3);
  assert.deepEqual(out.marks.slice(0, 4), ['correct', 'wrong', 'blank', 'correct']);
});

test('zero is a real answer, not a blank', () => {
  const key = indexKey([{ round: 'individual', division: 'A', problem: 1, answer: 0, points: 1 }]);
  const out = scoreSheet([0], key, { ...cfg, INDIVIDUAL_PROBLEMS: 1 }, 'A');
  assert.equal(out.score, 1);
  assert.equal(out.answered, 1);
  assert.equal(out.marks[0], 'correct');
});

test('an unset key entry never marks anybody right or wrong', () => {
  const key = indexKey([{ round: 'individual', division: 'A', problem: 1, answer: null, points: 1 }]);
  const out = scoreSheet([7], key, { ...cfg, INDIVIDUAL_PROBLEMS: 1 }, 'A');
  assert.equal(out.score, 0);
  assert.equal(out.marks[0], 'unkeyed', 'the box is flagged, not silently counted');
});

test('an empty key scores nothing rather than everything', () => {
  const out = scoreSheet(Array.from({ length: 20 }, (_, i) => i + 1), indexKey([]), cfg, 'A');
  assert.equal(out.score, 0);
  assert.ok(out.marks.every((m) => m === 'unkeyed'));
});

test('keyGaps names the problems still missing an answer', () => {
  const key = indexKey([
    { round: 'individual', division: 'A', problem: 1, answer: 5, points: 1 },
    { round: 'individual', division: 'A', problem: 3, answer: null, points: 1 },
  ]);
  assert.deepEqual(keyGaps(key, 'individual', 4, 'A'), [2, 3, 4]);
  assert.deepEqual(keyGaps(key, 'individual', 4, 'B'), [1, 2, 3, 4],
    'Division B has its own paper and its own gaps');
});

// ---------------------------------------------------------------------
test('guts points rise with the set', () => {
  const key = fullKey();
  const answers = new Map();
  for (const p of problemsInSet(1, cfg)) answers.set(p, p * 2);   // set 1: 1 pt each
  const first = scoreGutsTeam(answers, key, cfg);
  assert.equal(first.score, 4);

  const late = new Map();
  for (const p of problemsInSet(7, cfg)) late.set(p, p * 2);      // set 7: 7 pts each
  assert.equal(scoreGutsTeam(late, key, cfg).score, 28);
});

test('a guts set knows whether it is finished', () => {
  const answers = new Map([[1, 2], [2, 4]]);
  const out = scoreGutsTeam(answers, fullKey(), cfg);
  assert.equal(out.perSet[0].answered, 2);
  assert.equal(out.perSet[0].complete, false);
  assert.equal(out.perSet[1].answered, 0);
});

test('guts standings rank on points and keep the team name', () => {
  const key = fullKey();
  const rows = [
    { team: 'A01', problem: 25, answer: 50 },   // set 7, 7 points
    { team: 'A02', problem: 1, answer: 2 },     // set 1, 1 point
    { team: 'A02', problem: 2, answer: 4 },
  ];
  const board = gutsStandings(
    [{ team: 'A01', name: 'Cowbell', division: 'A' }, { team: 'A02', name: 'Moo Point', division: 'A' }],
    indexGutsAnswers(rows), key, cfg);
  assert.deepEqual(board.map((r) => r.team), ['A01', 'A02']);
  assert.equal(board[0].score, 7);
  assert.equal(board[0].name, 'Cowbell');
  assert.equal(board[1].score, 2);
});

// ---------------------------------------------------------------------
test('combined is the individual total tripled, plus guts', () => {
  const key = fullKey();
  assert.equal(individualMaxPoints(key, cfg, 'A'), 20 * TEAM_COUNTING_MEMBERS,
    'the best three members of twenty points each');
  assert.equal(gutsMaxPoints(key, cfg), 4 * (1 + 2 + 3 + 4 + 5 + 6 + 7));
  assert.equal(combinedMaxPoints(key, cfg, 'A'), 60 * 3 + 112);

  const individuals = [
    { individualId: '1A', team: 'A01', member: 'A', division: 'A', score: 20, disqualified: false },
    { individualId: '1B', team: 'A01', member: 'B', division: 'A', score: 20, disqualified: false },
    { individualId: '1C', team: 'A01', member: 'C', division: 'A', score: 20, disqualified: false },
    { individualId: '1D', team: 'A01', member: 'D', division: 'A', score: 20, disqualified: false },
  ];
  const guts = [{ team: 'A01', name: 'Cowbell', division: 'A', score: gutsMaxPoints(key, cfg), disqualified: false }];
  const [row] = combinedStandings(individuals, guts, key, cfg,
    [{ team: 'A01', division: 'A', name: 'Cowbell' }]);
  assert.equal(row.individual, 60, 'best three of four perfect papers');
  assert.equal(row.total, 60 * 3 + 112);
  assert.equal(row.max, 292);
  assert.equal(row.multiplier, 3);
});

test('each round contributes its raw points, nothing scaled', () => {
  const key = fullKey();
  const perfectIndividual = ['1', '2', '3', '4'].map((m) => ({
    individualId: `1${m}`, team: 'A01', member: m, division: 'A', score: 20, disqualified: false,
  }));
  const noGuts = combinedStandings(perfectIndividual, [{ team: 'A01', division: 'A', score: 0 }],
    key, cfg, [{ team: 'A01', division: 'A' }]);
  assert.equal(noGuts[0].total, 180, 'three perfect papers, tripled');

  const onlyGuts = combinedStandings([], [{ team: 'A01', division: 'A', score: gutsMaxPoints(key, cfg) }],
    key, cfg, [{ team: 'A01', division: 'A' }]);
  assert.equal(onlyGuts[0].total, 112, 'guts counts once, at face value');

  // The multiplier is a setting, not a constant in the code.
  const doubled = combinedStandings(perfectIndividual, [], key,
    { ...cfg, INDIVIDUAL_MULTIPLIER: 2 }, [{ team: 'A01', division: 'A' }]);
  assert.equal(doubled[0].total, 120);
});

test('a disqualified team keeps its points but sorts last', () => {
  const key = fullKey();
  const individuals = [
    { individualId: '1A', team: 'A01', member: 'A', division: 'A', score: 20, disqualified: true },
    { individualId: '2A', team: 'A02', member: 'A', division: 'A', score: 5, disqualified: false },
  ];
  const rows = combinedStandings(individuals, [], key, cfg,
    [{ team: 'A01', division: 'A', disqualified: true }, { team: 'A02', division: 'A' }]);
  assert.deepEqual(rows.map((r) => r.team), ['A02', 'A01']);
  assert.equal(rows.find((r) => r.team === 'A01').individual, 20, 'nothing was erased');
  assert.equal(rows.find((r) => r.team === 'A01').total, 60);
});

test('individual standings inherit their team disqualification', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: 'A', division: 'A', answers: [1, 2], name: 'Ada' },
    { individual_id: 'A021', team: 'A02', member: 'A', division: 'A', answers: [1], name: 'Bo' },
  ], key, cfg, dqTeams([{ team: 'A01', disqualified: true }]));
  assert.deepEqual(people.map((p) => p.individualId), ['A021', 'A011']);
  assert.equal(people.find((p) => p.individualId === 'A011').disqualified, true);
  assert.equal(people.find((p) => p.individualId === 'A011').score, 2, 'score is kept');
});

test('splitByDivision keeps teams with no division out of both', () => {
  const out = splitByDivision([{ division: 'A' }, { division: 'B' }, { division: null }]);
  assert.equal(out.A.length, 1);
  assert.equal(out.B.length, 1);
  assert.equal(out.unassigned.length, 1);
});

// ---------------------------------------------------------------------
test('claims key individual sheets and guts sets apart', () => {
  assert.deepEqual(claimRef.individual('12C'), { scope: 'individual', ref: '12C' });
  assert.deepEqual(claimRef.guts(12, 3), { scope: 'guts', ref: '12:3' });
});

test('stale claims stop counting as live', () => {
  const now = Date.parse('2026-08-29T10:00:00Z');
  const live = liveClaims([
    { scope: 'individual', ref: '1A', claimed_at: '2026-08-29T09:59:30Z' },
    { scope: 'guts', ref: '2:1', claimed_at: '2026-08-29T09:50:00Z' },
  ], cfg, now);
  assert.equal(live.size, 1);
  assert.ok(live.has('individual|1A'));
});

// ---------------------------------------------------------------------
test('the clock reads the same whether running or paused', () => {
  const now = Date.parse('2026-08-29T13:00:00Z');
  const running = {
    guts_running: true,
    guts_ends_at: '2026-08-29T13:30:00Z',
    guts_remaining: 0,
  };
  assert.equal(gutsRemaining(running, now), 1800);

  const paused = { guts_running: false, guts_remaining: 900 };
  assert.equal(gutsRemaining(paused, now), 900);
});

test('the clock never goes negative', () => {
  const now = Date.parse('2026-08-29T13:00:00Z');
  assert.equal(gutsRemaining(
    { guts_running: true, guts_ends_at: '2026-08-29T12:00:00Z' }, now), 0);
});

test('the freeze engages inside the threshold, and only while running', () => {
  const now = Date.parse('2026-08-29T13:00:00Z');
  const at = (minutes) => ({
    guts_running: true,
    guts_ends_at: new Date(now + minutes * 60000).toISOString(),
    freeze_minutes: 10,
  });
  assert.equal(shouldFreeze(at(11), now), false);
  assert.equal(shouldFreeze(at(10), now), true);
  assert.equal(shouldFreeze(at(2), now), true);
  assert.equal(shouldFreeze({ ...at(2), guts_running: false }, now), false,
    'a paused clock is not a freeze');
});

test('the clock formats as mm:ss', () => {
  assert.equal(formatClock(4500), '75:00');
  assert.equal(formatClock(65), '01:05');
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(-5), '00:00');
});

// ---------------------------------------------------------------------
// Incremental realtime — the thing that keeps the free tier alive
// ---------------------------------------------------------------------

const base = () => ({
  settings: null, state: null, key: [], teams: [],
  contestants: [], gutsAnswers: [], claims: [], graders: [],
});

test('an inserted row lands in the cache', () => {
  const next = applyPatch(base(), 'contestants',
    { eventType: 'INSERT', new: { individual_id: 'A011', team: 1 } });
  assert.equal(next.contestants.length, 1);
});

test('an updated row replaces the one already there, not appended', () => {
  let cache = applyPatch(base(), 'contestants',
    { eventType: 'INSERT', new: { individual_id: 'A011', team: 'A01', name: 'Ada' } });
  cache = applyPatch(cache, 'contestants',
    { eventType: 'UPDATE', new: { individual_id: 'A011', team: 'A01', name: 'Ada L' } });
  assert.equal(cache.contestants.length, 1);
  assert.equal(cache.contestants[0].name, 'Ada L');
});

test('a deleted row leaves', () => {
  let cache = applyPatch(base(), 'claims',
    { eventType: 'INSERT', new: { scope: 'guts', ref: '1:2' } });
  cache = applyPatch(cache, 'claims',
    { eventType: 'DELETE', old: { scope: 'guts', ref: '1:2' } });
  assert.equal(cache.claims.length, 0);
});

test('composite keys do not collide', () => {
  let cache = applyPatch(base(), 'guts_answers',
    { eventType: 'INSERT', new: { team: 'A01', problem: 1, answer: 5 } });
  cache = applyPatch(cache, 'guts_answers',
    { eventType: 'INSERT', new: { team: 'A01', problem: 2, answer: 6 } });
  cache = applyPatch(cache, 'guts_answers',
    { eventType: 'INSERT', new: { team: 'A02', problem: 1, answer: 7 } });
  assert.equal(cache.gutsAnswers.length, 3);
  cache = applyPatch(cache, 'guts_answers',
    { eventType: 'UPDATE', new: { team: 'A01', problem: 2, answer: 99 } });
  assert.equal(cache.gutsAnswers.length, 3);
  assert.equal(cache.gutsAnswers.find((g) => g.team === 'A01' && g.problem === 2).answer, 99);
});

test('single-row tables are replaced rather than collected', () => {
  let cache = applyPatch(base(), 'contest_state',
    { eventType: 'UPDATE', new: { id: 1, guts_running: true } });
  assert.equal(cache.state.guts_running, true);
  cache = applyPatch(cache, 'contest_state',
    { eventType: 'UPDATE', new: { id: 1, guts_running: false } });
  assert.equal(cache.state.guts_running, false);
});

test('an unknown table is ignored rather than corrupting the cache', () => {
  const cache = base();
  assert.equal(applyPatch(cache, 'nope', { eventType: 'INSERT', new: {} }), cache);
});

// ---------------------------------------------------------------------
test('CSV round-trips through the exporter', () => {
  const csv = toCsv(['a', 'b'], [['x,1', 'y"2']]);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[1], ['x,1', 'y"2']);
});

// ---------------------------------------------------------------------
// Lock contention — what actually decides whether ten scorers can work
// at once. Postgres is the thing that makes this safe (the claim's
// primary key), so these drive the real Supabase code path against a
// stand-in client rather than the localStorage demo store.
// ---------------------------------------------------------------------

import { supabaseBackend } from '../assets/store.js';

/**
 * A stand-in for supabase-js holding one `claims` table in memory, with
 * PostgREST's behaviour on the parts that matter: a duplicate insert
 * raises 23505, and an update only touches rows matching every filter.
 */
function fakeClient(rows = []) {
  // Clone, or an update in one test mutates the fixture the next one uses.
  const claims = rows.map((r) => ({ ...r }));
  const calls = { insert: 0, update: 0 };

  const builder = (op, payload) => {
    const filters = [];
    const api = {
      eq(col, value) { filters.push((r) => String(r[col]) === String(value)); return api; },
      lt(col, value) { filters.push((r) => new Date(r[col]) < new Date(value)); return api; },
      select() { return api.then ? api : api; },
      maybeSingle() { return api; },
      then(resolve) {
        const match = claims.filter((r) => filters.every((f) => f(r)));
        if (op === 'insert') {
          calls.insert += 1;
          const clash = claims.some(
            (r) => r.scope === payload.scope && r.ref === payload.ref);
          if (clash) return resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
          claims.push({ ...payload });
          return resolve({ data: [payload], error: null });
        }
        if (op === 'update') {
          calls.update += 1;
          for (const row of match) Object.assign(row, payload);
          return resolve({ data: match, error: null });
        }
        return resolve({ data: match[0] ?? null, error: null });
      },
    };
    return api;
  };

  return {
    claims,
    calls,
    auth: { getSession: async () => ({ data: { session: {} } }) },
    from() {
      return {
        insert: (payload) => builder('insert', payload),
        update: (payload) => builder('update', payload),
        select: () => builder('select'),
      };
    },
  };
}

const scorer = (n) => ({ id: `g${n}`, name: `Scorer ${n}` });

test('an unheld sheet is claimed on the first try', async () => {
  const client = fakeClient();
  const store = supabaseBackend(cfg, client);
  const out = await store.claim('individual', '12C', scorer(1), 120000);
  assert.deepEqual(out, { ok: true });
  assert.equal(client.claims.length, 1);
});

test('ten scorers on ten different sheets all get their lock', async () => {
  const client = fakeClient();
  const store = supabaseBackend(cfg, client);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.claim('individual', `${i + 1}A`, scorer(i), 120000)));
  assert.ok(results.every((r) => r.ok), 'nobody is turned away for somebody else’s sheet');
  assert.equal(client.claims.length, 10);
});

test('ten scorers racing for ONE sheet: exactly one wins', async () => {
  const client = fakeClient();
  const store = supabaseBackend(cfg, client);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.claim('individual', '12C', scorer(i), 120000)));
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'the primary key decides, not whoever clicked last');
  assert.equal(client.claims.length, 1);
  for (const loser of results.filter((r) => !r.ok)) {
    assert.equal(loser.heldBy.grader_id, 'g0', 'and the losers are told who has it');
  }
});

test('refreshing your own claim is not a takeover', async () => {
  const client = fakeClient();
  const store = supabaseBackend(cfg, client);
  await store.claim('guts', '4:2', scorer(1), 120000);
  const again = await store.claim('guts', '4:2', scorer(1), 120000);
  assert.deepEqual(again, { ok: true });
  assert.equal(client.claims.length, 1);
  assert.equal(client.claims[0].grader_id, 'g1');
});

test('an abandoned claim can be taken over, a live one cannot', async () => {
  const stale = {
    scope: 'individual', ref: '9B', grader_id: 'gone', grader_name: 'Gone Home',
    claimed_at: new Date(Date.now() - 10 * 60000).toISOString(),
  };
  const takeover = await supabaseBackend(cfg, fakeClient([stale]))
    .claim('individual', '9B', scorer(2), 120000);
  assert.equal(takeover.ok, true, 'a laptop closed ten minutes ago does not hold a sheet forever');

  const live = { ...stale, claimed_at: new Date().toISOString() };
  const refused = await supabaseBackend(cfg, fakeClient([live]))
    .claim('individual', '9B', scorer(2), 120000);
  assert.equal(refused.ok, false);
  assert.equal(refused.heldBy.grader_name, 'Gone Home');
});

// ---------------------------------------------------------------------
// The two divisions sit different individual papers
// ---------------------------------------------------------------------

test('each division has its own individual key, guts is shared', () => {
  const key = fullKey();
  assert.equal(individualKey(key, 'A').get(3).answer, 3);
  assert.equal(individualKey(key, 'B').get(3).answer, 103);
  assert.equal(key.guts.get(3).answer, 6, 'guts is one paper for everybody');
  assert.equal(individualKey(key, 'Z').size, 0, 'an unknown division scores nothing');
});

test('a sheet is marked against its own division’s paper', () => {
  const key = fullKey();
  const sheet = Array.from({ length: 20 }, (_, i) => i + 1);   // the A answers

  const asA = scoreSheet(sheet, key, cfg, 'A');
  assert.equal(asA.score, 20, 'perfect on the paper it was sat');

  const asB = scoreSheet(sheet, key, cfg, 'B');
  assert.equal(asB.score, 0, 'the same answers score nothing on the other paper');
  assert.ok(asB.marks.every((m) => m === 'wrong'));
});

test('a contestant with no division yet scores nothing rather than guessing', () => {
  const out = scoreSheet([1, 2, 3], fullKey(), cfg, null);
  assert.equal(out.score, 0);
  assert.equal(out.marks[0], 'unkeyed', 'flagged, not silently marked wrong');
});

test('standings score each contestant against their own paper', () => {
  const key = fullKey();
  const sheetA = Array.from({ length: 20 }, (_, i) => i + 1);
  const sheetB = Array.from({ length: 20 }, (_, i) => i + 101);
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: sheetA },
    { individual_id: 'B021', team: 'B02', member: '1', division: 'B', answers: sheetB },
  ], key, cfg);
  assert.equal(people.find((p) => p.individualId === 'A011').score, 20);
  assert.equal(people.find((p) => p.individualId === 'B021').score, 20,
    'Division B is perfect on its own paper too');
});

test('a team is measured against the maximum of the paper it sat', () => {
  // Make the papers different sizes: B only has 10 keyed problems.
  const rows = [];
  for (let p = 1; p <= 20; p += 1) {
    rows.push({ round: 'individual', division: 'A', problem: p, answer: p, points: 1 });
    if (p <= 10) rows.push({ round: 'individual', division: 'B', problem: p, answer: p, points: 1 });
  }
  const key = indexKey(rows);
  assert.equal(individualMaxPoints(key, cfg, 'A'), 60);
  assert.equal(individualMaxPoints(key, cfg, 'B'), 30, 'three counted members of ten points');

  const perfectB = ['1', '2', '3', '4'].map((m) => ({
    individualId: `1${m}`, team: 'A01', member: m, division: 'B', score: 10, disqualified: false,
  }));
  const [row] = combinedStandings(perfectB, [], key, cfg, [{ team: 'A01', division: 'B' }]);
  assert.equal(row.individual, 30, 'three counted members of the ten-problem B paper');
  assert.equal(row.indMax, 30, 'measured against the paper it sat, not the A one');
  assert.equal(row.total, 90);
});

test('CSV export neutralises spreadsheet formulas', () => {
  // A team name is free text, and Excel executes a cell starting with =.
  const csv = toCsv(['team', 'name'], [
    ['1', '=HYPERLINK("http://evil","click")'],
    ['2', '+1+1'],
    ['3', '@SUM(A1:A9)'],
    ['4', '-2'],
    ['5', 'Cowbell'],
  ]);
  const rows = parseCsv(csv);
  assert.ok(rows[1][1].startsWith("'="), 'a formula is quoted into text');
  assert.ok(rows[2][1].startsWith("'+"));
  assert.ok(rows[3][1].startsWith("'@"));
  assert.ok(rows[4][1].startsWith("'-"));
  assert.equal(rows[5][1], 'Cowbell', 'an ordinary name is untouched');
});

test('CSV still round-trips commas and quotes', () => {
  const rows = parseCsv(toCsv(['a', 'b'], [['x,1', 'y"2']]));
  assert.deepEqual(rows[1], ['x,1', 'y"2']);
});

// ---------------------------------------------------------------------
// Reading a whole table, not the first page of it
// ---------------------------------------------------------------------

import { fetchAllPages, isMissingTable } from '../assets/store.js';

/** A stand-in that behaves like Supabase: it will not return more than cap rows. */
function pagedTable(total, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  let calls = 0;
  const makeQuery = () => ({
    range(from, to) {
      calls += 1;
      const size = Math.min(to - from + 1, cap);
      return Promise.resolve({ data: rows.slice(from, from + size), error: null });
    },
  });
  return { makeQuery, calls: () => calls };
}

test('a table larger than one page is read in full', () => {
  // guts_answers is 2800 rows at a hundred teams; a plain select would
  // have returned 1000 of them with no error and no way to notice.
  const t = pagedTable(2800);
  return fetchAllPages(t.makeQuery).then((rows) => {
    assert.equal(rows.length, 2800);
    assert.equal(t.calls(), 3, 'three pages of a thousand');
    assert.deepEqual(rows.at(-1), { id: 2799 });
  });
});

test('a short table is read in one request', async () => {
  const t = pagedTable(68);
  assert.equal((await fetchAllPages(t.makeQuery)).length, 68);
  assert.equal(t.calls(), 1);
});

test('an exactly-full page still checks for a next one', async () => {
  const t = pagedTable(1000);
  assert.equal((await fetchAllPages(t.makeQuery)).length, 1000);
  assert.equal(t.calls(), 2, 'a full page is indistinguishable from a truncated one');
});

test('an empty table is fine', async () => {
  const t = pagedTable(0);
  assert.deepEqual(await fetchAllPages(t.makeQuery), []);
});

test('a read error is raised, not silently returned short', async () => {
  const failing = () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
  await assert.rejects(() => fetchAllPages(failing), /boom/);
});

// ---------------------------------------------------------------------
// A team scores its best three of four
// ---------------------------------------------------------------------

const member = (team, m, score, division = 'A') => ({
  individualId: `${team}${m}`, team, member: String(m), division, score, disqualified: false,
});

test('a team counts its best three members, not all four', () => {
  const key = fullKey();
  const people = [member('A01', 1, 20), member('A01', 2, 15),
    member('A01', 3, 10), member('A01', 4, 1)];
  const [row] = combinedStandings(people, [], key, cfg, [{ team: 'A01', division: 'A' }]);
  assert.equal(row.individual, 45, '20 + 15 + 10, the weakest is dropped');
  assert.equal(row.members.length, 4, 'but everyone is still listed');
});

test('the counted members are marked so the breakdown can show them', () => {
  const key = fullKey();
  const people = [member('A01', 1, 5), member('A01', 2, 20),
    member('A01', 3, 12), member('A01', 4, 9)];
  const [row] = combinedStandings(people, [], key, cfg, [{ team: 'A01', division: 'A' }]);
  const counted = row.members.filter((m) => m.counted).map((m) => m.member).sort();
  assert.deepEqual(counted, ['2', '3', '4'], 'the 5 is the one dropped');
  assert.equal(row.individual, 41);
});

test('a team of three is not handicapped', () => {
  const key = fullKey();
  const three = [member('A01', 1, 20), member('A01', 2, 20), member('A01', 3, 20)];
  const four = [...three, member('A01', 4, 0)];
  const a = combinedStandings(three, [], key, cfg, [{ team: 'A01', division: 'A' }])[0];
  const b = combinedStandings(four, [], key, cfg, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(a.individual, 60);
  assert.equal(a.total, b.total, 'a fourth member who scores nothing changes nothing');
  assert.equal(a.indMax, 60, 'three perfect members is a perfect team score');
  assert.equal(a.total, 180, 'sixty points, tripled');
});

test('a short team and an over-full one both score their best three', () => {
  // No-shows and spares are both ordinary on the day. A team of one is
  // not scaled up to look like a team of three, and a fifth member does
  // not sneak a fourth paper into the total.
  const key = fullKey();
  const team = [{ team: 'A01', division: 'A' }];
  const total = (n) => combinedStandings(
    Array.from({ length: n }, (_, i) => member('A01', i + 1, 20)),
    [], key, cfg, team)[0].total;
  assert.equal(total(1), 60, 'one perfect paper, tripled');
  assert.equal(total(2), 120);
  assert.equal(total(3), 180);
  assert.equal(total(4), 180, 'the fourth is dropped');
  assert.equal(total(5), 180, 'and so is the fifth');
});

test('a fourth member can only help', () => {
  const key = fullKey();
  const weak = [member('A01', 1, 10), member('A01', 2, 10), member('A01', 3, 10)];
  const withStar = [...weak, member('A01', 4, 20)];
  const before = combinedStandings(weak, [], key, cfg, [{ team: 'A01', division: 'A' }])[0];
  const after = combinedStandings(withStar, [], key, cfg, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(before.individual, 30);
  assert.equal(after.individual, 40, 'the new best score replaces the lowest counted one');
});

// ---------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------

test('summarise computes the usual figures', () => {
  const s = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.n, 8);
  assert.equal(s.mean, 5);
  assert.equal(s.median, 4.5);
  assert.equal(s.stdev, 2, 'population standard deviation');
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
});

test('summarise handles one value and none at all', () => {
  assert.deepEqual(summarise([7]).median, 7);
  assert.equal(summarise([7]).stdev, 0);
  assert.equal(summarise([]).n, 0);
});

test('per-problem stats count correct, wrong and blank apart', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 999, null] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 2, null] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  const stats = problemStats(people, 'A', { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  assert.deepEqual(
    stats.map((p) => [p.problem, p.correct, p.blank]),
    [[1, 2, 0], [2, 1, 0], [3, 0, 2]]);
  assert.equal(stats[0].pctCorrect, 100);
});

test('the distribution buckets contestants by score', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 99, 99] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  const dist = scoreDistribution(people, 'A', { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  assert.equal(dist.find((d) => d.score === 3).count, 1);
  assert.equal(dist.find((d) => d.score === 1).count, 1);
  assert.equal(dist.reduce((a, d) => a + d.count, 0), 2);
});

test('division statistics name the easiest and hardest problem', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 99] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 99, 99] },
  ], key, small);
  const st = divisionStatistics(people, [], 'A', small);
  assert.equal(st.mostSolved.problem, 1);
  assert.equal(st.fewestSolved.problem, 3);
  assert.equal(st.contestants.n, 2);
});

test('statistics ignore contestants who have not been entered', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [] },
  ], key, small);
  assert.equal(divisionStatistics(people, [], 'A', small).contestants.n, 1);
});

// ---------------------------------------------------------------------
// Award lines
// ---------------------------------------------------------------------

test('award lines are shaped for a slide', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A',
      name: 'Ada Lovelace', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A',
      name: '', answers: [1, 2, 99] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  const lines = awardLines(people, 'A', 10);
  assert.equal(lines[0].text, 'A011 Ada Lovelace\nScore: 3');
  assert.equal(lines[1].text, 'A012\nScore: 2', 'a missing name leaves no trailing space');
  assert.equal(lines.length, 2);
});

test('award lines skip contestants who sat nothing', () => {
  // A roster row can exist before anyone keys the paper. Placing an
  // unentered contestant tenth would put a blank award on the slide.
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [] },
    { individual_id: 'A013', team: 'A01', member: '3', division: 'A', answers: null },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  assert.deepEqual(awardLines(people, 'A', 10).map((l) => l.individualId), ['A011']);
});

test('the awards list can carry its places, and a tie says so twice', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A',
      name: 'Ada Lovelace', answers: [1, 2, 3] },
    { individual_id: 'A021', team: 'A02', member: '1', division: 'A',
      name: 'Grace Hopper', answers: [1, 2, 3] },
    { individual_id: 'A031', team: 'A03', member: '1', division: 'A',
      name: '', answers: [1, 2, 99] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });

  const plain = awardLines(people, 'A', 10);
  assert.equal(plain[0].text, 'A011 Ada Lovelace\nScore: 3', 'off by default');

  const placed = awardLines(people, 'A', 10, { withPlaces: true });
  assert.deepEqual(placed.map((l) => l.text.split('\n')[0]), [
    '1st · A011 Ada Lovelace',
    '1st · A021 Grace Hopper',
    '3rd · A031',
  ], 'two firsts, then a third, and no trailing space on a missing name');
});

test('ordinals read the way a person says them', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
});

test('the roster index takes rows in either shape', () => {
  // Straight from the database it is individual_id; after rosterRows()
  // it is individualId. One underscore apart, and getting it wrong
  // builds a map of "undefined" that fills in nothing and says nothing.
  const fromDb = [{ individual_id: 'A011', name: 'Ada Lovelace' }];
  const fromRows = rosterRows(fromDb);
  assert.equal(indexRoster(fromDb).get('A011'), 'Ada Lovelace');
  assert.equal(indexRoster(fromRows).get('A011'), 'Ada Lovelace');
  assert.equal(indexRoster([{ name: 'No Id' }]).size, 0, 'a row with no ID is dropped');
  assert.equal(indexRoster(null).size, 0);
});

test('tied contestants share a place, and the next one skips', () => {
  // Marked out of twenty with a few hundred papers in the room, a tie at
  // the top is the normal case, not a rare one. Counting down the rows
  // would print one of two equal firsts as second, which is the wrong
  // medal handed to a real child.
  const r = (scores) => competitionRanks(scores.map((score) => ({ score })));
  assert.deepEqual(r([20, 18, 18, 17, 12]), [1, 2, 2, 4, 5]);
  assert.deepEqual(r([9, 9, 9]), [1, 1, 1], 'three-way tie is three firsts');
  assert.deepEqual(r([10, 9, 8, 8]), [1, 2, 3, 3], 'a tie at the bottom still shares');
  assert.deepEqual(r([5, 4, 3]), [1, 2, 3]);
  assert.deepEqual(r([7]), [1]);
  assert.deepEqual(r([]), []);
});

test('places can be read off any value, not just the score', () => {
  const rows = [{ total: 180 }, { total: 180 }, { total: 120 }];
  assert.deepEqual(competitionRanks(rows, (x) => x.total), [1, 1, 3]);
});

test('award places are shared by a tie and worked out before the cut', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A021', team: 'A02', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A031', team: 'A03', member: '1', division: 'A', answers: [1, 2, 99] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 });
  assert.deepEqual(awardLines(people, 'A', 10).map((l) => l.place), [1, 1, 3],
    'two firsts and no second');
  // Cutting the list must not renumber what is left of it.
  assert.deepEqual(awardLines(people, 'A', 2).map((l) => l.place), [1, 1]);
});

test('the distribution spans the points the key actually awards', () => {
  // Two points a problem puts a perfect paper at 6, not 3. Clamping to
  // the problem count piled everyone above it into the last bucket.
  const key = indexKey([
    { round: 'individual', division: 'A', problem: 1, answer: 1, points: 2 },
    { round: 'individual', division: 'A', problem: 2, answer: 2, points: 2 },
    { round: 'individual', division: 'A', problem: 3, answer: 3, points: 2 },
  ]);
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 9, 9] },
  ], key, small);
  const dist = scoreDistribution(people, 'A', small, key);
  assert.equal(dist.length, 7, 'scores 0 through 6');
  assert.equal(dist[6].count, 1, 'the perfect paper sits at 6');
  assert.equal(dist[2].count, 1);
});

test('award lines skip disqualified contestants and respect the count', () => {
  const key = fullKey();
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A021', team: 'A02', member: '1', division: 'A', answers: [1, 2, 3] },
  ], key, { ...cfg, INDIVIDUAL_PROBLEMS: 3 }, new Set(['A01']));
  const lines = awardLines(people, 'A', 10);
  assert.deepEqual(lines.map((l) => l.individualId), ['A021']);
  assert.equal(awardLines(people, 'A', 0).length, 0);
});

// ---------------------------------------------------------------------
// Team shapes that turn up on the day
// ---------------------------------------------------------------------

test('a short team is not handicapped by the best-three rule', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const make = (n) => Array.from({ length: n }, (_, i) => ({
    individual_id: `A01${i + 1}`, team: 'A01', member: String(i + 1),
    division: 'A', answers: [1, 2, 3],
  }));
  const total = (n) => {
    const people = individualStandings(make(n), key, small);
    return combinedStandings(people, [], key, small, [{ team: 'A01', division: 'A' }])[0];
  };
  assert.equal(total(1).individual, 3, 'one member scores their own paper');
  assert.equal(total(2).individual, 6);
  assert.equal(total(3).individual, 9);
  assert.equal(total(4).individual, 9, 'the fourth paper cannot add to a perfect three');
  // The ceiling is three perfect papers either way, so a short team is
  // measured against the same bar and is not quietly punished.
  assert.equal(total(2).indMax, total(4).indMax);
  assert.equal(total(3).total, 27, 'nine points, tripled');
});

test('the weakest of four is the one dropped, and it is marked', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 2, 9] },
    { individual_id: 'A013', team: 'A01', member: '3', division: 'A', answers: [1, 9, 9] },
    { individual_id: 'A014', team: 'A01', member: '4', division: 'A', answers: [9, 9, 9] },
  ], key, small);
  const row = combinedStandings(people, [], key, small, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(row.individual, 3 + 2 + 1);
  assert.deepEqual(row.members.map((m) => m.counted), [true, true, true, false]);
  assert.deepEqual(row.members.map((m) => m.member), ['1', '2', '3', '4'],
    'members stay listed in team order, not score order');
});

test('a tie for the third place keeps exactly three counting', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A013', team: 'A01', member: '3', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A014', team: 'A01', member: '4', division: 'A', answers: [1, 2, 3] },
  ], key, small);
  const row = combinedStandings(people, [], key, small, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(row.individual, 9);
  assert.equal(row.members.filter((m) => m.counted).length, 3);
});

test('statistics survive a division nobody has entered', () => {
  const key = fullKey();
  const st = divisionStatistics([], [], 'B', cfg, key);
  assert.equal(st.contestants.n, 0);
  assert.equal(st.contestants.mean, 0);
  assert.equal(st.contestants.stdev, 0);
  assert.equal(st.problems.length, cfg.INDIVIDUAL_PROBLEMS);
  assert.equal(st.mostSolved.correct, 0);
  assert.ok(st.distribution.every((d) => d.count === 0));
});

// ---------------------------------------------------------------------
// Credentials from the address bar
// ---------------------------------------------------------------------

test('the portal refuses Supabase credentials from the URL', async () => {
  const { resolvedConfig, CONFIG } = await import('../assets/config.js');
  const hostile = '?url=https://attacker.example.co&key=attacker-key';

  // The portal asks for a password. A link carrying someone else's
  // project would render the ordinary sign-in screen and post that
  // password to whoever sent the link, so the address bar is ignored.
  const portal = resolvedConfig(hostile);
  assert.equal(portal.SUPABASE_URL, CONFIG.SUPABASE_URL);
  assert.equal(portal.SUPABASE_ANON_KEY, CONFIG.SUPABASE_ANON_KEY);
  assert.equal(portal.FROM_ADDRESS_BAR, false);

  // The public board has no password to give away, so a projector may
  // still be pointed at a project by link — and it says so on screen.
  const board = resolvedConfig(hostile, { allowUrlParams: true });
  assert.equal(board.SUPABASE_URL, 'https://attacker.example.co');
  assert.equal(board.SUPABASE_ANON_KEY, 'attacker-key');
  assert.equal(board.FROM_ADDRESS_BAR, true);

  assert.equal(resolvedConfig('', { allowUrlParams: true }).FROM_ADDRESS_BAR, false);
});

// ---------------------------------------------------------------------
// Disqualifying one contestant
// ---------------------------------------------------------------------

test('a disqualified contestant stops counting towards their team', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const rows = [
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A012', team: 'A01', member: '2', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A013', team: 'A01', member: '3', division: 'A', answers: [1, 2, 3] },
    { individual_id: 'A014', team: 'A01', member: '4', division: 'A', answers: [1, 2, 9] },
  ];
  const clean = combinedStandings(
    individualStandings(rows, key, small), [], key, small, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(clean.individual, 9, 'best three of four perfect-ish papers');

  // Take one of the three out. The fourth paper moves up into its place.
  const out = rows.map((r) => (r.individual_id === 'A011'
    ? { ...r, disqualified: true, dq_reason: 'Phone on the desk' } : r));
  const after = combinedStandings(
    individualStandings(out, key, small), [], key, small, [{ team: 'A01', division: 'A' }])[0];
  assert.equal(after.individual, 3 + 3 + 2, 'the fourth member is counted instead');
  assert.equal(after.total, 8 * 3);
  assert.equal(after.members.find((m) => m.individualId === 'A011').counted, false);
  assert.equal(after.members.find((m) => m.individualId === 'A014').counted, true);
});

test('a disqualified contestant drops out of the rankings and the awards', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings([
    { individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3],
      disqualified: true, dq_reason: 'Phone on the desk' },
    { individual_id: 'A021', team: 'A02', member: '1', division: 'A', answers: [1, 2, 9] },
  ], key, small);
  assert.deepEqual(people.map((p) => p.individualId), ['A021', 'A011'], 'sorted last');
  assert.equal(people[1].dqReason, 'Phone on the desk');
  assert.deepEqual(awardLines(people, 'A', 10).map((l) => l.individualId), ['A021']);
  assert.equal(divisionStatistics(people, [], 'A', small, key).contestants.n, 1,
    'and out of the statistics');
});

test('disqualifying the whole team does not erase what it scored', () => {
  const key = fullKey();
  const small = { ...cfg, INDIVIDUAL_PROBLEMS: 3 };
  const people = individualStandings(
    [{ individual_id: 'A011', team: 'A01', member: '1', division: 'A', answers: [1, 2, 3] }],
    key, small, new Set(['A01']));
  assert.equal(people[0].disqualified, true);
  assert.equal(people[0].selfDisqualified, false, 'out with the team, not on their own account');
  const row = combinedStandings(people, [], key, small,
    [{ team: 'A01', division: 'A', disqualified: true }])[0];
  assert.equal(row.individual, 3, 'the record still shows what they scored');
});

// ---------------------------------------------------------------------
// The two rosters
// ---------------------------------------------------------------------

test('a participant list reads whichever column holds the ID', () => {
  const { rows, problems } = parseRoster([
    'Individual ID,Team,Name',                  // a header row is not an error
    'A011,A01,Ada Lovelace',                    // id, team, name
    'A012,Grace Hopper',                        // id, name
    'Mary Jackson,B1004',                       // name, id
    'B021;A;Katherine Johnson',                 // semicolons, a division column
    'B022\tB02\tDorothy Vaughan',               // tabs
    'B023,"Vaughan, Dorothy"',                  // a comma inside a quoted name
  ].join('\n'));
  assert.deepEqual(rows.map((r) => r.individual_id),
    ['A011', 'A012', 'B1004', 'B021', 'B022', 'B023']);
  assert.deepEqual(rows.map((r) => r.name), [
    'Ada Lovelace', 'Grace Hopper', 'Mary Jackson',
    'Katherine Johnson', 'Dorothy Vaughan', 'Vaughan, Dorothy',
  ]);
  assert.deepEqual(problems, [], 'nothing above is a mistake');
  assert.equal(rows[2].team, 'B100', 'the team always comes from the ID');
});

test('a team column that disagrees with the ID is caught, not quietly dropped', () => {
  const { rows, problems } = parseRoster('A011,A09,Ada Lovelace');
  assert.deepEqual(rows, []);
  assert.match(problems[0], /A011 is in A01/);
});

test('the roster sorts and searches the way somebody looking for a person would', () => {
  const rows = rosterRows([
    { individual_id: 'B021', name: 'Katherine Johnson' },
    { individual_id: 'A012', name: 'Grace Hopper' },
    { individual_id: 'A011', name: 'Ada Lovelace' },
  ]);
  assert.deepEqual(rows.map((r) => r.individualId), ['A011', 'A012', 'B021']);
  assert.equal(rows[0].team, 'A01', 'the team is derived when the row has none stored');
  assert.deepEqual(filterRoster(rows, 'hopper').map((r) => r.individualId), ['A012']);
  assert.deepEqual(filterRoster(rows, 'b02').map((r) => r.individualId), ['B021'],
    'by team as well as by name');
  assert.deepEqual(filterRoster(rows, 'A01').map((r) => r.individualId), ['A011', 'A012']);
  assert.equal(filterRoster(rows, '  ').length, 3, 'a blank search hides nobody');
});

test('a participant list is read from whatever the spreadsheet gave you', () => {
  const { rows, problems } = parseRoster([
    'A011, Ada Lovelace',
    'A012\tGrace Hopper',
    'B021   Katherine Johnson',
    '  b1004 ,  Mary Jackson  ',
    '',
    'not an id at all',
    'A011, someone else',
  ].join('\n'));
  // b1004 is Division B, team 100, member 4 — three-digit teams still read.
  assert.deepEqual(rows.map((r) => r.individual_id), ['A011', 'A012', 'B021', 'B1004']);
  assert.deepEqual(rows.map((r) => r.name),
    ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson', 'Mary Jackson']);
  assert.equal(rows[0].team, 'A01');
  assert.equal(rows[3].division, 'B');
  assert.equal(rows[3].team, 'B100');
  assert.equal(problems.length, 2, 'the junk line and the duplicate are reported, not silent');
});

test('a roster entry with no name is allowed', () => {
  const { rows } = parseRoster('A011\nA012, ');
  assert.deepEqual(rows.map((r) => r.name), ['', '']);
  assert.equal(indexRoster(rows).get('A011'), '');
});

test('sign-in names are matched the way a person writes them', () => {
  const admins = 'Thomas Ni\nRyan Wang\nLusen Yao';
  assert.equal(nameAllowed(admins, 'Thomas Ni'), true);
  assert.equal(nameAllowed(admins, '  thomas   ni '), true, 'case and spacing forgiven');
  assert.equal(nameAllowed(admins, "Lusen O'Yao"), false);
  assert.equal(nameAllowed(admins, 'Xu Shao'), false);
  assert.equal(nameAllowed(admins, ''), false, 'a blank name is never on a list');
  assert.deepEqual(parseNameList('Xu Shao, CCMathClub\nAnother One'),
    ['Xu Shao', 'CCMathClub', 'Another One']);
});

test('an empty list lets anybody in, so a half-set-up contest is not locked out', () => {
  assert.equal(nameAllowed('', 'Anyone At All'), true);
  assert.equal(nameAllowed('   \n  ', 'Anyone At All'), true);
  assert.equal(nameAllowed([], 'Anyone At All'), true);
});

// ---------------------------------------------------------------------
// The scorer register
// ---------------------------------------------------------------------

test('the register says who is here and how much each of them keyed', () => {
  const now = Date.UTC(2026, 8, 19, 12, 0, 0);
  const ago = (ms) => new Date(now - ms).toISOString();
  const rows = graderActivity(
    [
      { grader_id: 'g-left', name: 'Gone Home', last_seen: ago(45 * 60000) },
      { grader_id: 'g-here', name: 'Xu Shao', last_seen: ago(4000) },
      { grader_id: 'g-idle', name: 'On A Break', last_seen: ago(5 * 60000) },
    ],
    [
      { entered_by: 'g-here' }, { entered_by: 'g-here' }, { entered_by: 'g-left' },
      { entered_by: '' }, { },
    ],
    [
      // Four answers of one set, then one of another: two sets, not five.
      { entered_by: 'g-here', team: 'A01', problem: 1 },
      { entered_by: 'g-here', team: 'A01', problem: 2 },
      { entered_by: 'g-here', team: 'A01', problem: 3 },
      { entered_by: 'g-here', team: 'A01', problem: 4 },
      { entered_by: 'g-here', team: 'A01', problem: 5 },
    ],
    cfg, now);

  assert.deepEqual(rows.map((r) => r.graderId), ['g-here', 'g-idle', 'g-left'],
    'here first, then by how long they have been quiet');
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].sheets, 2, 'rows with no scorer on them are not counted');
  assert.equal(rows[0].sets, 2, 'a set is one set however many answers it took');
  assert.equal(rows[2].online, false);
  assert.equal(rows[2].sheets, 1);
  assert.equal(rows[2].sets, 0);
});

test('the register copes with an empty contest', () => {
  assert.deepEqual(graderActivity([], [], [], cfg), []);
  assert.deepEqual(graderActivity(null, null, null, cfg), []);
  const [only] = graderActivity(
    [{ grader_id: 'g1', name: 'Solo', last_seen: 'not a date' }], [], [], cfg);
  assert.equal(only.online, false, 'an unreadable timestamp reads as gone, not as here');
  assert.equal(only.sheets, 0);
});

test('how long ago reads the way a person would say it', () => {
  assert.equal(sinceLabel(3000), 'just now');
  assert.equal(sinceLabel(4 * 60000), '4 min ago');
  assert.equal(sinceLabel(2 * 3600000), '2 h ago');
  assert.equal(sinceLabel(50 * 3600000), '2 d ago');
  assert.equal(sinceLabel(Infinity), 'never');
});

// ---------------------------------------------------------------------
// Saving must not re-download the contest
// ---------------------------------------------------------------------

test('a save patches the cache instead of pulling every table back down', async () => {
  // Refreshing after each write meant ten round trips and the whole
  // contest after every saved sheet, which is what made the portal drag.
  let selects = 0;
  const query = () => {
    const self = {
      select() { selects += 1; return self; },
      eq() { return self; },
      neq() { return self; },
      range() { return self; },
      order() { return self; },
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
      then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return self;
  };
  const client = {
    from: () => query(),
    channel: () => ({ on() { return this; }, subscribe() {} }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);

  await store.load();
  assert.ok(selects >= 8, `a full load reads every table — saw ${selects}`);

  selects = 0;
  await store.saveContestant({ individual_id: 'A011', team: 'A01', answers: [] });
  store.patchLocal('contestants', { individual_id: 'A011', team: 'A01', answers: [] });
  assert.ok(selects <= 1, `a sheet save should read at most one table, read ${selects}`);

  selects = 0;
  await store.saveRoster([{ individual_id: 'A011', name: 'Ada Lovelace' }]);
  const cache = store.patchLocal('roster', { individual_id: 'A011', name: 'Ada Lovelace' });
  assert.equal(selects, 0, 'a roster edit should read nothing back');
  assert.equal(cache.roster.find((r) => r.individual_id === 'A011')?.name, 'Ada Lovelace',
    'and the screen sees the change immediately');
});

test('a local patch removes a row as well as adding one', () => {
  const client = {
    from: () => ({}),
    channel: () => ({ on() { return this; }, subscribe() {} }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);
  store.patchLocal('roster', { individual_id: 'A011', name: 'Ada' });
  store.patchLocal('roster', { individual_id: 'A012', name: 'Grace' });
  const after = store.patchLocal('roster', { individual_id: 'A011' }, 'DELETE');
  assert.deepEqual(after.roster.map((r) => r.individual_id), ['A012']);
});

// ---------------------------------------------------------------------
// A database that is one schema run behind
// ---------------------------------------------------------------------

test('a table the schema has not added yet does not take the portal down', async () => {
  // The roster table arrived in a later schema run. Until somebody runs
  // it, every other table still has to load — otherwise the whole portal
  // is dead on a database that is one step behind.
  const query = (table) => {
    const self = {
      select() { return self; },
      eq() { return self; },
      order() { return self; },
      range: async () => (table === 'roster'
        ? { data: null,
          error: { code: 'PGRST205', message: "Could not find the table 'public.roster'" } }
        : { data: [{ id: 1 }], error: null }),
      maybeSingle: async () => ({ data: { id: 1 }, error: null }),
    };
    return self;
  };
  const client = {
    from: (t) => query(t),
    channel: () => ({ on() { return this; }, subscribe() {} }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);

  const snapshot = await store.load();
  assert.deepEqual(snapshot.missingTables, ['roster'], 'and it says which one is missing');
  assert.deepEqual(snapshot.roster, [], 'the missing one reads as empty');
  assert.equal(snapshot.contestants.length, 1, 'everything else still loads');
});

test('a missing table is told apart from a real failure', () => {
  assert.equal(isMissingTable({ code: '42P01' }), true);
  assert.equal(isMissingTable({ code: 'PGRST205' }), true);
  assert.equal(isMissingTable({ message: 'relation "public.roster" does not exist' }), true);
  assert.equal(isMissingTable({ message: 'JWT expired' }), false);
  assert.equal(isMissingTable({ message: 'permission denied for table answer_key' }), false);
  assert.equal(isMissingTable(null), false);
});

// ---------------------------------------------------------------------
// What each action costs the database
// ---------------------------------------------------------------------

/** A client that records every request the store makes. */
function countingClient(seed = {}) {
  const calls = [];
  const chain = {
    eq: () => chain, neq: () => chain, lt: () => chain, select: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (r) => Promise.resolve({ data: [], error: null }).then(r),
  };
  const table = (name) => {
    const self = {
      select(cols) { calls.push(`select ${name}${cols && cols !== '*' ? ` ${cols}` : ''}`); return self; },
      eq: () => self, order: () => self,
      range: async (from) => ({ data: from === 0 ? (seed[name] ?? []) : [], error: null }),
      maybeSingle: async () => ({ data: seed[name]?.[0] ?? null, error: null }),
      upsert: async () => { calls.push(`upsert ${name}`); return { error: null }; },
      insert() {
        calls.push(`insert ${name}`);
        return { select: () => ({ maybeSingle: async () => ({ data: {}, error: null }) }) };
      },
      update() { calls.push(`update ${name}`); return chain; },
      delete() { calls.push(`delete ${name}`); return chain; },
      then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return self;
  };
  return {
    calls,
    client: {
      from: table,
      channel: () => ({ on() { return this; }, subscribe() {} }),
      auth: { getSession: async () => ({ data: { session: null } }) },
      rpc: async () => ({ error: null }),
    },
  };
}

test('a save costs one request once the team is known', async () => {
  // Both of these used to ask the server something the snapshot already
  // knew, doubling the round trips on the two actions of the whole
  // contest that happen eleven hundred times.
  const { calls, client } = countingClient({ teams: [{ team: 'A01', division: 'A', name: 'Cowbell' }] });
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);
  await store.load();

  calls.length = 0;
  await store.saveContestant({ individual_id: 'A011', team: 'A01', division: 'A', answers: [] });
  assert.deepEqual(calls, ['upsert contestants'], 'no second trip to check the division');

  calls.length = 0;
  await store.saveGutsSet('A01', [{ problem: 1, answer: 2 }], 'g', 'G', null);
  assert.deepEqual(calls, ['upsert guts_answers'], 'no second trip to create a team we have');
});

test('but a team we have never seen is still created', async () => {
  const { calls, client } = countingClient({ teams: [] });
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);
  await store.load();

  calls.length = 0;
  await store.saveContestant({ individual_id: 'B011', team: 'B01', division: 'B', answers: [] });
  assert.deepEqual(calls, ['upsert contestants', 'upsert teams'],
    'an unknown team is written, or it never reaches the public board');

  calls.length = 0;
  await store.saveGutsSet('B02', [{ problem: 1, answer: 2 }], 'g', 'G', null);
  assert.deepEqual(calls, ['upsert teams', 'upsert guts_answers']);
});

test('the biggest table is read without the columns nothing uses', async () => {
  const { calls, client } = countingClient();
  const store = supabaseBackend({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' },
    client);
  await store.load();
  // entered_by_name and updated_at are about half the weight of 2,800
  // rows and are never read on the client.
  assert.ok(calls.includes('select guts_answers team,problem,answer,entered_by'),
    `guts_answers was read as: ${calls.filter((c) => c.includes('guts_answers'))}`);
});

test('opening the portal reads every table once, not twice', async () => {
  // refresh() loads, then the socket connects and the subscribe handler
  // loaded everything again a second later — doubling the cost of opening
  // the page, for every scorer, every time they reloaded a tab.
  //
  // onChange watches page visibility and starts the resync timer, so it
  // needs a document to attach to and a dispose() afterwards: without
  // both, the timer outlives the test and the runner never exits.
  const hadDocument = 'document' in globalThis;
  const realDocument = globalThis.document;
  globalThis.document = {
    visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
  };

  const open = async (gapMs) => {
    const { calls, client } = countingClient();
    let onSubscribed = null;
    client.channel = () => ({ on() { return this; }, subscribe(cb) { onSubscribed = cb; } });
    const store = supabaseBackend(
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, client);
    try {
      await store.load();
      store.onChange(() => {});
      await new Promise((r) => setTimeout(r, 30));
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      onSubscribed?.('SUBSCRIBED');
      await new Promise((r) => setTimeout(r, 50));
      return calls.filter((c) => c.startsWith('select')).length;
    } finally {
      store.dispose();
    }
  };

  try {
    const atStartup = await open(0);
    assert.equal(atStartup, 9, `opening should read nine tables once, read ${atStartup}`);

    // A reconnect is different: the gap it is closing can be minutes wide,
    // so there it still reloads.
    const afterDrop = await open(5200);
    assert.equal(afterDrop, 18, 'a reconnect still closes the gap it missed');
  } finally {
    if (hadDocument) globalThis.document = realDocument;
    else delete globalThis.document;
  }
});
