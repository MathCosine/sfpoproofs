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
export const APP_VERSION = '2026.09.12.1';

export const CONFIG = {
  SUPABASE_URL: 'https://gfuqvjpxoqbtbyiftdax.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_-H6aL_rA_pj5z1E87EVgOQ_RudzlFe8',
  // Two shared accounts. Graders use the staff one; a director who needs
  // to edit the answer key or open Admin uses the other. Which one the
  // portal signs in as is decided by which password was typed.
  STAFF_EMAIL: 'staff@sfpo.local',
  ADMIN_EMAIL: 'admin@sfpo.local',

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
  // IDs read <division><team><member>: A011 is Division A, team 01,
  // member 1. Each division numbers its own teams.
  TEAM_COUNT: 100,
  MEMBERS: ['1', '2', '3', '4'],
  DIVISIONS: ['A', 'B'],
  // A team's individual score counts its best three members of four.
  LEADERBOARD_PAGE: 10,

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
//  The public board also accepts ?url=...&key=... so a projector machine
//  can be pointed at a project without touching storage. The PORTAL must
//  never honour those: a link with someone else's project in it would
//  render the ordinary sign-in screen and post the staff password
//  straight to whoever sent the link. The portal takes credentials from
//  the file or from its own Connection panel, never from the address
//  bar, which is what `allowUrlParams` gates.
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

/**
 * CONFIG with any runtime credential override folded in.
 *
 * `allowUrlParams` is for the public board only — see above. It also
 * reports whether the address bar won, so the board can say so rather
 * than present a stranger's numbers as the contest's own.
 */
export function resolvedConfig(search = '', { allowUrlParams = false } = {}) {
  const params = new URLSearchParams(search);
  const fromUrl = allowUrlParams ? params.get('url') : null;
  const fromKey = allowUrlParams ? params.get('key') : null;
  const stored = readOverride();
  return {
    ...CONFIG,
    SUPABASE_URL: fromUrl || stored?.url || CONFIG.SUPABASE_URL,
    SUPABASE_ANON_KEY: fromKey || stored?.key || CONFIG.SUPABASE_ANON_KEY,
    FROM_ADDRESS_BAR: Boolean(fromUrl || fromKey),
  };
}
