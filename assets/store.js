// =====================================================================
//  Data layer. Two interchangeable backends behind one interface:
//    supabase — Postgres + Realtime, what you run on contest day
//    demo     — localStorage + BroadcastChannel, for ?demo=1 and tests
// =====================================================================

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const TABLES = ['app_settings', 'contest_state', 'answer_key', 'teams',
  'contestants', 'guts_answers', 'claims', 'graders'];

const EMPTY = () => ({
  settings: null, state: null, key: [], teams: [],
  contestants: [], gutsAnswers: [], claims: [], graders: [],
});

// Which cache field each table feeds, and how to tell two rows apart.
const SHAPE = {
  app_settings: { field: 'settings', single: true },
  contest_state: { field: 'state', single: true },
  answer_key: { field: 'key', id: (r) => `${r.round}|${r.problem}` },
  teams: { field: 'teams', id: (r) => String(r.team) },
  contestants: { field: 'contestants', id: (r) => r.individual_id },
  guts_answers: { field: 'gutsAnswers', id: (r) => `${r.team}|${r.problem}` },
  claims: { field: 'claims', id: (r) => `${r.scope}|${r.ref}` },
  graders: { field: 'graders', id: (r) => r.grader_id },
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
const RESYNC_MS = 5 * 60 * 1000;

function supabaseBackend(cfg) {
  let client = null;
  let channel = null;
  let cache = EMPTY();
  let resync = null;
  const listeners = new Set();
  let timer = null;

  async function getClient() {
    if (client) return client;
    const { createClient } = await import(/* @vite-ignore */ SUPABASE_ESM);
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'contest-staff-session' },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  const api = {
    mode: 'supabase',

    async hasSession() {
      const { data } = await (await getClient()).auth.getSession();
      return Boolean(data.session);
    },
    async signIn(password) {
      const { error } = await (await getClient()).auth
        .signInWithPassword({ email: cfg.STAFF_EMAIL, password });
      if (error) throw new Error(error.message);
      return true;
    },
    async signOut() { await (await getClient()).auth.signOut(); },

    async load() {
      const c = await getClient();
      const [settings, state, key, teams, contestants, gutsAnswers, claims, graders] =
        await Promise.all([
          c.from('app_settings').select('*').eq('id', 1).maybeSingle(),
          c.from('contest_state').select('*').eq('id', 1).maybeSingle(),
          c.from('answer_key').select('*'),
          c.from('teams').select('*'),
          c.from('contestants').select('*'),
          c.from('guts_answers').select('*'),
          c.from('claims').select('*'),
          c.from('graders').select('*'),
        ]);
      const bad = [settings, state, key, teams, contestants, gutsAnswers, claims, graders]
        .find((r) => r.error);
      if (bad) throw new Error(bad.error.message);
      cache = {
        settings: settings.data ?? null,
        state: state.data ?? null,
        key: key.data ?? [],
        teams: teams.data ?? [],
        contestants: contestants.data ?? [],
        gutsAnswers: gutsAnswers.data ?? [],
        claims: claims.data ?? [],
        graders: graders.data ?? [],
      };
      return cache;
    },

    /**
     * Realtime events patch the cached snapshot in place; a full reload
     * happens only on (re)subscribe and every RESYNC_MS as a safety net
     * against a dropped event.
     */
    onChange(cb) {
      listeners.add(cb);
      if (!channel) {
        getClient().then((c) => {
          channel = c.channel('contest-portal');
          for (const table of TABLES) {
            channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
              cache = applyPatch(cache, table, payload);
              clearTimeout(timer);
              timer = setTimeout(() => listeners.forEach((fn) => fn(cache)), 120);
            });
          }
          channel.subscribe((status) => {
            if (status !== 'SUBSCRIBED') return;
            api.load().then((fresh) => listeners.forEach((fn) => fn(fresh))).catch(() => {});
          });
        });
        resync = setInterval(() => {
          api.load().then((fresh) => listeners.forEach((fn) => fn(fresh))).catch(() => {});
        }, RESYNC_MS);
      }
      return () => listeners.delete(cb);
    },

    async saveContestant(row) {
      const c = await getClient();
      const { error } = await c.from('contestants').upsert(row, { onConflict: 'individual_id' });
      if (error) throw new Error(error.message);
      const { error: teamError } = await c.from('teams')
        .upsert({ team: row.team, division: row.division }, { onConflict: 'team' });
      if (teamError) throw new Error(teamError.message);
    },

    async saveGutsSet(team, problems, graderId, graderName, teamName) {
      const c = await getClient();
      if (teamName != null) {
        const { error } = await c.from('teams')
          .upsert({ team, name: teamName }, { onConflict: 'team' });
        if (error) throw new Error(error.message);
      } else {
        await c.from('teams').upsert({ team }, { onConflict: 'team', ignoreDuplicates: true });
      }
      const payload = problems.map((p) => ({
        team, problem: p.problem, answer: p.answer,
        entered_by: graderId, entered_by_name: graderName,
      }));
      const { error } = await c.from('guts_answers')
        .upsert(payload, { onConflict: 'team,problem' });
      if (error) throw new Error(error.message);
    },

    async saveKey(rows) {
      const c = await getClient();
      const { error } = await c.from('answer_key')
        .upsert(rows, { onConflict: 'round,problem' });
      if (error) throw new Error(error.message);
    },

    async setTeam(team, patch) {
      const c = await getClient();
      const { error } = await c.from('teams').upsert({ team, ...patch }, { onConflict: 'team' });
      if (error) throw new Error(error.message);
    },

    async saveState(patch) {
      const c = await getClient();
      const { error } = await c.from('contest_state')
        .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },

    async setFrozen(frozen) {
      const c = await getClient();
      const { error } = await c.rpc('set_guts_frozen', { frozen });
      if (error) throw new Error(error.message);
    },

    async saveSettings(patch) {
      const c = await getClient();
      const { error } = await c.from('app_settings')
        .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },

    async claim(scope, ref, grader, ttlMs) {
      const c = await getClient();
      const now = new Date().toISOString();
      const where = (q) => q.eq('scope', scope).eq('ref', ref);

      const inserted = await c.from('claims').insert({
        scope, ref, grader_id: grader.id, grader_name: grader.name, claimed_at: now,
      }).select();
      if (!inserted.error) return { ok: true };
      if (inserted.error.code !== '23505') throw new Error(inserted.error.message);

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

    async clearAll() {
      const c = await getClient();
      const counts = {};
      for (const [table, col] of [['contestants', 'individual_id'], ['guts_answers', 'team'],
        ['claims', 'ref'], ['teams', 'team'], ['graders', 'grader_id']]) {
        const { data, error } = await c.from(table).delete().not(col, 'is', null).select(col);
        if (error) throw new Error(`${table}: ${error.message}`);
        counts[table] = data?.length ?? 0;
      }
      return counts;
    },

    dispose() { clearInterval(resync); },
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
    for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
      rows.push({ round: 'individual', problem: p, answer: null, points: cfg.INDIVIDUAL_POINTS });
    }
    for (let p = 1; p <= cfg.GUTS_SETS * cfg.GUTS_PER_SET; p += 1) {
      rows.push({ round: 'guts', problem: p, answer: null, points: Math.ceil(p / cfg.GUTS_PER_SET) });
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
  const mutate = (fn) => { const db = read(); const out = fn(db); write(db); return out; };

  bus?.addEventListener('message', () => listeners.forEach((fn) => fn(read())));
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === KEY) listeners.forEach((fn) => fn(read()));
  });

  const upsertTeam = (db, team, patch) => {
    const i = db.teams.findIndex((t) => Number(t.team) === Number(team));
    if (i >= 0) Object.assign(db.teams[i], patch);
    else db.teams.push({ team: Number(team), name: '', division: null, disqualified: false, dq_reason: '', ...patch });
  };

  return {
    mode: 'demo',
    async hasSession() { return true; },
    async signIn() { return true; },
    async signOut() {},
    async load() { return read(); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async saveContestant(row) {
      mutate((db) => {
        const i = db.contestants.findIndex((c) => c.individual_id === row.individual_id);
        const stamped = { ...row, updated_at: new Date().toISOString() };
        if (i >= 0) db.contestants[i] = { ...db.contestants[i], ...stamped };
        else db.contestants.push(stamped);
        upsertTeam(db, row.team, { division: row.division });
      });
    },

    async saveGutsSet(team, problems, graderId, graderName, teamName) {
      mutate((db) => {
        upsertTeam(db, team, teamName != null ? { name: teamName } : {});
        for (const p of problems) {
          const i = db.gutsAnswers.findIndex(
            (g) => Number(g.team) === Number(team) && Number(g.problem) === p.problem);
          const row = {
            team: Number(team), problem: p.problem, answer: p.answer,
            entered_by: graderId, entered_by_name: graderName,
            updated_at: new Date().toISOString(),
          };
          if (i >= 0) db.gutsAnswers[i] = row; else db.gutsAnswers.push(row);
        }
      });
    },

    async saveKey(rows) {
      mutate((db) => {
        for (const row of rows) {
          const i = db.key.findIndex(
            (k) => k.round === row.round && Number(k.problem) === Number(row.problem));
          if (i >= 0) Object.assign(db.key[i], row); else db.key.push({ ...row });
        }
      });
    },

    async setTeam(team, patch) { mutate((db) => upsertTeam(db, team, patch)); },
    async saveState(patch) { mutate((db) => { db.state = { ...db.state, ...patch }; }); },
    async setFrozen(frozen) { mutate((db) => { db.state = { ...db.state, guts_frozen: frozen }; }); },
    async saveSettings(patch) { mutate((db) => { db.settings = { ...(db.settings ?? {}), ...patch }; }); },

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
      mutate((db) => {
        db.claims = db.claims.filter(
          (c) => !(c.scope === scope && c.ref === ref && c.grader_id === graderId));
      });
    },
    async releaseStale(seconds) {
      mutate((db) => {
        const cutoff = Date.now() - seconds * 1000;
        db.claims = db.claims.filter((c) => new Date(c.claimed_at).getTime() >= cutoff);
      });
    },
    async heartbeat(grader) {
      mutate((db) => {
        const i = db.graders.findIndex((g) => g.grader_id === grader.id);
        const row = { grader_id: grader.id, name: grader.name, last_seen: new Date().toISOString() };
        if (i >= 0) db.graders[i] = row; else db.graders.push(row);
      });
    },
    async clearAll() {
      return mutate((db) => {
        const counts = {};
        for (const t of ['contestants', 'gutsAnswers', 'claims', 'teams', 'graders']) {
          counts[t] = db[t].length;
          db[t] = [];
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
export function createPublicStore(cfg) {
  let client = null;
  let poll = null;
  const listeners = new Set();
  let timer = null;

  async function getClient() {
    if (client) return client;
    const { createClient } = await import(/* @vite-ignore */ SUPABASE_ESM);
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return client;
  }

  return {
    async load() {
      const c = await getClient();
      const [board, state] = await Promise.all([
        c.from('guts_public').select('*'),
        c.from('contest_state').select('*').eq('id', 1).maybeSingle(),
      ]);
      if (board.error) throw new Error(board.error.message);
      return { board: board.data ?? [], state: state.data ?? null };
    },
    /**
     * Realtime when it is available, polling when it is not. Realtime is
     * much the cheaper of the two for a room full of viewers — polling a
     * hundred-row table every few seconds from many screens is what
     * actually eats a free egress allowance — so polling only starts if
     * the socket fails to come up.
     */
    onChange(cb) {
      listeners.add(cb);
      const fire = () => listeners.forEach((fn) => fn());
      getClient().then((c) => {
        const channel = c.channel('public-board');
        for (const table of ['guts_public', 'contest_state']) {
          channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
            clearTimeout(timer);
            timer = setTimeout(fire, 200);
          });
        }
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearInterval(poll);
            poll = null;
            fire();
          } else if (!poll && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) {
            poll = setInterval(fire, 8000);
          }
        });
      }).catch(() => { if (!poll) poll = setInterval(fire, 8000); });
      return () => listeners.delete(cb);
    },
  };
}
