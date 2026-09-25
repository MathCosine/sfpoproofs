// =====================================================================
//  Data layer. Two interchangeable backends behind one interface:
//    supabase — Postgres + Realtime, what you run on contest day
//    demo     — localStorage + BroadcastChannel, for ?demo=1 and tests
// =====================================================================

import { indexKey, indexGutsAnswers, scoreGutsTeam } from './scoring.js?v=2026.09.25.1';

// supabase-js, served from this site rather than a CDN. Contest day then
// depends on two services -- GitHub Pages and Supabase -- not three, and a
// venue network that blocks or stalls a CDN cannot stop anyone signing in.
// It is the browser build, which sets a global, so it goes in by <script>
// tag; importing it as a module would leave its chunk loader guessing
// where it was served from.
const SUPABASE_JS = new URL('./vendor/supabase-js-2.45.4/supabase.js', import.meta.url).href;
let supabaseLib = null;
function loadSupabase() {
  if (globalThis.supabase?.createClient) return Promise.resolve(globalThis.supabase);
  if (!supabaseLib) {
    supabaseLib = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = SUPABASE_JS;
      tag.onload = () => (globalThis.supabase?.createClient
        ? resolve(globalThis.supabase)
        : reject(new Error('The Supabase library loaded but did not start.')));
      tag.onerror = () => {
        supabaseLib = null;           // let the next attempt try again
        tag.remove();
        reject(Object.assign(new Error('Could not reach the server.'), { unreachable: true }));
      };
      document.head.appendChild(tag);
    });
  }
  return supabaseLib;
}

/**
 * An error a person can act on. A write that failed for want of a
 * connection comes back from supabase-js as "TypeError: Failed to fetch"
 * -- the browser's words, not a scorer's -- and a scorer told that stares
 * at it. Everything else passes through, code and all, so a missing
 * table can still be told apart from a real failure.
 */
export function failure(error) {
  const message = String(error?.message ?? error ?? '');
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(message)) {
    return Object.assign(new Error('No connection — that did not go through. Nothing on screen '
      + 'is lost; try again in a moment.'), { unreachable: true });
  }
  return Object.assign(new Error(message || 'Something went wrong.'), { code: error?.code });
}
const TABLES = ['app_settings', 'contest_state', 'answer_key', 'teams',
  'contestants', 'guts_answers', 'claims', 'graders', 'roster'];

const divisionOfTeamKey = (team) => {
  const d = String(team ?? '').charAt(0).toUpperCase();
  return d === 'A' || d === 'B' ? d : null;
};

const EMPTY = () => ({
  settings: null, state: null, key: [], teams: [],
  contestants: [], gutsAnswers: [], claims: [], graders: [], gutsPublic: [],
  roster: [], missingTables: [],
});

// Which cache field each table feeds, and how to tell two rows apart.
const SHAPE = {
  app_settings: { field: 'settings', single: true },
  contest_state: { field: 'state', single: true },
  answer_key: { field: 'key', id: (r) => `${r.round}|${r.division ?? '*'}|${r.problem}` },
  teams: { field: 'teams', id: (r) => String(r.team) },
  contestants: { field: 'contestants', id: (r) => r.individual_id },
  guts_answers: { field: 'gutsAnswers', id: (r) => `${r.team}|${r.problem}` },
  claims: { field: 'claims', id: (r) => `${r.scope}|${r.ref}` },
  graders: { field: 'graders', id: (r) => r.grader_id },
  roster: { field: 'roster', id: (r) => r.individual_id },
};

/**
 * Fold one realtime event into the cached snapshot.
 *
 * This exists for the free tier. Refetching every table on every change
 * is the obvious implementation and it does not survive contact with a
 * real contest: twenty staff machines each pulling a couple of hundred
 * kilobytes on every keystroke-sized change runs into gigabytes of
 * egress in an afternoon. Applying the row we were just handed costs
 * nothing and keeps the same data.
 */
export function applyPatch(cache, table, payload) {
  const shape = SHAPE[table];
  if (!shape) return cache;
  const next = { ...cache };

  if (shape.single) {
    if (payload.eventType === 'DELETE') next[shape.field] = null;
    else next[shape.field] = payload.new ?? next[shape.field];
    return next;
  }

  const list = [...(next[shape.field] ?? [])];
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row) return cache;
  const id = shape.id(row);
  const at = list.findIndex((r) => shape.id(r) === id);

  if (payload.eventType === 'DELETE') {
    if (at >= 0) list.splice(at, 1);
  } else if (at >= 0) {
    list[at] = { ...list[at], ...row };
  } else {
    list.push(row);
  }
  next[shape.field] = list;
  return next;
}

