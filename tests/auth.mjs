// The real sign-in path: the real portal, the real supabase-js, in a real
// browser.
//
// The main browser suite runs in demo mode, which has no accounts at all,
// so the Supabase sign-in path went untested -- and that is where a name
// turned away at the door walked in on a reload, a session a password
// change had ended stayed alive for up to an hour, and one scorer
// signing out signed out the room. This runs it against a stand-in
// server that answers the way Supabase Auth does on each of those
// points, and a stand-in for the database that answers like PostgREST.
//
//   npm run test:auth
//
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const out = [];
const check = (name, ok, detail = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (err) => { console.log(out.join('\n')); console.error(err); process.exit(1); });
}

// The library under test has to be the one the portal loads, or this
// proves something about a different program.
const storeSrc = await readFile(join(ROOT, 'assets/store.js'), 'utf8');
const loadedVersion = /supabase-js@([\d.]+)\/\+esm/.exec(storeSrc)?.[1];
const pinnedVersion = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  .devDependencies['@supabase/supabase-js'];
check('the supabase-js under test is the version the portal loads',
  loadedVersion && loadedVersion === pinnedVersion, `${loadedVersion} / ${pinnedVersion}`);

// ---------------------------------------------------------------------
// A stand-in for Supabase
//
// Auth behaves like Supabase Auth where it matters here: a session is a
// server-side record, a refresh token belongs to one, /user and /logout
// answer 403 session_not_found once it is gone, and logout's default
// scope is every session the account has. The database behaves like
// PostgREST: it checks the token's signature and expiry and nothing
// else, so a token whose session has been ended still reads data until
// it expires -- which is exactly why the portal cannot rely on it.
// ---------------------------------------------------------------------
const PASSWORDS = { 'staff@sfpo.local': 'staff pass words', 'admin@sfpo.local': 'admin pass words' };
const USERS = Object.fromEntries(Object.keys(PASSWORDS).map((email) => [email, {
  id: randomUUID(), aud: 'authenticated', role: 'authenticated', email,
  email_confirmed_at: '2026-09-01T00:00:00Z', app_metadata: { provider: 'email' },
  user_metadata: {}, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
}]));
const sessions = new Map();          // session id -> email
const refreshTokens = new Map();     // refresh token -> session id
const lists = { admin_names: 'Thomas Ni\nRyan Wang\nLusen Yao', grader_names: 'Xu Shao\nCCMathClub' };
let logoutBreaks = false;
let unreachable = false;         // the wifi drops: every request fails to connect
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const issue = (email) => {
  const sid = randomUUID();
  const refresh = randomUUID();
  sessions.set(sid, email);
  refreshTokens.set(refresh, sid);
  const now = Math.floor(Date.now() / 1000);
  const user = USERS[email];
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: user.id, email, role: 'authenticated', aud: 'authenticated',
      session_id: sid, iat: now, exp: now + 3600 })}.signature`,
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: refresh, user,
  };
};
const claims = (req) => {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  try {
    const c = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return c.session_id && c.exp > Date.now() / 1000 ? c : null;
  } catch { return null; }
};
const aliveFor = (email) => [...sessions.values()].filter((e) => e === email).length;
const endAllSessions = () => { sessions.clear(); refreshTokens.clear(); };

const TABLES = {
  app_settings: () => [{ id: 1, team_count: 100, admin_email: 'admin@sfpo.local',
    individual_multiplier: 3, individual_weight: 80, guts_weight: 20, ...lists }],
  contest_state: () => [{ id: 1, contest_name: 'Cowconuts 2026 Annual Math Contest',
    guts_duration: 4500, guts_remaining: 4500, guts_running: false, freeze_minutes: 10,
    guts_frozen: false, guts_ends_at: null }],
  answer_key: () => [
    ...['A', 'B'].flatMap((d) => Array.from({ length: 20 }, (_, i) =>
      ({ round: 'individual', division: d, problem: i + 1, answer: null, points: 1 }))),
    ...['A', 'B'].flatMap((d) => Array.from({ length: 28 }, (_, i) =>
      ({ round: 'guts', division: d, problem: i + 1, answer: null, points: Math.ceil((i + 1) / 4) }))),
  ],
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-expose-headers': 'content-range, x-supabase-api-version',
  };
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', ...extra });
    res.end(body == null ? '' : JSON.stringify(body));
  };
  const authError = (status, code, msg) => send(status, { code: status, error_code: code, msg });
  if (unreachable) { req.socket.destroy(); return; }
  if (req.method === 'OPTIONS') return send(204, null);

  // ---- auth --------------------------------------------------------
  if (url.pathname === '/auth/v1/token') {
    const body = await readBody(req);
    if (url.searchParams.get('grant_type') === 'password') {
      if (PASSWORDS[body.email] && PASSWORDS[body.email] === body.password) {
        return send(200, issue(body.email));
      }
      return authError(400, 'invalid_credentials', 'Invalid login credentials');
    }
    const sid = refreshTokens.get(body.refresh_token);
    if (!sid || !sessions.has(sid)) {
      return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    }
    const email = sessions.get(sid);
    sessions.delete(sid);
    refreshTokens.delete(body.refresh_token);
    return send(200, issue(email));
  }
  if (url.pathname === '/auth/v1/user') {
    const c = claims(req);
    if (!c) return authError(401, 'bad_jwt', 'invalid JWT');
    if (!sessions.has(c.session_id)) {
      return authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    }
    return send(200, USERS[c.email]);
  }
  if (url.pathname === '/auth/v1/logout') {
    await readBody(req);
    if (logoutBreaks) return send(500, { code: 500, msg: 'Internal Server Error' });
    const c = claims(req);
    if (!c) return authError(401, 'bad_jwt', 'invalid JWT');
    if (!sessions.has(c.session_id)) {
      return authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    }
    const scope = url.searchParams.get('scope') ?? 'global';
    for (const [sid, email] of [...sessions]) {
      const mine = sid === c.session_id;
      if (email === c.email && (scope === 'global' || (scope === 'local' && mine)
          || (scope === 'others' && !mine))) sessions.delete(sid);
    }
    return send(204, null);
  }

  // ---- the database ------------------------------------------------
  if (url.pathname.startsWith('/rest/v1/')) {
    await readBody(req);
    const table = url.pathname.slice('/rest/v1/'.length);
    if (table.startsWith('rpc/')) return send(200, 0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req.method === 'POST' ? 201 : 204, req.method === 'POST' ? [] : null);
    }
    // Row level security: without a live token, a staff table is empty.
    const rows = claims(req) ? (TABLES[table]?.() ?? []) : [];
    return send(200, rows, {
      'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' });
  }
  return send(404, { message: 'not here' });
});
// Live updates are not what is under test; refuse the socket and let the
// portal carry on without it, as it does when realtime is unreachable.
fake.on('upgrade', (req, socket) => socket.destroy());
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

// ---------------------------------------------------------------------
// The portal, served as it is, with supabase-js from node_modules in
// place of the CDN copy of the same version.
// ---------------------------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const UMD = join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/');
const site = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = path.startsWith('/__supabase/')
    ? join(UMD, path.slice('/__supabase/'.length))
    : join(ROOT, normalize(path === '/' ? 'index.html' : path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${site.address().port}/`;
