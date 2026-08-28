// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseContestantId, summariseCell, indexGrades, liveClaims, divisionByTeam,
  buildRoster, individualStandings, teamProofStandings, combinedStandings,
  splitByDivision, suggestQueue, progressFor, cellKey,
} from '../assets/scoring.js';
import { parseGutsCsv } from '../assets/csv.js';

const cfg = {
  PROBLEMS: { A: ['A1', 'A2', 'A3'], B: ['B1', 'B2', 'B3', 'B4', 'B5'] },
  MAX_SCORE: 7,
  SECOND_READ_THRESHOLD: 5,
  DISAGREEMENT_DELTA: 2,
  TEAM_COUNT: 5,
  MEMBERS: ['A', 'B', 'C', 'D'],
  CLAIM_TTL_MS: 120000,
};

const grade = (contestant, problem, score, graderId, at, extra = {}) => ({
  contestant_id: contestant,
  team: Number(contestant.match(/\d+/)[0]),
  member: contestant.slice(-1),
  division: problem[0],
  problem,
  score,
  grader_id: graderId,
  grader_name: graderId.toUpperCase(),
  feedback: '',
  created_at: at,
  updated_at: at,
  ...extra,
});

test('contestant IDs', () => {
  assert.deepEqual(parseContestantId(' 12c ').id, '12C');
  assert.equal(parseContestantId('12c').team, 12);
  assert.equal(parseContestantId('7A').member, 'A');
  assert.equal(parseContestantId('012B').id, '12B', 'leading zeros normalise');
  assert.equal(parseContestantId('12').ok, false);
  assert.equal(parseContestantId('AB').ok, false);
  assert.equal(parseContestantId('0A').ok, false);
});

test('a single low score is simply graded', () => {
  const s = summariseCell([grade('1A', 'A1', 3, 'g1', '2026-08-29T10:00:00Z')], cfg);
  assert.equal(s.state, 'graded');
  assert.equal(s.reads, 1);
  assert.equal(s.score, 3);
});

