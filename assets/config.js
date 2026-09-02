// =====================================================================
//  Answer-round contest portal — configuration
//
//  Fill in SUPABASE_URL and SUPABASE_ANON_KEY (Settings -> API Keys).
//  Both are safe to commit: every staff table is behind row level
//  security that requires the shared staff sign-in.
//
//  Leave them blank and the portal runs in DEMO MODE against this
//  browser only. Add ?demo=1 to a configured URL for the same thing.
// =====================================================================

// Bumped on every deploy. index.html and guts.html carry the same string
// in data-app-version; a mismatch means the browser has a half-updated
// copy and the portal says so rather than misbehaving quietly.
export const APP_VERSION = '2026.08.31.3';

export const CONFIG = {
  SUPABASE_URL: 'https://gfuqvjpxoqbtbyiftdax.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_-H6aL_rA_pj5z1E87EVgOQ_RudzlFe8',
  STAFF_EMAIL: 'staff@sfpo.local',

  CONTEST_NAME: 'Cowconuts 2026 Annual Math Contest',

  // ---- Individual round -------------------------------------------
  INDIVIDUAL_PROBLEMS: 20,
  INDIVIDUAL_POINTS: 1,        // per correct answer, no penalty

  // ---- Guts round --------------------------------------------------
  GUTS_SETS: 7,
  GUTS_PER_SET: 4,             // => 28 problems
  GUTS_DURATION: 75 * 60,      // seconds
  FREEZE_MINUTES: 10,          // board stops updating with this long left

  // ---- Combined ----------------------------------------------------
  // Weights apply to each round's share of its own maximum, never to
  // raw points — the two rounds are on different scales.
  INDIVIDUAL_WEIGHT: 80,
  GUTS_WEIGHT: 20,

  // ---- Roster ------------------------------------------------------
  // Individual IDs are <team><member>, e.g. 12C. Division is chosen from
  // a dropdown and stored on the team.
  TEAM_COUNT: 100,
  MEMBERS: ['A', 'B', 'C', 'D'],
  DIVISIONS: ['A', 'B'],

  // ---- Live coordination -------------------------------------------
  CLAIM_TTL_MS: 120000,
  HEARTBEAT_MS: 20000,
};

// ---------------------------------------------------------------------
//  Credentials can also be set at runtime, without editing this file or
//  redeploying: the portal's Connection panel writes them here, and both
//  the portal and the public leaderboard prefer them over the values
//  above. That is the quick path when you rotate a Supabase key mid
//  contest, or point the same site at a different project.
//
//  guts.html also accepts ?url=...&key=... so a projector machine can be
//  pointed at a project without touching storage.
// ---------------------------------------------------------------------
const OVERRIDE_KEY = 'contest-supabase-override';

export function readOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeOverride(url, key) {
  try {
    if (!url && !key) localStorage.removeItem(OVERRIDE_KEY);
    else localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ url, key }));
    return true;
  } catch { return false; }
}

/** CONFIG with any runtime credential override folded in. */
export function resolvedConfig(search = '') {
  const params = new URLSearchParams(search);
  const fromUrl = params.get('url');
  const fromKey = params.get('key');
  const stored = readOverride();
  return {
    ...CONFIG,
    SUPABASE_URL: fromUrl || stored?.url || CONFIG.SUPABASE_URL,
    SUPABASE_ANON_KEY: fromKey || stored?.key || CONFIG.SUPABASE_ANON_KEY,
  };
}
