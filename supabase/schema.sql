-- =====================================================================
--  SFPO 2026 — Staff Grading Portal
--  Supabase / Postgres schema.  Paste this whole file into the Supabase
--  SQL Editor and hit RUN.  It is safe to run more than once.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Contest-wide settings.  Exactly one row (id = 1).
-- ---------------------------------------------------------------------
create table if not exists app_settings (
  id                    int primary key default 1,
  team_count            int     not null default 100,  -- expected teams: 1..team_count
  max_members           int     not null default 4,    -- A..D
  max_score             numeric not null default 7,    -- olympiad 0-7
  second_read_threshold numeric not null default 5,    -- >= this => suggest a 2nd read
  disagreement_delta    numeric not null default 2,    -- 2 reads differing by >= this => conflict
  updated_at            timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- Combined-score weighting.
--
-- Proof and guts are on different scales (a Division B team can score 140
-- on proofs; guts might top out anywhere), so the weights are applied to
-- each component's PERCENTAGE of its own maximum, not to the raw points.
-- Weighting raw points would silently hand guts a different share in each
-- division. guts_max = 0 means "use the highest guts score present".
alter table app_settings add column if not exists proof_weight numeric not null default 80;
alter table app_settings add column if not exists guts_weight  numeric not null default 20;
alter table app_settings add column if not exists guts_max     numeric not null default 0;

-- ---------------------------------------------------------------------
-- Teams.  Division is normally inferred from the first problem graded
-- (A1-A3 => Division A, B1-B5 => Division B) but can be set by hand or
-- by the guts CSV import.
-- ---------------------------------------------------------------------
create table if not exists teams (
  team       int primary key,
  division   char(1) check (division in ('A','B')),
  note       text not null default '',
  updated_at timestamptz not null default now()
);

-- Disqualification. A DQ never deletes anything: the team's grades stay
-- exactly where they are, the team simply stops ranking and drops out of
-- the grading queue. Reinstating is one click and loses nothing.
alter table teams add column if not exists disqualified boolean not null default false;
alter table teams add column if not exists dq_reason    text    not null default '';
alter table teams add column if not exists dq_by        text    not null default '';
alter table teams add column if not exists dq_at        timestamptz;

-- ---------------------------------------------------------------------
-- Grades.  One row per (contestant, problem, grader) — so a second
-- grader reading the same proof adds a row rather than overwriting.
-- A grader re-scoring their own read upserts their existing row.
-- ---------------------------------------------------------------------
create table if not exists grades (
  id            uuid primary key default gen_random_uuid(),
  contestant_id text    not null,                     -- '12C'
  team          int     not null,                     -- 12
  member        char(1) not null,                     -- 'C'
  division      char(1) not null check (division in ('A','B')),
  problem       text    not null,                     -- 'A1'..'A3' | 'B1'..'B5'
  score         numeric(4,1) not null check (score >= 0 and score <= 7),
  feedback      text    not null default '',
  grader_name   text    not null,
  grader_id     text    not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists grades_one_read_per_grader
  on grades (contestant_id, problem, grader_id);
create index if not exists grades_cell_idx on grades (contestant_id, problem);
create index if not exists grades_recent_idx on grades (updated_at desc);

-- ---------------------------------------------------------------------
-- Guts round.  One row per team, imported from CSV (team,score).
-- ---------------------------------------------------------------------
create table if not exists guts (
  team       int primary key,
  score      numeric(8,2) not null check (score >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Live claims — "I am grading this right now".  One claim per cell, so
-- two graders can never take the same submission.  Claims older than
-- CLAIM_TTL (see assets/config.js) are treated as abandoned.
-- ---------------------------------------------------------------------
create table if not exists claims (
  contestant_id text not null,
  problem       text not null,
  grader_id     text not null,
  grader_name   text not null,
  claimed_at    timestamptz not null default now(),
  primary key (contestant_id, problem)
);

-- ---------------------------------------------------------------------
-- Who is online, for the presence strip.
-- ---------------------------------------------------------------------
create table if not exists graders (
  grader_id  text primary key,
  name       text not null,
  last_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Keep updated_at honest.
-- ---------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists grades_touch on grades;
create trigger grades_touch before update on grades
  for each row execute function touch_updated_at();

drop trigger if exists teams_touch on teams;
create trigger teams_touch before update on teams
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------
-- Row level security.
--
-- Every table is closed to the anonymous key and open to any signed-in
-- session.  The portal signs in with ONE shared staff account whose
-- password is typed by the grader at the door and never stored in this
-- repo — so publishing the anon key (which is public by design) does
-- not expose a single score.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_settings','teams','grades','guts','claims','graders'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists staff_all on %I', t);
    execute format(
      'create policy staff_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Realtime.  This is what makes the matrix, the leaderboards and the
-- claim locks update on every grader's screen at once.
-- ---------------------------------------------------------------------
-- On a hosted Supabase project this publication already exists; create it
-- for a bare Postgres so the script is self-contained.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['app_settings','teams','grades','guts','claims','graders'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- Realtime sends old-row data on DELETE only with REPLICA IDENTITY FULL,
-- which the claim locks need in order to clear a released cell.
alter table claims  replica identity full;
alter table grades  replica identity full;

-- ---------------------------------------------------------------------
-- Housekeeping helper: drop claims nobody has touched in a while.
-- The portal calls this on load; you can also schedule it with pg_cron.
-- ---------------------------------------------------------------------
create or replace function release_stale_claims(max_age_seconds int default 120)
returns int language plpgsql security invoker as $$
declare n int;
begin
  delete from claims where claimed_at < now() - (max_age_seconds || ' seconds')::interval;
  get diagnostics n = row_count;
  return n;
end $$;
