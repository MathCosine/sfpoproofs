// Twenty scorers at once, against a real Postgres.
//
// The browser test runs twenty tabs against the demo backend, where the
// lock is a Web Locks API call inside one browser. On contest day the
// lock is four SQL statements against Postgres, issued by twenty
// different laptops with no shared memory between them — a completely
// different mechanism that the browser test never touches.
//
// So this test issues the portal's exact statements, as separate
// autocommit statements the way PostgREST sends them, from twenty
// connections that all fire at the same instant. It checks the two
// things contest day depends on: that two people are never handed the
// same answer sheet, and that twenty people working at once all get
// their marks saved.
//
// Needs a throwaway Postgres. Point DATABASE_URL at one and it runs; with
// nothing to point at it says what it wants and stops without failing, so
// a laptop with no Postgres on it can still run the other suites. CI
// always sets DATABASE_URL, so there it cannot quietly skip.
//
//   npm run test:db
//
// Nothing here reaches the live project: it builds the schema in the
// database DATABASE_URL names and writes only there.
//
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.log('twenty at once: set DATABASE_URL to a throwaway Postgres to run this.');
  console.log('  e.g. DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres');
  process.exit(0);
}

const out = [];
const check = (name, ok, detail = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};
// A throw partway through would otherwise take every result gathered so
// far with it, hiding the check that actually went wrong.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (err) => {
    console.log(out.join('\n'));
    console.error(String(err?.stderr ?? err));
    process.exit(1);
  });
}