// ---------------------------------------------------------------------
// A full reload behind realtime, in case it dropped something. Two
// minutes, because on the free plan realtime does drop things: past 100
// messages a second, averaged over a minute, Supabase skips database
// changes without a word until the average comes back down. The end of
// the guts round, every team handing in at once, is the moment that can
// happen. A save that never hears its own change come back triggers an
// earlier catch-up (see expectEcho), so this is the backstop for screens
// that are only watching.
const RESYNC_MS = 2 * 60 * 1000;
// How long a save waits to hear its own change come back over realtime.
const ECHO_WAIT_MS = 10 * 1000;
// Supabase averages its message rate over the last minute, so a second
// catch-up a little after that picks up whatever it skipped meanwhile.
const CATCH_UP_MS = 70 * 1000;
// Backoff for re-joining a channel the server closed.
const REJOIN_MS = [2000, 5000, 15000, 30000, 60000];
const PAGE_SIZE = 1000;

/**
 * Read a whole table, not the first page of it.
 *
 * Supabase caps a request at its project "Max rows" setting, 1000 by
 * default, and returns the first page with no error and no indication
 * that anything is missing. guts_answers reaches 2800 rows at a hundred
 * teams, so a plain select would silently drop two thirds of the guts
 * round and show teams as having entered nothing.
 *
 * `makeQuery` has to build a fresh query each call: a PostgREST builder
 * cannot be reused once it has been awaited.
 */
/**
 * Does this error mean the table simply is not there yet? PostgREST says
 * 42P01 from Postgres, or PGRST205 from its own schema cache.
 */
export function isMissingTable(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  return /42P01|PGRST205|does not exist|schema cache|could not find the table/i.test(text);
}

export async function fetchAllPages(makeQuery, pageSize = PAGE_SIZE) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    // failure() keeps the code: it is how a missing table is told apart
    // from a real failure, and the message alone is not reliable.
    if (error) throw failure(error);
    if (data?.length) rows.push(...data);
    if (!data || data.length < pageSize) return rows;
  }
}