test('a single high score asks for a second read', () => {
  assert.equal(summariseCell([grade('1A', 'A1', 5, 'g1', '2026-08-29T10:00:00Z')], cfg).state,
    'needs-second');
  assert.equal(summariseCell([grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z')], cfg).state,
    'needs-second');
  assert.equal(summariseCell([grade('1A', 'A1', 4, 'g1', '2026-08-29T10:00:00Z')], cfg).state,
    'graded');
});

test('two close reads resolve to the later one', () => {
  const s = summariseCell([
    grade('1A', 'A1', 6, 'g1', '2026-08-29T10:00:00Z'),
    grade('1A', 'A1', 7, 'g2', '2026-08-29T10:05:00Z'),
  ], cfg);
  assert.equal(s.state, 'graded');
  assert.equal(s.score, 7, 'the second read settles it');
  assert.deepEqual(s.scores, [6, 7]);
});

test('two distant reads are a conflict', () => {
  const s = summariseCell([
    grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z'),
    grade('1A', 'A1', 2, 'g2', '2026-08-29T10:05:00Z'),
  ], cfg);
  assert.equal(s.state, 'conflict');
  assert.equal(s.spread, 5);
});

test('stale claims stop counting as live', () => {
  const now = Date.parse('2026-08-29T10:00:00Z');
  const claims = liveClaims([
    { contestant_id: '1A', problem: 'A1', grader_id: 'g1', claimed_at: '2026-08-29T09:59:30Z' },
    { contestant_id: '2A', problem: 'A1', grader_id: 'g2', claimed_at: '2026-08-29T09:50:00Z' },
  ], cfg, now);
  assert.equal(claims.size, 1);
  assert.ok(claims.has(cellKey('1A', 'A1')));
});

test('a team joins its division the moment one proof is graded', () => {
  const div = divisionByTeam([grade('3B', 'B2', 4, 'g1', '2026-08-29T10:00:00Z')], [], []);
  assert.equal(div.get(3), 'B');
});

test('an explicit teams row beats the inferred division', () => {
  const div = divisionByTeam(
    [grade('3B', 'B2', 4, 'g1', '2026-08-29T10:00:00Z')],
    [{ team: 3, division: 'A' }], []);
  assert.equal(div.get(3), 'A');
});

test('roster splits by division and quarantines the unknown', () => {
  const roster = buildRoster(cfg, new Map([[1, 'A'], [2, 'B']]), new Set(['1A', '2C']));
  assert.equal(roster.A.length, 1);
  assert.equal(roster.B.length, 1);
  assert.equal(roster.unassigned.length, 3, 'teams 3-5 have no division yet');
  assert.equal(roster.A[0].members.length, 4);
  assert.equal(roster.A[0].members.find((m) => m.contestantId === '1A').seen, true);
  assert.equal(roster.A[0].members.find((m) => m.contestantId === '1D').seen, false);
});

test('a contestant graded outside the configured team range still shows up', () => {
  const roster = buildRoster(cfg, new Map([[99, 'A']]), new Set(['99B']));
  const extra = roster.A.find((t) => t.team === 99);
  assert.ok(extra, 'team 99 is beyond TEAM_COUNT but was graded');
  assert.equal(extra.beyondRange, true);
  assert.equal(extra.members.length, 1);
});

test('individual totals sum a division’s problems', () => {
  const grades = [
    grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z'),
    grade('1A', 'A2', 3, 'g1', '2026-08-29T10:01:00Z'),
    grade('1A', 'A3', 5, 'g1', '2026-08-29T10:02:00Z'),
  ];
  const div = divisionByTeam(grades, [], []);
  const [person] = individualStandings(grades, div, cfg);
  assert.equal(person.total, 15);
  assert.equal(person.complete, true);
  assert.equal(person.openFlags, 2, 'the 7 and the 5 both want a second read');
});

test('an incomplete contestant is not marked complete', () => {
  const grades = [grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z')];
  const [person] = individualStandings(grades, divisionByTeam(grades, [], []), cfg);
  assert.equal(person.complete, false);
  assert.equal(person.expected, 3);
});

test('team proof score is the sum of its members', () => {
  const grades = [
    grade('4A', 'A1', 6, 'g1', '2026-08-29T10:00:00Z'),
    grade('4B', 'A1', 4, 'g1', '2026-08-29T10:00:00Z'),
    grade('4C', 'A1', 2, 'g1', '2026-08-29T10:00:00Z'),
  ];
  const div = divisionByTeam(grades, [], []);
  const teams = teamProofStandings(individualStandings(grades, div, cfg), div, cfg);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].proof, 12);
  assert.equal(teams[0].members.length, 3, 'a three-person team is fine');
});

test('combined = proof + guts, and a missing half is flagged provisional', () => {
  const grades = [grade('4A', 'A1', 6, 'g1', '2026-08-29T10:00:00Z')];
  const div = divisionByTeam(grades, [], []);
  const teams = teamProofStandings(individualStandings(grades, div, cfg), div, cfg);

  const withGuts = combinedStandings(teams, [{ team: 4, score: 30 }], div);
  assert.equal(withGuts[0].total, 36);
  assert.equal(withGuts[0].partial, true, 'proofs are not finished yet');

  const noGuts = combinedStandings(teams, [], div);
  assert.equal(noGuts[0].guts, null);
  assert.equal(noGuts[0].total, 6);
  assert.equal(noGuts[0].partial, true);
});

test('a guts-only team still appears in the combined table', () => {
  const rows = combinedStandings([], [{ team: 9, score: 50 }], new Map([[9, 'B']]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasProof, false);
  assert.equal(rows[0].total, 50);
  assert.equal(rows[0].division, 'B');
});

test('combined ranks highest first', () => {
  const div = new Map([[1, 'A'], [2, 'A']]);
  const rows = combinedStandings(
    [{ team: 1, division: 'A', proof: 10, complete: true, openFlags: 0, members: [] },
      { team: 2, division: 'A', proof: 5, complete: true, openFlags: 0, members: [] }],
    [{ team: 1, score: 10 }, { team: 2, score: 40 }], div);
  assert.deepEqual(rows.map((r) => r.team), [2, 1], 'guts can overturn the proof order');
});

test('the queue puts conflicts first, then second reads, then unfinished people', () => {
  const grades = [
    grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z'),   // wants a 2nd read
    grade('1A', 'A2', 7, 'g1', '2026-08-29T10:00:00Z'),
    grade('1A', 'A2', 1, 'g2', '2026-08-29T10:01:00Z'),   // conflict
    grade('2A', 'A1', 3, 'g1', '2026-08-29T10:00:00Z'),   // 2A now half done
  ];
  const div = divisionByTeam(grades, [], []);
  const byCell = indexGrades(grades);
  const roster = buildRoster(cfg, div, new Set(['1A', '2A']));
  const queue = suggestQueue({ roster, byCell, claims: new Map(), cfg, myGraderId: 'g3' });

  assert.deepEqual(queue[0], {
    contestantId: '1A', problem: 'A2', division: 'A', priority: 0,
    reason: 'two reads 7 vs 1 — settle it', score: 1,
  });
  assert.equal(queue[1].problem, 'A1');
  assert.equal(queue[1].priority, 1);
  assert.ok(queue.slice(2).every((q) => q.priority >= 2));
});

test('the queue never hands you a cell you already read', () => {
  const grades = [grade('1A', 'A1', 7, 'g1', '2026-08-29T10:00:00Z')];
  const div = divisionByTeam(grades, [], []);
  const queue = suggestQueue({
    roster: buildRoster(cfg, div, new Set(['1A'])),
    byCell: indexGrades(grades),
    claims: new Map(),
    cfg,
    myGraderId: 'g1',
  });
  assert.equal(queue.some((q) => q.contestantId === '1A' && q.problem === 'A1'), false);
});

test('the queue never hands you what someone else is holding', () => {
  const div = new Map([[1, 'A']]);
  const claims = new Map([[cellKey('1A', 'A1'),
    { contestant_id: '1A', problem: 'A1', grader_id: 'someone-else' }]]);
  const queue = suggestQueue({
    roster: buildRoster(cfg, div, new Set(['1A'])),
    byCell: new Map(),
    claims,
    cfg,
    myGraderId: 'me',
  });
  assert.equal(queue.some((q) => q.contestantId === '1A' && q.problem === 'A1'), false);
  assert.ok(queue.some((q) => q.contestantId === '1A' && q.problem === 'A2'));
});

test('coverage counts only contestants somebody has touched', () => {
  const grades = [grade('1A', 'A1', 3, 'g1', '2026-08-29T10:00:00Z')];
  const div = divisionByTeam(grades, [], []);
  const roster = buildRoster(cfg, div, new Set(['1A']));
  const p = progressFor('A', roster, indexGrades(grades), cfg);
  assert.equal(p.expected, 3, 'one seen contestant, three problems — absent teammates excluded');
  assert.equal(p.done, 1);
  assert.equal(p.pct, 33);
});

test('splitByDivision keeps the strays', () => {
  const out = splitByDivision([{ division: 'A' }, { division: 'B' }, { division: null }]);
  assert.equal(out.A.length, 1);
  assert.equal(out.B.length, 1);
  assert.equal(out.unassigned.length, 1);
});

// ---------------------------------------------------------------------
// Guts CSV
// ---------------------------------------------------------------------

test('guts CSV: bare team,score with no header', () => {
  const { rows, errors } = parseGutsCsv('1,84\n2,71\n3,66\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(rows, [{ team: 1, score: 84 }, { team: 2, score: 71 }, { team: 3, score: 66 }]);
});

test('guts CSV: a header is detected and columns found by name', () => {
  const { rows } = parseGutsCsv('Score,Team\n84,1\n71,2\n');
  assert.deepEqual(rows, [{ team: 1, score: 84 }, { team: 2, score: 71 }]);
});

test('guts CSV: an optional division column is honoured', () => {
  const { rows } = parseGutsCsv('team,score,division\n1,84,A\n2,71,b\n');
  assert.deepEqual(rows, [
    { team: 1, score: 84, division: 'A' },
    { team: 2, score: 71, division: 'B' },
  ]);
});

test('guts CSV: bad rows are reported, good rows still import', () => {
  const { rows, errors } = parseGutsCsv('team,score\n1,84\nnope,12\n3,notanumber\n4,20\n');
  assert.deepEqual(rows, [{ team: 1, score: 84 }, { team: 4, score: 20 }]);
  assert.equal(errors.length, 2);
});

test('guts CSV: a repeated team keeps the later row and says so', () => {
  const { rows, errors } = parseGutsCsv('1,10\n1,90\n');
  assert.deepEqual(rows, [{ team: 1, score: 90 }]);
  assert.equal(errors.length, 1);
});

test('guts CSV: quoted fields and CRLF survive', () => {
  const { rows } = parseGutsCsv('"team","score"\r\n"12","84.5"\r\n');
  assert.deepEqual(rows, [{ team: 12, score: 84.5 }]);
});

test('combined status names exactly why a row is not final', () => {
  const div = new Map([[1, 'A'], [2, 'A'], [3, 'A'], [4, 'A']]);
  const teams = [
    { team: 1, division: 'A', proof: 21, complete: true, openFlags: 0, members: [] },
    { team: 2, division: 'A', proof: 10, complete: false, openFlags: 0, members: [] },
    { team: 3, division: 'A', proof: 12, complete: true, openFlags: 0, members: [] },
  ];
  const rows = combinedStandings(
    teams, [{ team: 1, score: 40 }, { team: 2, score: 40 }, { team: 4, score: 40 }], div);
  const by = Object.fromEntries(rows.map((r) => [r.team, r]));
  assert.equal(by[1].status, 'final');
  assert.equal(by[2].status, 'grading', 'proofs still open');
  assert.equal(by[3].status, 'awaiting guts');
  assert.equal(by[4].status, 'guts only');
  assert.equal(by[1].partial, false);
  assert.ok([2, 3, 4].every((t) => by[t].partial));
});
