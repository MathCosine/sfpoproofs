// =====================================================================
//  SFPO 2026 grading portal — configuration
//
//  Fill in SUPABASE_URL and SUPABASE_ANON_KEY from your Supabase
//  project (Settings -> API).  Both are safe to commit: the anon key is
//  a public identifier, and every table is locked behind row level
//  security that requires the shared staff sign-in.
//
//  Leave them blank and the portal boots into DEMO MODE — everything
//  works, data lives in this browser only, and a second tab acts like a
//  second grader so you can try the live locking without a server.
// =====================================================================

export const CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  // The single shared staff account you created in Supabase
  // (Authentication -> Users -> Add user).  Graders type only the
  // password; it is never stored in this repo.
  STAFF_EMAIL: 'staff@sfpo.local',

  // Contest identity
  CONTEST_NAME: 'SFPO 2026',
  CONTEST_SUBTITLE: 'San Francisco Proof Open',

  // Problem sets per division
  PROBLEMS: { A: ['A1', 'A2', 'A3'], B: ['B1', 'B2', 'B3', 'B4', 'B5'] },

  // Scoring
  MAX_SCORE: 7,          // olympiad 0-7
  ALLOW_HALF_POINTS: false,

  // A cell is offered for a second read when its single score is at or
  // above this. Two reads differing by DISAGREEMENT_DELTA or more are
  // flagged as a conflict for the head grader.
  SECOND_READ_THRESHOLD: 5,
  DISAGREEMENT_DELTA: 2,

  // Expected roster shape. There is no roster file — the portal draws
  // the matrix from these bounds and quietly ignores slots nobody ever
  // touches, because plenty of teams come with 1, 2 or 3 members.
  //
  // Changing this here only affects a database that has never had its
  // settings saved. Once app_settings exists, the stored value wins —
  // set it from Guts & export instead, so every grader picks it up.
  TEAM_COUNT: 100,
  MEMBERS: ['A', 'B', 'C', 'D'],

  // Live coordination timings (milliseconds)
  CLAIM_TTL_MS: 120000,     // a claim older than this is treated as abandoned
  HEARTBEAT_MS: 20000,      // how often we refresh our claim and presence
};