export function supabaseBackend(cfg, injectedClient = null) {
  let client = null;
  let channel = null;
  let cache = EMPTY();
  let resync = null;
  let onVisible = null;
  let lastLoadAt = 0;
  const listeners = new Set();
  let timer = null;
  let started = false;
  let disposed = false;
  let joining = false;
  let live = false;
  let wasLive = false;          // has this screen been listening before?
  let rejoins = 0;
  let rejoinTimer = null;

  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const pull = () => api.load()
    .then((fresh) => listeners.forEach((fn) => fn(fresh)))
    .catch(() => {});

  // ---- did realtime bring our own save back? -------------------------
  //
  // Past 100 messages a second, averaged over a minute, a free project's
  // realtime skips database changes silently until the average falls --
  // and the screens that missed them have no way to know. Except one: a
  // screen that just saved something expects to hear that change come
  // back. When it does not, changes are being dropped (or the socket is
  // dead), and whatever other screens saved meanwhile was dropped too. So
  // catch up now, and once more after Supabase's one-minute window has
  // passed, to pick up anything skipped in between.
  const expected = new Map();
  let catchUp = null;
  // Called before the write goes out, not after: the change can come back
  // over the socket before the write's own reply does, and a listener set
  // up after it would wait for something that has already been and gone.
  // Returns a cancel, for a write that failed and so has nothing to hear.
  function expectEcho(table, id) {
    if (!live) return () => {};                // not listening: the rejoin reloads
    const key = `${table}|${id}`;
    clearTimeout(expected.get(key));
    expected.set(key, setTimeout(() => {
      expected.delete(key);
      missedEcho();
    }, cfg.ECHO_WAIT_MS ?? ECHO_WAIT_MS));
    return () => { clearTimeout(expected.get(key)); expected.delete(key); };
  }
  function heard(table, row) {
    if (!row || !expected.size) return;
    const key = `${table}|${SHAPE[table]?.id?.(row)}`;
    if (!expected.has(key)) return;
    clearTimeout(expected.get(key));
    expected.delete(key);
  }
  function missedEcho() {
    pull();
    if (catchUp) return;
    catchUp = setTimeout(() => { catchUp = null; pull(); }, cfg.CATCH_UP_MS ?? CATCH_UP_MS);
  }

  /** The team as this tab last saw it, or undefined if it has never seen it. */
  const cachedTeam = (team) => cache.teams.find((t) => String(t.team) === String(team));

  // No answer is not "no". A dropped connection comes back from supabase-js
  // as AuthRetryableFetchError, status 0 (or a 502-504), a server that
  // fell over as a 5xx, and one asking to be left alone for a moment as a
  // 429. None of them says anything about the session, so none may end
  // it -- that would send a scorer back to type the password every time
  // the wifi blinked during a reload.
  const noAnswer = (error) => error?.name === 'AuthRetryableFetchError'
    || !error?.status || error.status === 429 || error.status >= 500;
  const unreachable = () => Object.assign(new Error('Could not reach the server.'),
    { unreachable: true });

  // Everything supabase-js keeps for this session, under the key it was
  // given plus the suffixes it adds.
  const SESSION_KEY = 'contest-staff-session';
  function clearStoredSession() {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k === SESSION_KEY || k.startsWith(`${SESSION_KEY}-`)) localStorage.removeItem(k);
      }
    } catch { /* storage off: nothing was stored */ }
  }

  async function getClient() {
    if (client) return client;
    if (injectedClient) { client = injectedClient; return client; }
    const { createClient } = await loadSupabase();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: SESSION_KEY },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  const api = {
    mode: 'supabase',

    /**
     * The email of the account this browser is signed in as -- asked of
     * the server, not read out of this browser's storage -- or null.
     *
     * getSession() only reads what the browser saved, and does not ask
     * the server until the access token expires, up to an hour later. A
     * session the server has already ended (a password change, a sign-out
     * elsewhere) therefore looks alive to it, and so does an admin session
     * left behind on a borrowed laptop. getUser() asks, and whatever the
     * server does not recognise is thrown away here rather than trusted.
     */
    async verifiedEmail() {
      const c = await getClient();
      const { data, error: loadError } = await c.auth.getSession();
      if (!data.session) {
        // An expired token it could not refresh for want of a connection:
        // supabase-js keeps the session, and so do we.
        if (loadError && noAnswer(loadError)) throw unreachable();
        return null;
      }
      const { data: who, error } = await c.auth.getUser();
      // Only the server saying no ends the session. Silence throws, and
      // the session stays for the next try.
      if (error && noAnswer(error)) throw unreachable();
      if (error || !who?.user?.email) {
        await api.signOut();
        return null;
      }
      return who.user.email;
    },
    /**
     * Sign in as whichever account the password belongs to. An admin
     * password authenticates as the admin user, which is what the
     * database checks before allowing the answer key to change — the
     * portal hiding a tab is a convenience, not the control.
     */
    async signIn(password, { admin = false } = {}) {
      const email = admin ? cfg.ADMIN_EMAIL : cfg.STAFF_EMAIL;
      const { error } = await (await getClient()).auth
        .signInWithPassword({ email, password });
      // Sign-ins are limited per network address -- 30 at once, then one
      // every two seconds -- and a whole venue shares one address. Say so
      // plainly: "could not reach the server" would send people checking
      // the wifi, and "wrong password" would send them guessing.
      if (error?.status === 429) {
        throw new Error('Too many sign-ins from this network just now. Wait a minute, then '
          + 'try again — nothing is wrong with your name or password.');
      }
      if (error) throw noAnswer(error) ? unreachable() : new Error(error.message);
      return { admin };
    },

    /**
     * End this browser's session, and only this browser's.
     *
     * supabase-js signs out *globally* unless told otherwise, which with a
     * shared account means every scorer in the room: one person pressing
     * Sign out, or being turned away at the door, would end twenty
     * sessions. Local ends one.
     *
     * And it keeps the session if the server call fails for any reason
     * other than 401, 403 or 404, returning the error rather than
     * throwing it. So the stored session is removed here regardless: a
     * sign-out that can leave you signed in is worse than none.
     */
    async signOut() {
      try {
        await (await getClient()).auth.signOut({ scope: 'local' });
      } catch { /* cleared below either way */ }
      clearStoredSession();
    },

    async load() {
      const c = await getClient();
      const missing = [];
      const all = (table) => fetchAllPages(() => c.from(table).select('*'));
      // A table a later version of the schema adds must not take the whole
      // portal down before somebody has run it. Reference data comes back
      // empty and says which table is missing; results tables do not, and
      // are reported as the setup step they are.
      const optional = async (table) => {
        try {
          return await all(table);
        } catch (err) {
          if (!isMissingTable(err)) throw err;
          missing.push(table);
          return [];
        }
      };
      const [settings, state, key, teams, contestants, gutsAnswers, claims, graders, roster] =
        await Promise.all([
          c.from('app_settings').select('*').eq('id', 1).maybeSingle(),
          c.from('contest_state').select('*').eq('id', 1).maybeSingle(),
          all('answer_key'),
          all('teams'),
          all('contestants'),
          // The largest table by far, and only four of its columns are
          // ever read. entered_by_name and updated_at are roughly half its
          // weight across 2,800 rows, on every open and every resync.
          fetchAllPages(() => c.from('guts_answers').select('team,problem,answer,entered_by')),
          all('claims'),
          all('graders'),
          optional('roster'),
        ]);
      const bad = [settings, state].find((r) => r.error);
      if (bad) {
        throw isMissingTable(bad.error)
          ? new Error('This database has not been set up yet. Run supabase/schema.sql in the '
            + 'Supabase SQL Editor, then reload.')
          : failure(bad.error);
      }
      cache = {
        settings: settings.data ?? null,
        state: state.data ?? null,
        key,
        teams,
        contestants,
        gutsAnswers,
        claims,
        graders,
        roster,
        missingTables: missing,
      };
      lastLoadAt = Date.now();
      return cache;
    },

    /**
     * Fold a row we just wrote into the cached snapshot, so the screen can
     * move on without pulling the whole contest back down first. Realtime
     * delivers the authoritative row a moment later and the five-minute
     * resync is still the backstop — this is a head start, not a second
     * source of truth.
     */
    patchLocal(table, row, eventType = 'UPDATE') {
      cache = applyPatch(cache, table, { eventType, new: row, old: row });
      return cache;
    },

    /**
     * Realtime events patch the cached snapshot in place; a full reload
     * happens on (re)subscribe, when a save's own change fails to come back
     * (see expectEcho), and every RESYNC_MS as the backstop.
     *
     * `everyone: false` is for a scorer's screen: it hears its own row of
     * the scorer register -- that is how an admin's correction to its name
     * reaches it -- but not every other scorer's once-a-minute heartbeat,
     * which only the admin's register shows. On a free project, where
     * every message to every screen counts against 100 a second, that was
     * the biggest steady cost there was.
     */
    onChange(cb, { graderId = null, everyone = true } = {}) {
      listeners.add(cb);
      if (started) return () => listeners.delete(cb);
      started = true;

      const join = async () => {
        if (disposed || joining) return;
        joining = true;
        try {
          const c = await getClient();
          const ch = c.channel('contest-portal');
          channel = ch;
          for (const table of TABLES) {
            const only = table === 'graders' && !everyone && graderId
              ? { filter: `grader_id=eq.${graderId}` } : {};
            ch.on('postgres_changes', { event: '*', schema: 'public', table, ...only }, (payload) => {
              heard(table, payload.new);
              cache = applyPatch(cache, table, payload);
              clearTimeout(timer);
              timer = setTimeout(() => listeners.forEach((fn) => fn(cache)), 120);
            });
          }
          ch.subscribe((status) => {
            if (ch !== channel) return;          // a replaced channel's last words
            if (status === 'SUBSCRIBED') {
              live = true;
              rejoins = 0;
              // Close the gap between the snapshot we hold and the moment
              // the socket started listening. After a drop that gap is
              // exactly what was missed, however short. At startup the
              // portal loaded a moment ago, and reloading every table a
              // second later doubled the cost of opening the page for no
              // new data -- so only then is a fresh load good enough.
              if (wasLive || Date.now() - lastLoadAt >= 5000) pull();
              wasLive = true;
            } else if (status === 'CLOSED') {
              // The server ended the channel. supabase-js rejoins a channel
              // that errored, but one the server closed it simply drops,
              // and this screen would stop hearing anything until reloaded.
              live = false;
              channel = null;
              if (disposed) return;
              const delays = cfg.REJOIN_MS ?? REJOIN_MS;
              const wait = delays[Math.min(rejoins, delays.length - 1)] * (0.75 + Math.random() / 2);
              rejoins += 1;
              clearTimeout(rejoinTimer);
              rejoinTimer = setTimeout(() => { rejoinTimer = null; join().catch(() => {}); }, wait);
            } else {
              live = false;                      // CHANNEL_ERROR, TIMED_OUT: it rejoins itself
            }
          });
        } finally {
          joining = false;
        }
      };
      join().catch(() => { /* the resync below tries again */ });

      // The safety net only has to run while somebody is looking. A tab
      // left open on a side monitor overnight used to pull the whole
      // contest twelve times an hour for nobody; now it waits, and
      // catches up the moment it is brought back to the front.
      resync = setInterval(() => {
        if (!channel && !rejoinTimer) join().catch(() => {});
        if (visible()) pull();
      }, cfg.RESYNC_MS ?? RESYNC_MS);
      if (typeof document !== 'undefined') {
        onVisible = () => { if (document.visibilityState === 'visible') pull(); };
        document.addEventListener('visibilitychange', onVisible);
      }
      return () => listeners.delete(cb);
    },

    async saveContestant(row) {
      const c = await getClient();
      const cancelEcho = expectEcho('contestants', row.individual_id);
      const { error } = await c.from('contestants').upsert(row, { onConflict: 'individual_id' });
      if (error) { cancelEcho(); throw failure(error); }

      // Only touch the team when its division actually changes. Writing it
      // on every sheet bumps updated_at, fires the public-board trigger and
      // pushes a realtime message to every open portal, hundreds of times
      // over, for a value that is set once.
      //
      // And answer that from the snapshot we already hold rather than
      // asking: the teams table is loaded, kept current by realtime, and
      // re-read every five minutes. Asking made every saved sheet two
      // round trips instead of one, four hundred times a contest.
      if (cachedTeam(row.team)?.division === row.division) return;
      const { error: teamError } = await c.from('teams')
        .upsert({ team: row.team, division: row.division }, { onConflict: 'team' });
      if (teamError) throw failure(teamError);
    },

    async saveGutsSet(team, problems, graderId, graderName, teamName) {
      const c = await getClient();
      if (teamName != null) {
        const { error } = await c.from('teams')
          .upsert({ team, name: teamName }, { onConflict: 'team' });
        if (error) throw failure(error);
      } else if (!cachedTeam(team)) {
        // The row has to exist or the team never reaches the public board,
        // which rebuilds from `teams`. But if we already have it, saying so
        // again is a wasted round trip on every guts set of the contest.
        await c.from('teams').upsert({ team }, { onConflict: 'team', ignoreDuplicates: true });
      }
      const payload = problems.map((p) => ({
        team, problem: p.problem, answer: p.answer,
        entered_by: graderId, entered_by_name: graderName,
      }));
      const cancelEcho = payload.length
        ? expectEcho('guts_answers', `${team}|${payload[0].problem}`) : () => {};
      const { error } = await c.from('guts_answers')
        .upsert(payload, { onConflict: 'team,problem' });
      if (error) { cancelEcho(); throw failure(error); }
    },

    async saveKey(rows) {
      const c = await getClient();
      const { error } = await c.from('answer_key')
        .upsert(rows, { onConflict: 'round,division,problem' });
      if (error) throw failure(error);
    },

    async setTeam(team, patch) {
      const c = await getClient();
      const { error } = await c.from('teams').upsert({ team, ...patch }, { onConflict: 'team' });
      if (error) throw failure(error);
    },

    /**
     * The imported team list. Only the name and division are sent, so a
     * team already out on a disqualification stays out: an upsert writes
     * the columns it is given and leaves the rest of the row alone. One
     * statement, so the public board is rebuilt once, not once a team.
     */
    async saveTeams(rows) {
      const c = await getClient();
      for (let i = 0; i < rows.length; i += 200) {
        const block = rows.slice(i, i + 200)
          .map(({ team, name, division }) => ({ team, name, division }));
        const { error } = await c.from('teams').upsert(block, { onConflict: 'team' });
        if (error) throw failure(error);
      }
    },

    async removeTeam(team) {
      const c = await getClient();
      const { error } = await c.from('teams').delete().eq('team', team);
      if (error) throw failure(error);
    },

    /** Change a few fields on one contestant without touching their answers. */
    async setContestant(individualId, patch) {
      const c = await getClient();
      const { error } = await c.from('contestants')
        .update(patch).eq('individual_id', individualId);
      if (error) throw failure(error);
    },

    async saveRoster(rows) {
      const c = await getClient();
      // A full roster is a few hundred rows; send it in blocks so one
      // oversized request cannot be rejected outright.
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await c.from('roster')
          .upsert(rows.slice(i, i + 200), { onConflict: 'individual_id' });
        if (error) throw failure(error);
      }
    },

    async clearRoster() {
      const c = await getClient();
      const { error } = await c.from('roster').delete().neq('individual_id', '');
      if (error) throw failure(error);
    },

    async removeRosterEntry(individualId) {
      const c = await getClient();
      const { error } = await c.from('roster').delete().eq('individual_id', individualId);
      if (error) throw failure(error);
    },

    async saveState(patch) {
      const c = await getClient();
      const { error } = await c.from('contest_state')
        .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw failure(error);
    },

    async setFrozen(frozen) {
      const c = await getClient();
      const { error } = await c.rpc('set_guts_frozen', { frozen });
      if (error) throw failure(error);
    },

    async saveSettings(patch) {
      const c = await getClient();
      const { error } = await c.from('app_settings')
        .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw failure(error);
    },

    async claim(scope, ref, grader, ttlMs) {
      const c = await getClient();
      const now = new Date().toISOString();
      const where = (q) => q.eq('scope', scope).eq('ref', ref);

      const inserted = await c.from('claims').insert({
        scope, ref, grader_id: grader.id, grader_name: grader.name, claimed_at: now,
      }).select();
      if (!inserted.error) return { ok: true };
      if (inserted.error.code !== '23505') throw failure(inserted.error);

      const patch = { grader_id: grader.id, grader_name: grader.name, claimed_at: now };
      const mine = await where(c.from('claims').update(patch)).eq('grader_id', grader.id).select();
      if (mine.data?.length) return { ok: true };

      const cutoff = new Date(Date.now() - ttlMs).toISOString();
      const stale = await where(c.from('claims').update(patch)).lt('claimed_at', cutoff).select();
      if (stale.data?.length) return { ok: true };

      const held = await where(c.from('claims').select('*')).maybeSingle();
      return { ok: false, heldBy: held.data ?? null };
    },

    async releaseClaim(scope, ref, graderId) {
      const c = await getClient();
      await c.from('claims').delete().eq('scope', scope).eq('ref', ref).eq('grader_id', graderId);
    },
    async releaseStale(seconds) {
      await (await getClient()).rpc('release_stale_claims', { max_age_seconds: seconds });
    },
    async heartbeat(grader) {
      const c = await getClient();
      await c.from('graders').upsert({
        grader_id: grader.id, name: grader.name, last_seen: new Date().toISOString(),
      }, { onConflict: 'grader_id' });
    },

    /**
     * Correct a scorer's name everywhere it was stamped. The name is
     * copied onto each row as it is entered so it survives the scorer
     * leaving, which means fixing a typo has to reach all of them.
     */
    async renameGrader(graderId, name) {
      const c = await getClient();
      for (const [table, idColumn, nameColumn] of [
        ['graders', 'grader_id', 'name'],
        ['claims', 'grader_id', 'grader_name'],
        ['contestants', 'entered_by', 'entered_by_name'],
        ['guts_answers', 'entered_by', 'entered_by_name'],
      ]) {
        const { error } = await c.from(table)
          .update({ [nameColumn]: name }).eq(idColumn, graderId);
        if (error) throw failure(error);
      }
    },

    /** Forget a scorer and let go of anything they were holding. */
    async removeGrader(graderId) {
      const c = await getClient();
      await c.from('claims').delete().eq('grader_id', graderId);
      const { error } = await c.from('graders').delete().eq('grader_id', graderId);
      if (error) throw failure(error);
    },

    /** Drop everyone who has not checked in for a while. */
    async clearIdleGraders(maxAgeSeconds) {
      const c = await getClient();
      const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
      const { data, error } = await c.from('graders')
        .delete().lt('last_seen', cutoff).select('grader_id');
      if (error) throw failure(error);
      return data?.length ?? 0;
    },

    /**
     * Clear a rehearsal out. `keepTeams` keeps the imported team names --
     * reference data, like the participant list -- and resets everything
     * else a team row carries: a practice disqualification is lifted, and
     * a row that never got a name (made by keying a sheet) goes.
     */
    async clearAll({ keepTeams = false } = {}) {
      const c = await getClient();
      const counts = {};
      const tables = [['contestants', 'individual_id'], ['guts_answers', 'team'],
        ['claims', 'ref'], ['graders', 'grader_id']];
      if (!keepTeams) tables.push(['teams', 'team']);
      for (const [table, col] of tables) {
        const { data, error } = await c.from(table).delete().not(col, 'is', null).select(col);
        if (error) throw failure(error);
        counts[table] = data?.length ?? 0;
      }
      if (keepTeams) {
        const { error: dropError } = await c.from('teams').delete().eq('name', '');
        if (dropError) throw failure(dropError);
        const { error } = await c.from('teams')
          .update({ disqualified: false, dq_reason: '', dq_by: '', dq_at: null })
          .eq('disqualified', true);
        if (error) throw failure(error);
      }
      return counts;
    },

    dispose() {
      disposed = true;
      clearInterval(resync);
      clearTimeout(rejoinTimer);
      clearTimeout(catchUp);
      for (const t of expected.values()) clearTimeout(t);
      expected.clear();
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    },
  };
  return api;
}