const SHIM = `await new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = '${BASE}__supabase/supabase.js'; s.onload = ok; s.onerror = fail;
  document.head.appendChild(s);
});
export const createClient = (...a) => self.supabase.createClient(...a);`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const jsErrors = [];
const liveRequests = [];
const newContext = async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([url]) => {
    if (!localStorage.getItem('contest-supabase-override')) {
      localStorage.setItem('contest-supabase-override', JSON.stringify({ url, key: 'test-anon-key' }));
    }
  }, [FAKE]);
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: SHIM }));
  await ctx.route(/supabase\.co/, (route) => { liveRequests.push(route.request().url()); route.abort(); });
  return ctx;
};
const open = async (ctx) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => jsErrors.push(String(e)));
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settled(p);
  return p;
};
// Boot has finished when it has either entered the portal or put the
// cursor in a sign-in box, which is the last thing it does at the door.
const settled = (p) => p.waitForFunction(() =>
  !document.querySelector('#app').classList.contains('hidden')
  || ['graderName', 'staffPassword'].includes(document.activeElement?.id),
  null, { timeout: 20000 });
const place = (p) => p.evaluate(() =>
  (document.querySelector('#app').classList.contains('hidden') ? 'door' : 'portal'));
const isAdmin = (p) => p.evaluate(() =>
  !document.querySelector('#app').classList.contains('hidden')
  && !document.querySelector('#adminBody').classList.contains('hidden'));
