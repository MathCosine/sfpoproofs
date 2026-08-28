// =====================================================================
//  Data layer.
//
//  Two interchangeable backends behind one interface:
//
//    supabase — Postgres + Realtime. What you run on contest day.
//    demo     — localStorage, with a BroadcastChannel standing in for
//               realtime so a second browser tab behaves like a second
//               grader. Used whenever config.js has no credentials.
//
//  Both emit the same change events, so the UI never knows which one it
//  is talking to.
// =====================================================================

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const TABLES = ['app_settings', 'teams', 'grades', 'guts', 'claims', 'graders'];

const EMPTY = () => ({ settings: null, teams: [], grades: [], guts: [], claims: [], graders: [] });

// ---------------------------------------------------------------------
// Supabase backend
// ---------------------------------------------------------------------
function supabaseBackend(cfg) {
  let client = null;
  let channel = null;
  const listeners = new Set();
  let refetchTimer = null;

  async function getClient() {
    if (client) return client;
    const { createClient } = await import(/* @vite-ignore */ SUPABASE_ESM);
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sfpo-staff-session' },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  const api = {
    mode: 'supabase',

    async hasSession() {
      const c = await getClient();
      const { data } = await c.auth.getSession();
      return Boolean(data.session);
    },

    async signIn(password) {
      const c = await getClient();
      const { error } = await c.auth.signInWithPassword({
        email: cfg.STAFF_EMAIL,
        password,
      });
      if (error) throw new Error(error.message);
      return true;
    },

    async signOut() {
      const c = await getClient();
      await c.auth.signOut();
    },

    async load() {
      const c = await getClient();
      const [settings, teams, grades, guts, claims, graders] = await Promise.all([
        c.from('app_settings').select('*').eq('id', 1).maybeSingle(),
        c.from('teams').select('*'),
        c.from('grades').select('*'),
        c.from('guts').select('*'),
        c.from('claims').select('*'),
        c.from('graders').select('*'),
      ]);
      const first = [settings, teams, grades, guts, claims, graders].find((r) => r.error);
      if (first) throw new Error(first.error.message);
      return {
        settings: settings.data ?? null,
        teams: teams.data ?? [],
        grades: grades.data ?? [],
        guts: guts.data ?? [],
        claims: claims.data ?? [],
        graders: graders.data ?? [],
      };
    },

    onChange(cb) {
      listeners.add(cb);
      if (!channel) {
        getClient().then((c) => {
          channel = c.channel('sfpo-grading');
          for (const table of TABLES) {
            channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
              clearTimeout(refetchTimer);
              refetchTimer = setTimeout(() => listeners.forEach((fn) => fn()), 180);
            });
          }
          channel.subscribe();
        });
      }
      return () => listeners.delete(cb);
    },

    async saveGrade(row) {
      const c = await getClient();
      const { error } = await c.from('grades')
        .upsert(row, { onConflict: 'contestant_id,problem,grader_id' });
      if (error) throw new Error(error.message);
      const { error: teamError } = await c.from('teams')
        .upsert({ team: row.team, division: row.division }, { onConflict: 'team' });
      if (teamError) throw new Error(teamError.message);
    },

    async deleteGrade(id) {
      const c = await getClient();
      const { error } = await c.from('grades').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async setTeamDivision(team, division) {
      const c = await getClient();
      const { error } = await c.from('teams').upsert({ team, division }, { onConflict: 'team' });
      if (error) throw new Error(error.message);
    },

    /**
     * Take the lock on one cell. This is deliberately NOT an upsert:
     * an upsert would let whoever clicked last quietly take a proof off
     * the grader already reading it, which is the exact thing the panel
     * exists to prevent.
     *
     * Insert first — the primary key makes that the atomic winner. On a
     * conflict, the only claims we may take over are our own (a
     * heartbeat) and one nobody has refreshed inside the TTL (a grader
     * who closed their laptop). Each of those is a single predicated
     * UPDATE, so two graders racing cannot both win.
     *
     * Returns { ok } or { ok:false, heldBy }.
     */
    async claim(contestantId, problem, grader, ttlMs) {
      const c = await getClient();
      const now = new Date().toISOString();
      const where = (q) => q.eq('contestant_id', contestantId).eq('problem', problem);

      const inserted = await c.from('claims').insert({
        contestant_id: contestantId,
        problem,
        grader_id: grader.id,
        grader_name: grader.name,
        claimed_at: now,
      }).select();
      if (!inserted.error) return { ok: true };
      if (inserted.error.code !== '23505') throw new Error(inserted.error.message);

      const patch = { grader_id: grader.id, grader_name: grader.name, claimed_at: now };
      const mine = await where(c.from('claims').update(patch))
        .eq('grader_id', grader.id).select();
      if (mine.data?.length) return { ok: true };

      const cutoff = new Date(Date.now() - ttlMs).toISOString();
      const abandoned = await where(c.from('claims').update(patch))
        .lt('claimed_at', cutoff).select();
      if (abandoned.data?.length) return { ok: true };

      const held = await where(c.from('claims').select('*')).maybeSingle();
      return { ok: false, heldBy: held.data ?? null };
    },

    async releaseClaim(contestantId, problem, graderId) {
      const c = await getClient();
      await c.from('claims').delete()
        .eq('contestant_id', contestantId).eq('problem', problem).eq('grader_id', graderId);
    },

    async releaseStale(maxAgeSeconds) {
      const c = await getClient();
      await c.rpc('release_stale_claims', { max_age_seconds: maxAgeSeconds });
    },

    async heartbeat(grader) {
      const c = await getClient();
      await c.from('graders').upsert({
        grader_id: grader.id, name: grader.name, last_seen: new Date().toISOString(),
      }, { onConflict: 'grader_id' });
    },

    async importGuts(rows) {
      const c = await getClient();
      const payload = rows.map((r) => ({
        team: r.team, score: r.score, updated_at: new Date().toISOString(),
      }));
      const { error } = await c.from('guts').upsert(payload, { onConflict: 'team' });
      if (error) throw new Error(error.message);
      const withDivision = rows.filter((r) => r.division);
      if (withDivision.length) {
        await c.from('teams').upsert(
          withDivision.map((r) => ({ team: r.team, division: r.division })),
          { onConflict: 'team' });
      }
    },

    async clearGuts() {
      const c = await getClient();
      await c.from('guts').delete().gte('team', 0);
    },

    async saveSettings(patch) {
      const c = await getClient();
      const { error } = await c.from('app_settings')
        .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
  };
  return api;
}