// ---------------------------------------------------------------------
function demoBackend(cfg) {
  const KEY = 'contest-demo-db';
  const bus = 'BroadcastChannel' in globalThis ? new BroadcastChannel('contest-demo') : null;
  const listeners = new Set();

  const seedKey = () => {
    const rows = [];
    for (const division of cfg.DIVISIONS) {
      for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
        rows.push({
          round: 'individual', division, problem: p, answer: null, points: cfg.INDIVIDUAL_POINTS,
        });
      }
    }
    for (const division of cfg.DIVISIONS) {
      for (let p = 1; p <= cfg.GUTS_SETS * cfg.GUTS_PER_SET; p += 1) {
        rows.push({
          round: 'guts', division, problem: p, answer: null,
          points: Math.ceil(p / cfg.GUTS_PER_SET),
        });
      }
    }
    return rows;
  };

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      const db = raw ? { ...EMPTY(), ...JSON.parse(raw) } : EMPTY();
      if (!db.key.length) db.key = seedKey();
      if (!db.state) {
        db.state = {
          id: 1,
          contest_name: cfg.CONTEST_NAME,
          guts_duration: cfg.GUTS_DURATION,
          guts_remaining: cfg.GUTS_DURATION,
          guts_ends_at: null,
          guts_running: false,
          freeze_minutes: cfg.FREEZE_MINUTES,
          guts_frozen: false,
        };
      }
      return db;
    } catch { return { ...EMPTY(), key: seedKey() }; }
  };
  const write = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode */ }
    bus?.postMessage('changed');
    listeners.forEach((fn) => fn(read()));
  };
  /**
   * Ten tabs sharing one localStorage key is a read-modify-write race:
   * each reads the whole snapshot, edits its corner and writes it back,
   * so simultaneous saves silently overwrite each other. Measured at
   * five losses out of ten concurrent saves before this lock existed.
   *
   * The Web Locks API serialises across tabs of the same origin, which
   * is exactly the guarantee missing here. Where it is unavailable the
   * old behaviour is the fallback — still fine for one tab.
   *
   * The Supabase backend never had this problem: each save is an
   * independent upsert keyed by its own primary key, with no snapshot
   * read in the client at all.
   */
  /**
   * The demo mirror of refresh_guts_public(). The public board reads this
   * published copy rather than recomputing from the answers, for two
   * reasons: there is then one scoring path instead of two, and the
   * freeze works — while the board is frozen this returns early and the
   * stored rows simply stop moving, which is exactly what the Postgres
   * trigger does on contest day.
   */
  const publish = (db) => {
    if (db.state?.guts_frozen) return;
    const key = indexKey(db.key ?? []);
    const byTeam = indexGutsAnswers(db.gutsAnswers ?? []);
    db.gutsPublic = (db.teams ?? []).map((t) => {
      const team = String(t.team);
      const division = t.division ?? divisionOfTeamKey(team);
      const r = scoreGutsTeam(byTeam.get(team), key, cfg, division);
      let mask = 0;
      r.perSet.forEach((set, i) => { if (set.complete) mask |= 1 << i; });
      return {
        team,
        name: t.name ?? '',
        division,
        score: r.score,
        solved: r.correct,
        answered: r.answered,
        set_mask: mask,
        disqualified: Boolean(t.disqualified),
        updated_at: new Date().toISOString(),
      };
    });
  };

  const mutate = (fn) => {
    const run = () => {
      const db = read();
      const out = fn(db);
      publish(db);
      write(db);
      return out;
    };
    return globalThis.navigator?.locks
      ? navigator.locks.request(KEY, run)
      : Promise.resolve().then(run);
  };

  bus?.addEventListener('message', () => listeners.forEach((fn) => fn(read())));
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === KEY) listeners.forEach((fn) => fn(read()));
  });

  // Team keys are text like 'A01'; Number() on one of those is NaN, which
  // used to land in storage as null and detach every row from its team.
  const upsertTeam = (db, team, patch) => {
    const key = String(team);
    const i = db.teams.findIndex((t) => String(t.team) === key);
    if (i >= 0) Object.assign(db.teams[i], patch);
    else {
      db.teams.push({
        team: key, name: '', division: divisionOfTeamKey(key),
        disqualified: false, dq_reason: '', ...patch,
      });
    }
  };

  return {
    mode: 'demo',
    async verifiedEmail() {
      const role = localStorage.getItem('contest-role');
      return role === 'admin' ? cfg.ADMIN_EMAIL : role === 'scorer' ? cfg.STAFF_EMAIL : null;
    },
    async signIn(password, { admin = false } = {}) { return { admin }; },
    async signOut() { localStorage.removeItem('contest-role'); },
    async load() { return read(); },
    patchLocal() { return read(); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async saveContestant(row) {
      await mutate((db) => {
        const i = db.contestants.findIndex((c) => c.individual_id === row.individual_id);
        const stamped = { ...row, updated_at: new Date().toISOString() };
        if (i >= 0) db.contestants[i] = { ...db.contestants[i], ...stamped };
        else db.contestants.push(stamped);
        upsertTeam(db, row.team, { division: row.division });
      });
    },

    async saveGutsSet(team, problems, graderId, graderName, teamName) {
      await mutate((db) => {
        upsertTeam(db, team, teamName != null ? { name: teamName } : {});
        for (const p of problems) {
          const i = db.gutsAnswers.findIndex(
            (g) => String(g.team) === String(team) && Number(g.problem) === p.problem);
          const row = {
            team: String(team), problem: p.problem, answer: p.answer,
            entered_by: graderId, entered_by_name: graderName,
            updated_at: new Date().toISOString(),
          };
          if (i >= 0) db.gutsAnswers[i] = row; else db.gutsAnswers.push(row);
        }
      });
    },

    async saveKey(rows) {
      await mutate((db) => {
        for (const row of rows) {
          const i = db.key.findIndex((k) => k.round === row.round
            && (k.division ?? '*') === (row.division ?? '*')
            && Number(k.problem) === Number(row.problem));
          if (i >= 0) Object.assign(db.key[i], row); else db.key.push({ ...row });
        }
      });
    },

    async setTeam(team, patch) { await mutate((db) => upsertTeam(db, team, patch)); },

    async saveTeams(rows) {
      await mutate((db) => {
        for (const { team, name, division } of rows) upsertTeam(db, team, { name, division });
      });
    },

    async removeTeam(team) {
      await mutate((db) => { db.teams = db.teams.filter((t) => String(t.team) !== String(team)); });
    },

    async setContestant(individualId, patch) {
      await mutate((db) => {
        const i = db.contestants.findIndex((c) => c.individual_id === individualId);
        if (i >= 0) db.contestants[i] = { ...db.contestants[i], ...patch };
      });
    },

    async saveRoster(rows) {
      await mutate((db) => {
        db.roster = db.roster ?? [];
        for (const row of rows) {
          const i = db.roster.findIndex((r) => r.individual_id === row.individual_id);
          if (i >= 0) db.roster[i] = { ...db.roster[i], ...row };
          else db.roster.push({ ...row });
        }
      });
    },

    async clearRoster() { await mutate((db) => { db.roster = []; }); },

    async removeRosterEntry(individualId) {
      await mutate((db) => {
        db.roster = (db.roster ?? []).filter((r) => r.individual_id !== individualId);
      });
    },
    async saveState(patch) { await mutate((db) => { db.state = { ...db.state, ...patch }; }); },
    async setFrozen(frozen) { await mutate((db) => { db.state = { ...db.state, guts_frozen: frozen }; }); },
    async saveSettings(patch) { await mutate((db) => { db.settings = { ...(db.settings ?? {}), ...patch }; }); },

    async claim(scope, ref, grader, ttlMs) {
      return mutate((db) => {
        const held = db.claims.find((c) => c.scope === scope && c.ref === ref);
        const fresh = held && Date.now() - new Date(held.claimed_at).getTime() <= ttlMs;
        if (held && fresh && held.grader_id !== grader.id) return { ok: false, heldBy: held };
        db.claims = db.claims.filter((c) => !(c.scope === scope && c.ref === ref));
        db.claims.push({
          scope, ref, grader_id: grader.id, grader_name: grader.name,
          claimed_at: new Date().toISOString(),
        });
        return { ok: true };
      });
    },
    async releaseClaim(scope, ref, graderId) {
      await mutate((db) => {
        db.claims = db.claims.filter(
          (c) => !(c.scope === scope && c.ref === ref && c.grader_id === graderId));
      });
    },
    async releaseStale(seconds) {
      await mutate((db) => {
        const cutoff = Date.now() - seconds * 1000;
        db.claims = db.claims.filter((c) => new Date(c.claimed_at).getTime() >= cutoff);
      });
    },
    async heartbeat(grader) {
      await mutate((db) => {
        const i = db.graders.findIndex((g) => g.grader_id === grader.id);
        const row = { grader_id: grader.id, name: grader.name, last_seen: new Date().toISOString() };
        if (i >= 0) db.graders[i] = row; else db.graders.push(row);
      });
    },
    async renameGrader(graderId, name) {
      await mutate((db) => {
        for (const g of db.graders) if (g.grader_id === graderId) g.name = name;
        for (const c of db.claims) if (c.grader_id === graderId) c.grader_name = name;
        for (const c of db.contestants) if (c.entered_by === graderId) c.entered_by_name = name;
        for (const g of db.gutsAnswers) if (g.entered_by === graderId) g.entered_by_name = name;
      });
    },

    async removeGrader(graderId) {
      await mutate((db) => {
        db.claims = db.claims.filter((c) => c.grader_id !== graderId);
        db.graders = db.graders.filter((g) => g.grader_id !== graderId);
      });
    },

    async clearIdleGraders(maxAgeSeconds) {
      return mutate((db) => {
        const cutoff = Date.now() - maxAgeSeconds * 1000;
        const before = db.graders.length;
        db.graders = db.graders.filter((g) => new Date(g.last_seen).getTime() >= cutoff);
        return before - db.graders.length;
      });
    },

    async clearAll({ keepTeams = false } = {}) {
      return mutate((db) => {
        const counts = {};
        const tables = ['contestants', 'gutsAnswers', 'claims', 'graders'];
        if (!keepTeams) tables.push('teams');
        for (const t of tables) {
          counts[t] = db[t].length;
          db[t] = [];
        }
        if (keepTeams) {
          db.teams = db.teams.filter((t) => t.name)
            .map((t) => ({ ...t, disqualified: false, dq_reason: '', dq_by: '', dq_at: null }));
        }
        return counts;
      });
    },
    dispose() {},
  };
}