const stored = (p) => p.evaluate(() => Boolean(localStorage.getItem('contest-staff-session')));
const signIn = async (p, { name, staff = '', admin = '' }) => {
  await p.evaluate(() => { document.querySelector('#gateError').textContent = ''; });
  await p.fill('#graderName', name);
  await p.fill('#staffPassword', staff);
  await p.fill('#adminPassword', admin);
  await p.click('#gateEnter');
  await p.waitForFunction(() =>
    !document.querySelector('#app').classList.contains('hidden')
    || document.querySelector('#gateError').textContent.trim().length > 0,
  null, { timeout: 20000 });
  return p.evaluate(() => document.querySelector('#gateError').textContent.trim());
};
const reload = async (p) => { await p.reload({ waitUntil: 'domcontentloaded' }); await settled(p); };
const signOut = async (p) => {
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    p.click('.topbar [data-signout]'),
  ]);
  await settled(p);
};
const REFUSED = 'That name and password were not accepted';

// ---- 1. the door opens first time --------------------------------------
{
  const ctx = await newContext();
  const p = await open(ctx);
  check('a fresh browser starts at the door', (await place(p)) === 'door');
  await signIn(p, { name: 'Xu Shao', staff: 'staff pass words' });
  check('a listed scorer with the right password gets in on the first try, no reload',
    (await place(p)) === 'portal');
  check('and is a scorer, not an admin', (await isAdmin(p)) === false);
  await ctx.close();
}
{
  const ctx = await newContext();
  const p = await open(ctx);
  await signIn(p, { name: 'Thomas Ni', admin: 'admin pass words' });
  check('a listed director with the admin password gets in as admin',
    (await place(p)) === 'portal' && (await isAdmin(p)) === true);
  await ctx.close();
}

// ---- 2. the door stays shut, and a reload does not open it --------------
{
  const ctx = await newContext();
  const p = await open(ctx);
  // The director from the check above is still signed in, as they would
  // be at the next desk. Being turned away here must end the session
  // this attempt opened and no other: the old global sign-out ended
  // theirs too.
  const directorsBefore = aliveFor('admin@sfpo.local');
  const said = await signIn(p, { name: 'Xu Shao', admin: 'admin pass words' });
  check('a scorer\'s name with the admin password is turned away',
    (await place(p)) === 'door' && said.includes(REFUSED), said);
  check('and leaves no session behind in the browser', (await stored(p)) === false);
  check('or on the server, without signing out the director at the next desk',
    aliveFor('admin@sfpo.local') === directorsBefore,
    `${directorsBefore} admin session(s) before, ${aliveFor('admin@sfpo.local')} after`);
  await reload(p);
  check('a reload does not let them in', (await place(p)) === 'door');
  check('and never as an admin', (await isAdmin(p)) === false);

  const wrongPw = await signIn(p, { name: 'Xu Shao', staff: 'not the password' });
  check('a wrong password gets the same words as a wrong name',
    wrongPw.includes(REFUSED) && (await place(p)) === 'door', wrongPw);
  await ctx.close();
}

// ---- 3. a password change ends sessions, and they stay ended -----------
// change-passwords.sql deletes every session. The browser still holds a
// token that PostgREST would accept for up to an hour; the portal must
// ask the server rather than take the browser's word for it.
{
  const ctx = await newContext();
  const p = await open(ctx);
  await signIn(p, { name: 'Ryan Wang', admin: 'admin pass words' });
  check('a director is in as admin before the change',
    (await place(p)) === 'portal' && (await isAdmin(p)) === true);
  endAllSessions();
  await reload(p);
  check('after the passwords change, a reload goes to the door, not back in',
    (await place(p)) === 'door');
  check('not as an admin', (await isAdmin(p)) === false);
  check('and the dead session is cleared out of the browser', (await stored(p)) === false);
  await ctx.close();
}