// -At: no headers, no padding, one value per line. Everything below
// compares plain strings, so anything psql adds is noise.
const psql = async (args) => {
  const { stdout } = await run('psql', [URL_, '-X', '-At', '-q', ...args],
    { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
};
const sql = (text) => psql(['-v', 'ON_ERROR_STOP=1', '-c', text]);
const one = (text) => sql(text).then((s) => s.split('\n')[0]);
// psql puts the useful line first and a CONTEXT trace after it, so the
// last line of stderr is the least informative thing in it.
const why = (err) => {
  const lines = String(err?.stderr ?? err).split('\n').filter(Boolean);
  return (lines.find((l) => l.startsWith('ERROR:')) ?? lines[0] ?? 'failed').trim();
};

// ---------------------------------------------------------------------
// A database that looks like the real one
//
// schema.sql is applied verbatim — the point is to test the schema the
// contest will actually run, not a hand-copied imitation of it. It only
// needs the two Supabase roles to exist first; everything else in the
// file is plain Postgres.
// ---------------------------------------------------------------------
const SCHEMA = fileURLToPath(new URL('../supabase/schema.sql', import.meta.url));
await sql(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
    then create role authenticated; end if;
end $$;`);
try {
  await psql(['-v', 'ON_ERROR_STOP=1', '-f', SCHEMA]);
  check('the contest schema applies to a bare Postgres', true);
} catch (err) {
  check('the contest schema applies to a bare Postgres', false,
    why(err));
  console.log(out.join('\n'));
  process.exit(1);
}

const CREW = 20;
const TTL = 120;
// How long the crew is given to connect before the shared start time.
// Every worker is parked inside the server by then, so the twenty
// statements land within microseconds of each other rather than strung
// out behind twenty process starts. A worker that arrives late simply
// does not wait — it costs the race some of its sharpness, never its
// correctness, which is why a slow CI runner cannot turn this green by
// accident.
const BARRIER_MS = Number(process.env.BARRIER_MS ?? 2000);
// How many times the save storm is repeated. See scenario 6.
const STORMS = Number(process.env.STORMS ?? 3);
const GRADERS = Array.from({ length: CREW }, (_, i) => `g${i + 1}`);

// ---------------------------------------------------------------------
// One scorer opening one sheet
//
// This mirrors assets/store.js claim() statement for statement: insert
// first, and if that hits the unique index, try to renew a claim that is
// already ours, then to take one whose holder has gone quiet, and only
// then give up and report who holds it. Each statement is its own
// transaction and its own connection, exactly as PostgREST issues them,
// because a single transaction would serialise the race this is meant to
// provoke.
//
// `at` is the start time shared by the whole crew, so the twenty
// inserts land together rather than one after another.
// ---------------------------------------------------------------------
const claim = async (gid, ref, at) => {
  const wait = `select pg_sleep(greatest(0, extract(epoch from `
             + `(timestamptz '${at}' - clock_timestamp()))))`;
  const insert = `insert into claims (scope, ref, grader_id, grader_name, claimed_at)
                  values ('individual', '${ref}', '${gid}', '${gid}', now()) returning 1`;
  let won = '';
  try {
    won = await psql(['-c', wait, '-c', insert]);
  } catch (err) {
    // 23505 is the whole design: the unique index, not the application,
    // decides who got there first. Anything else is a real failure.
    if (!/duplicate key|23505/.test(String(err.stderr ?? err))) return `ERR ${why(err)}`;
  }
  if (won.split('\n').pop() === '1') return 'WON';

  const mine = await one(`update claims set grader_id = '${gid}', grader_name = '${gid}',
                            claimed_at = now()
                          where scope = 'individual' and ref = '${ref}'
                            and grader_id = '${gid}' returning 1`);
  if (mine === '1') return 'RENEWED';

  const stale = await one(`update claims set grader_id = '${gid}', grader_name = '${gid}',
                             claimed_at = now()
                           where scope = 'individual' and ref = '${ref}'
                             and claimed_at < now() - interval '${TTL} seconds' returning 1`);
  if (stale === '1') return 'STOLE';

  return 'BLOCKED';
};

// A whole crew reaching for sheets at the same instant. `assign` says
// which sheet each of them wants.
const race = async (assign) => {
  await sql('truncate claims');
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  const results = await Promise.all(GRADERS.map((g) => claim(g, assign(g), at)));
  const tally = {};
  for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
  return { results, tally, count: (k) => tally[k] ?? 0 };
};
const shape = (t) => Object.entries(t).sort().map(([k, n]) => `${n} ${k}`).join(', ');

// ---------------------------------------------------------------------
// 1. Twenty scorers reach for the same free sheet
// ---------------------------------------------------------------------
{
  const r = await race(() => 'A011');
  const rows = await one(`select count(*) from claims`);
  check('one of twenty gets a free sheet and the other nineteen are turned away',
    r.count('WON') === 1 && r.count('BLOCKED') === CREW - 1, shape(r.tally));
  check('and the sheet is held exactly once', rows === '1', `${rows} row(s)`);
}

// ---------------------------------------------------------------------
// 2. The holder walked away — one scorer may take over, not twenty
//
// This is the case that actually happens: someone claims a sheet, closes
// the laptop, and the sheet has to come back to the room. The claim is
// older than the TTL, so the steal-if-stale update is live for all
// twenty at once.
// ---------------------------------------------------------------------
{
  await sql('truncate claims');
  await sql(`insert into claims (scope, ref, grader_id, grader_name, claimed_at)
             values ('individual', 'A011', 'ghost', 'Ghost', now() - interval '10 minutes')`);
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  const results = await Promise.all(GRADERS.map((g) => claim(g, 'A011', at)));
  const tally = {};
  for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
  const holder = await one(`select grader_id from claims`);
  const rows = await one(`select count(*) from claims`);
  check('an abandoned sheet is taken over by one scorer, not by all of them',
    (tally.STOLE ?? 0) === 1 && (tally.BLOCKED ?? 0) === CREW - 1,
    Object.entries(tally).sort().map(([k, n]) => `${n} ${k}`).join(', '));
  check('and it is held by the one who took it',
    rows === '1' && holder !== 'ghost' && GRADERS.includes(holder), `${holder}, ${rows} row(s)`);
}

// ---------------------------------------------------------------------
// 3. The holder is still working — nobody takes the sheet off them
// ---------------------------------------------------------------------
{
  await sql('truncate claims');
  await sql(`insert into claims (scope, ref, grader_id, grader_name, claimed_at)
             values ('individual', 'A011', 'g7', 'g7', now())`);
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  const results = await Promise.all(GRADERS.map((g) => claim(g, 'A011', at)));
  const tally = {};
  for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
  const holder = await one(`select grader_id from claims`);
  check('a sheet someone is working on renews for them and blocks everyone else',
    (tally.RENEWED ?? 0) === 1 && (tally.BLOCKED ?? 0) === CREW - 1,
    Object.entries(tally).sort().map(([k, n]) => `${n} ${k}`).join(', '));
  check('and the scorer who had it still has it', holder === 'g7', holder);
}

// ---------------------------------------------------------------------
// 4. Twenty scorers on twenty different sheets get on with it
//
// Mutual exclusion is easy to get right by making everything wait. This
// checks the other half: twenty people marking twenty papers must not
// block each other at all.
// ---------------------------------------------------------------------
{
  const r = await race((g) => `A${String(Number(g.slice(1))).padStart(2, '0')}1`);
  const rows = await one(`select count(distinct ref) from claims`);
  check('twenty scorers on twenty different sheets never wait on each other',
    r.count('WON') === CREW, shape(r.tally));
  check('and twenty separate sheets are locked', rows === String(CREW), `${rows} sheet(s)`);
}

// ---------------------------------------------------------------------
// 5. Releasing only ever releases your own
//
// The portal deletes its claim when a scorer moves to the next sheet.
// The delete is predicated on the grader id, so a stale tab closing
// after its lock was stolen cannot unlock the sheet out from under the
// person now marking it.
// ---------------------------------------------------------------------
{
  await sql('truncate claims');
  await sql(`insert into claims (scope, ref, grader_id, grader_name, claimed_at)
             values ('individual', 'A011', 'g7', 'g7', now())`);
  await sql(`delete from claims where scope = 'individual' and ref = 'A011'
               and grader_id = 'g3'`);
  const held = await one(`select grader_id from claims`);
  check('a scorer who lost the lock cannot release it for the one who has it',
    held === 'g7', held || '(gone)');
}

// ---------------------------------------------------------------------
// 6. Twenty scorers save twenty answer sheets at the same moment
//
// Locking is only half of it. The other half is that twenty people
// marking twenty different papers all get their marks written — no lost
// update, no deadlock between the triggers each save fires.
// ---------------------------------------------------------------------
const saveSheet = async (n, at, sheet = null) => {
  // Team and sheet keys in the portal's own shape: team A07, member 1,
  // so the sheet is A071.
  const team = `A${String(n).padStart(2, '0')}`;
  const id = sheet ?? `${team}1`;
  const answers = JSON.stringify(Array.from({ length: 20 }, () => n));
  const wait = `select pg_sleep(greatest(0, extract(epoch from `
             + `(timestamptz '${at}' - clock_timestamp()))))`;
  try {
    await psql(['-v', 'ON_ERROR_STOP=1', '-c', wait, '-c',
      `insert into contestants (individual_id, team, member, division, name, answers,
                                entered_by, entered_by_name, entered_at)
       values ('${id}', '${team}', '1', 'A', 'C${n}',
               '${answers}'::jsonb, 'g${n}', 'g${n}', now())
       on conflict (individual_id) do update set
         team = excluded.team, member = excluded.member, division = excluded.division,
         name = excluded.name, answers = excluded.answers,
         entered_by = excluded.entered_by, entered_by_name = excluded.entered_by_name,
         entered_at = excluded.entered_at`,
      '-c',
      `insert into teams (team, division) values ('${team}', 'A')
       on conflict (team) do update set division = excluded.division`]);
    return 'SAVED';
  } catch (err) {
    return `ERR ${why(err)}`;
  }
};

{
  // Run the storm several times. This is how the deadlock between two
  // rebuilds of the public board was found, and it showed up in roughly
  // a third of storms, never in a single save — so one round would be a
  // regression test that lets the regression through.
  const seen = [];
  let saved = '0';
  let crossed = '0';
  for (let round = 0; round < STORMS; round++) {
    await sql('truncate contestants, guts_answers, guts_public, teams');
    const at = new Date(Date.now() + BARRIER_MS).toISOString();
    const results = await Promise.all(
      Array.from({ length: CREW }, (_, i) => saveSheet(i + 1, at)));
    seen.push(...results);
    saved = await one('select count(*) from contestants');
    // Every sheet has to hold its own scorer's marks, not a neighbour's.
    crossed = await one(`select count(*) from contestants
                         where answers -> 0 is distinct from
                               to_jsonb(ltrim(substr(individual_id, 2, 2), '0')::int)`);
    if (saved !== String(CREW) || crossed !== '0') break;
  }
  check(`twenty answer sheets saved at once all land, ${STORMS} times over`,
    seen.every((r) => r === 'SAVED') && saved === String(CREW),
    `${saved} saved — ${[...new Set(seen)].join(', ')}`);
  check('and no sheet ends up holding another scorer\'s marks',
    crossed === '0', `${crossed} crossed`);
}

// ---------------------------------------------------------------------
// 6b. Two rebuilds of the public board never run at the same time
//
// The storm above is how the deadlock was caught, but it only catches it
// about a third of the time, and a regression test that is right a third
// of the time is not one. This checks the property that fixes it instead
// of the symptom, and it is exact: hold the rebuild open in one
// transaction, and a second rebuild must wait rather than start.
//
// With the tables empty there is nothing else for it to wait on, so if
// the second one gets through, rebuilds are running concurrently again
// and it is only a matter of which scorer loses their save.
// ---------------------------------------------------------------------
{
  await sql('truncate contestants, guts_answers, guts_public, teams');
  const holder = psql(['-v', 'ON_ERROR_STOP=1', '-c',
    `begin; select refresh_guts_public(); select pg_sleep(9); commit;`]);
  // Wait for the holder to actually hold it rather than guessing how
  // long its process takes to start. A fixed pause would pass or fail on
  // how busy the machine is, which is the opposite of what this checks.
  let held = false;
  for (let i = 0; i < 80 && !held; i++) {
    held = (await one(`select count(*) from pg_locks
                       where locktype = 'advisory' and granted`)) !== '0';
    if (!held) await new Promise((r) => setTimeout(r, 100));
  }
  check('the rebuild takes a lock at all', held, held ? '' : 'no advisory lock appeared');
  let blocked = false;
  try {
    await psql(['-v', 'ON_ERROR_STOP=1', '-c',
      `set statement_timeout = '1500ms'; select refresh_guts_public();`]);
  } catch (err) {
    blocked = /statement timeout/i.test(String(err.stderr ?? err));
  }
  await holder;
  check('a second rebuild of the public board waits for the first',
    blocked, blocked ? 'waited' : 'ran straight through — rebuilds can deadlock');
}

// ---------------------------------------------------------------------
// 7. Twenty graders enter guts sets at the same moment
//
// Every guts write fires an after-statement trigger that rebuilds the
// public board. Twenty of those running at once is where a deadlock
// would show up, and a deadlock mid-round means somebody's set is lost
// and the board stops moving.
// ---------------------------------------------------------------------
{
  await sql('truncate contestants, guts_answers, guts_public, teams');
  await sql(`insert into answer_key (round, division, problem, answer, points)
             select 'guts', '*', g, 1, 1 from generate_series(1, 28) g
             on conflict (round, division, problem) do update
               set answer = excluded.answer, points = excluded.points`);
  await sql(`insert into teams (team, name, division)
             select 'A' || lpad(g::text, 2, '0'), 'T' || g, 'A'
               from generate_series(1, ${CREW}) g
             on conflict (team) do nothing`);
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  const enter = async (n) => {
    const team = `A${String(n).padStart(2, '0')}`;
    const wait = `select pg_sleep(greatest(0, extract(epoch from `
               + `(timestamptz '${at}' - clock_timestamp()))))`;
    const rows = [1, 2, 3, 4]
      .map((p) => `('${team}', ${p}, 1, 'g${n}', 'g${n}')`).join(', ');
    try {
      await psql(['-v', 'ON_ERROR_STOP=1', '-c', wait, '-c',
        `insert into guts_answers (team, problem, answer, entered_by, entered_by_name)
         values ${rows}
         on conflict (team, problem) do update set
           answer = excluded.answer, entered_by = excluded.entered_by,
           entered_by_name = excluded.entered_by_name`]);
      return 'ENTERED';
    } catch (err) {
      return `ERR ${why(err)}`;
    }
  };
  const results = await Promise.all(Array.from({ length: CREW }, (_, i) => enter(i + 1)));
  const answers = await one('select count(*) from guts_answers');
  const scored = await one(`select count(*) from guts_public
                            where score = 4 and solved = 4 and answered = 4 and set_mask = 1`);
  const deadlocks = results.filter((r) => /deadlock/i.test(r)).length;
  check('twenty guts sets entered at once all land, with no deadlock',
    results.every((r) => r === 'ENTERED') && answers === String(CREW * 4),
    `${answers} answers, ${deadlocks} deadlock(s) — ${[...new Set(results)].join(', ')}`);
  check('and the public board has every team scored',
    scored === String(CREW), `${scored}/${CREW} teams`);
}

// ---------------------------------------------------------------------
// 8. Two scorers save the same sheet at the same moment
//
// The lock is meant to stop this, but a scorer can always reload past a
// lock, so the write path has to survive it: one row, one scorer's
// marks, nothing torn in half.
// ---------------------------------------------------------------------
{
  await sql('truncate contestants, guts_answers, guts_public, teams');
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  // Each scorer fills the paper with their own number, so a row that
  // ended up half one scorer's and half another's is visible as two
  // different values down the same paper.
  const results = await Promise.all(
    Array.from({ length: CREW }, (_, i) => saveSheet(i + 1, at, 'A011')));
  const rows = await one(`select count(*) from contestants where individual_id = 'A011'`);
  const intact = await one(`select count(distinct a) from contestants,
                            lateral jsonb_array_elements(answers) a
                            where individual_id = 'A011'`);
  check('twenty saves of the same sheet leave one row, not twenty',
    rows === '1' && results.every((r) => r === 'SAVED'),
    `${rows} row(s) — ${[...new Set(results)].join(', ')}`);
  check('and that row holds one scorer\'s marks, not a mixture',
    intact === '1', `${intact} distinct value(s) across the paper`);
}

// ---------------------------------------------------------------------
// 9. Twenty scorers say hello at once
//
// The heartbeat is what puts a name in the "who is grading" list. Twenty
// arriving together must produce twenty names, not one row fought over.
// ---------------------------------------------------------------------
{
  await sql('truncate graders');
  const at = new Date(Date.now() + BARRIER_MS).toISOString();
  const hello = async (g) => {
    const wait = `select pg_sleep(greatest(0, extract(epoch from `
               + `(timestamptz '${at}' - clock_timestamp()))))`;
    try {
      await psql(['-v', 'ON_ERROR_STOP=1', '-c', wait, '-c',
        `insert into graders (grader_id, name, last_seen) values ('${g}', '${g}', now())
         on conflict (grader_id) do update set name = excluded.name,
           last_seen = excluded.last_seen`]);
      return 'SEEN';
    } catch (err) {
      return `ERR ${why(err)}`;
    }
  };
  const results = await Promise.all(GRADERS.map(hello));
  const seen = await one('select count(*) from graders');
  check('twenty scorers arriving at once all appear in the room',
    results.every((r) => r === 'SEEN') && seen === String(CREW),
    `${seen} present — ${[...new Set(results)].join(', ')}`);
}

console.log(out.join('\n'));
const checks = out.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL'));
console.log(`\n${checks.filter((l) => l.startsWith('PASS')).length}/${checks.length} checks passed`
  + ` — ${CREW} concurrent connections against real Postgres`);