export function createStore(cfg, { forceDemo = false } = {}) {
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  return configured && !forceDemo ? supabaseBackend(cfg) : demoBackend(cfg);
}

/**
 * A cut-down read-only client for the public leaderboard. It signs in to
 * nothing and can only see guts_public and contest_state, which hold
 * standings and a clock — never an answer and never the key.
 */
const BOARD_POLL_MS = 5000;

export function createPublicStore(cfg) {
  let client = null;
  let poll = null;
  const listeners = new Set();

  async function getClient() {
    if (client) return client;
    const { createClient } = await loadSupabase();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  }

  return {
    async load() {
      const c = await getClient();
      const [board, state] = await Promise.all([
        fetchAllPages(() => c.from('guts_public').select('*')),
        c.from('contest_state').select('*').eq('id', 1).maybeSingle(),
      ]);
      return { board, state: state.data ?? null };
    },
    /**
     * Polling, every few seconds while the page is on screen. No realtime.
     *
     * Every realtime connection counts against a free project's 200, and
     * every message to it against 100 a second -- the same allowance the
     * scorers' screens run on. A board link passed round the room would
     * have spent both on phones, and the first thing to go would have been
     * the scorers' live updates. A poll costs the board a few seconds of
     * lag, which nobody watching a guts round can see, and costs the
     * scorers nothing: two small reads through the REST API, the standings
     * and the clock, about 2 KB compressed.
     */
    onChange(cb) {
      listeners.add(cb);
      const fire = () => listeners.forEach((fn) => fn());
      if (!poll) {
        const onScreen = () => typeof document === 'undefined'
          || document.visibilityState !== 'hidden';
        poll = setInterval(() => { if (onScreen()) fire(); }, cfg.BOARD_POLL_MS ?? BOARD_POLL_MS);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', () => { if (onScreen()) fire(); });
        }
      }
      return () => listeners.delete(cb);
    },
  };
}