// ---- 4. one scorer signing out signs out one scorer ---------------------
{
  const ctxA = await newContext();
  const ctxB = await newContext();
  const a = await open(ctxA);
  const b = await open(ctxB);
  await signIn(a, { name: 'Xu Shao', staff: 'staff pass words' });
  await signIn(b, { name: 'CCMathClub', staff: 'staff pass words' });
  const before = aliveFor('staff@sfpo.local');
  await signOut(b);
  check('signing out ends that browser\'s session and nobody else\'s',
    aliveFor('staff@sfpo.local') === before - 1,
    `${before} staff sessions before, ${aliveFor('staff@sfpo.local')} after`);
  check('the one who signed out is at the door', (await place(b)) === 'door');
  await reload(a);
  check('and the scorer beside them is still working', (await place(a)) === 'portal');
  await ctxA.close();
  await ctxB.close();
}

// ---- 5. a sign-out the server fumbles still signs you out --------------
// supabase-js keeps the session when logout fails with anything but a
// 401, 403 or 404. The button has to mean what it says regardless.
{
  const ctx = await newContext();
  const p = await open(ctx);
  await signIn(p, { name: 'Lusen Yao', admin: 'admin pass words' });
  logoutBreaks = true;
  await signOut(p);
  logoutBreaks = false;
  check('Sign out works even when the server errors on it', (await place(p)) === 'door');
  check('and leaves nothing behind for the next person on that laptop',
    (await stored(p)) === false && (await isAdmin(p)) === false);
  await ctx.close();
}

// ---- 6. the name list applies to a reload too --------------------------
{
  const ctx = await newContext();
  const p = await open(ctx);
  await signIn(p, { name: 'CCMathClub', staff: 'staff pass words' });
  check('a listed scorer is in', (await place(p)) === 'portal');
  const kept = lists.grader_names;
  lists.grader_names = 'Xu Shao';
  await reload(p);
  check('taken off the list, a reload puts them back at the door', (await place(p)) === 'door');
  lists.grader_names = kept;
  await ctx.close();
}

// ---- 7. a dropped connection is not a verdict ---------------------------
// Asking the server on every reload is what keeps a dead session out. But
// a reload during a wifi blip gets no answer at all, and no answer is not
// "no": signing the scorer out for it would send them back to the door to
// type the password again, in a room where the wifi is never perfect.
{
  const ctx = await newContext();
  const p = await open(ctx);
  await signIn(p, { name: 'Xu Shao', staff: 'staff pass words' });
  unreachable = true;
  await reload(p);
  const note = await p.evaluate(() => document.querySelector('#gateError').textContent.trim());
  check('a reload with no connection waits at the door rather than guessing',
    (await place(p)) === 'door');
  check('and says it could not reach the server, not that the password was wrong',
    /reach the server/i.test(note) && !note.includes(REFUSED), note || '(nothing said)');
  check('without throwing the sign-in away', (await stored(p)) === true);
  unreachable = false;
  await reload(p);
  check('so once the connection is back, a reload walks straight in — no password',
    (await place(p)) === 'portal' && (await isAdmin(p)) === false);
  await ctx.close();
}
{
  const ctx = await newContext();
  const p = await open(ctx);
  unreachable = true;
  const said = await signIn(p, { name: 'Xu Shao', staff: 'staff pass words' });
  unreachable = false;
  check('signing in with no connection says so, and does not blame the password',
    /reach the server/i.test(said) && !said.includes(REFUSED), said);
  await ctx.close();
}

check('no uncaught JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
check('never touched a live Supabase project', liveRequests.length === 0, liveRequests[0] ?? '');

await browser.close();
site.close();
fake.close();
console.log(out.join('\n'));
const checks = out.filter((l) => /^(PASS|FAIL)/.test(l));
console.log(`\n${checks.filter((l) => l.startsWith('PASS')).length}/${checks.length} checks passed`
  + ' — the real sign-in path, with supabase-js ' + pinnedVersion);