// ---------------------------------------------------------------------
// Demo backend — same interface, browser-local storage
// ---------------------------------------------------------------------
function demoBackend() {
  const KEY = 'sfpo-demo-db';
  const bus = 'BroadcastChannel' in globalThis ? new BroadcastChannel('sfpo-demo') : null;
  const listeners = new Set();

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...EMPTY(), ...JSON.parse(raw) } : EMPTY();
    } catch { return EMPTY(); }
  };
  const write = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode */ }
    bus?.postMessage('changed');
    listeners.forEach((fn) => fn());
  };
  const mutate = (fn) => { const db = read(); fn(db); write(db); };

  bus?.addEventListener('message', () => listeners.forEach((fn) => fn()));
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === KEY) listeners.forEach((fn) => fn());
  });

  return {
    mode: 'demo',
    async hasSession() { return true; },
    async signIn() { return true; },
    async signOut() {},
    async load() { return read(); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async saveGrade(row) {
      mutate((db) => {
        const i = db.grades.findIndex((g) => g.contestant_id === row.contestant_id
          && g.problem === row.problem && g.grader_id === row.grader_id);
        const stamped = { ...row, updated_at: new Date().toISOString() };
        if (i >= 0) db.grades[i] = { ...db.grades[i], ...stamped };
        else db.grades.push({ ...stamped, id: crypto.randomUUID(), created_at: stamped.updated_at });
        const t = db.teams.findIndex((x) => x.team === row.team);
        if (t >= 0) db.teams[t].division = row.division;
        else db.teams.push({ team: row.team, division: row.division });
      });
    },
    async deleteGrade(id) { mutate((db) => { db.grades = db.grades.filter((g) => g.id !== id); }); },
    async setTeamDivision(team, division) {
      mutate((db) => {
        const i = db.teams.findIndex((x) => x.team === team);
        if (i >= 0) db.teams[i].division = division; else db.teams.push({ team, division });
      });
    },
    async claim(contestantId, problem, grader, ttlMs) {
      // Same rule as the Postgres backend: never take a live claim off
      // another grader.
      let result = { ok: true };
      mutate((db) => {
        const held = db.claims.find(
          (c) => c.contestant_id === contestantId && c.problem === problem);
        const fresh = held && Date.now() - new Date(held.claimed_at).getTime() <= ttlMs;
        if (held && fresh && held.grader_id !== grader.id) {
          result = { ok: false, heldBy: held };
          return;
        }
        db.claims = db.claims.filter(
          (c) => !(c.contestant_id === contestantId && c.problem === problem));
        db.claims.push({
          contestant_id: contestantId,
          problem,
          grader_id: grader.id,
          grader_name: grader.name,
          claimed_at: new Date().toISOString(),
        });
      });
      return result;
    },
    async releaseClaim(contestantId, problem, graderId) {
      mutate((db) => {
        db.claims = db.claims.filter((c) => !(c.contestant_id === contestantId
          && c.problem === problem && c.grader_id === graderId));
      });
    },
    async releaseStale(maxAgeSeconds) {
      mutate((db) => {
        const cutoff = Date.now() - maxAgeSeconds * 1000;
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
    async importGuts(rows) {
      mutate((db) => {
        for (const r of rows) {
          const i = db.guts.findIndex((g) => g.team === r.team);
          const row = { team: r.team, score: r.score, updated_at: new Date().toISOString() };
          if (i >= 0) db.guts[i] = row; else db.guts.push(row);
          if (r.division) {
            const t = db.teams.findIndex((x) => x.team === r.team);
            if (t >= 0) db.teams[t].division = r.division;
            else db.teams.push({ team: r.team, division: r.division });
          }
        }
      });
    },
    async clearGuts() { mutate((db) => { db.guts = []; }); },
    async saveSettings(patch) {
      mutate((db) => { db.settings = { ...(db.settings ?? {}), ...patch }; });
    },
    async reset() { mutate((db) => { Object.assign(db, EMPTY()); }); },
  };
}

export function createStore(cfg) {
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  return configured ? supabaseBackend(cfg) : demoBackend();
}
