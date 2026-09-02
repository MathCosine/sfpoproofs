-- =====================================================================
--  Answer-round contest portal — Supabase / Postgres schema
--
--  Individual round : 20 problems, non-negative integers, 1 point each
--  Guts round       : 7 sets of 4, per-set point values, 75 minutes
--
--  Paste this whole file into the Supabase SQL Editor and hit RUN.
--  Safe to run more than once.
--
--  NOTE: this replaces the SFPO proof-grading schema. If you are reusing
--  an existing project, run the DROP block at the bottom of this file
--  first, or start a fresh Supabase project.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Settings. One row (id = 1).
-- ---------------------------------------------------------------------
create table if not exists app_settings (
  id                    int primary key default 1,
  team_count            int     not null default 100,
  individual_weight     numeric not null default 80,
  guts_weight           numeric not null default 20,
  updated_at            timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Guts timer and freeze, read by the public leaderboard.
--
-- The clock is stored as an absolute end time while running and as a
-- remaining count while paused, so a page that joins late computes the
-- same number as everyone else without needing to have watched it tick.
-- ---------------------------------------------------------------------
create table if not exists contest_state (
  id                 int primary key default 1,
  contest_name       text    not null default 'Cowconuts 2026 Annual Math Contest',
  guts_duration      int     not null default 4500,   -- 75 minutes
  guts_ends_at       timestamptz,                     -- set while running
  guts_remaining     int     not null default 4500,   -- meaningful while paused
  guts_running       boolean not null default false,
  freeze_minutes     int     not null default 10,
  guts_frozen        boolean not null default false,
  updated_at         timestamptz not null default now(),
  constraint contest_state_singleton check (id = 1)
);
insert into contest_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Answer key. One row per problem per round; guts point values live
-- here too, so the key and the scoring are edited in one place.
--   round = 'individual' -> problems 1..20
--   round = 'guts'       -> problems 1..28  (set n covers 4n-3 .. 4n)
-- ---------------------------------------------------------------------
--   The two divisions sit different individual papers, so the individual
--   key is stored per division. Guts is one paper for everybody and uses
--   the division '*'.
create table if not exists answer_key (
  round      text    not null check (round in ('individual','guts')),
  division   char(1) not null default '*' check (division in ('A','B','*')),
  problem    int     not null check (problem >= 1),
  answer     int     check (answer >= 0),   -- null until you set it
  points     numeric not null default 1,
  updated_at timestamptz not null default now(),
  primary key (round, division, problem)
);

-- Upgrading a database that predates the split: keep whatever individual
-- key was already typed, make it Division A, and start Division B as a
-- copy of it rather than empty.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'answer_key' and column_name = 'division'
  ) then
    alter table answer_key add column division char(1) not null default '*';
    update answer_key set division = 'A' where round = 'individual';
    alter table answer_key drop constraint if exists answer_key_pkey;
    alter table answer_key add primary key (round, division, problem);
    insert into answer_key (round, division, problem, answer, points)
      select 'individual', 'B', problem, answer, points
        from answer_key where round = 'individual' and division = 'A';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Teams. Division and name live here; the name is captured the first
-- time somebody enters that team's guts answers.
-- ---------------------------------------------------------------------
create table if not exists teams (
  team         int primary key,
  name         text not null default '',
  division     char(1) check (division in ('A','B')),
  disqualified boolean not null default false,
  dq_reason    text not null default '',
  dq_by        text not null default '',
  dq_at        timestamptz,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Contestants and their individual-round answers.
--
-- The 20 answers ride along as a jsonb array because they are always
-- read and written as one sheet. Guts is stored per-problem instead
-- (see below) because the public leaderboard has to score it in SQL.
-- ---------------------------------------------------------------------
create table if not exists contestants (
  individual_id   text primary key,              -- '12C'
  team            int  not null,
  member          text not null default '',
  division        char(1) check (division in ('A','B')),
  name            text not null default '',
  answers         jsonb not null default '[]',   -- [int|null] x 20
  entered_by      text not null default '',
  entered_by_name text not null default '',
  entered_at      timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists contestants_team_idx on contestants (team);

-- ---------------------------------------------------------------------
-- Guts answers, one row per (team, problem).
-- ---------------------------------------------------------------------
create table if not exists guts_answers (
  team            int not null,
  problem         int not null check (problem >= 1),
  answer          int check (answer >= 0),
  entered_by      text not null default '',
  entered_by_name text not null default '',
  updated_at      timestamptz not null default now(),
  primary key (team, problem)
);

-- ---------------------------------------------------------------------
-- Live claims and grader presence (unchanged in spirit: two people must
-- never key the same answer sheet).
-- ---------------------------------------------------------------------
create table if not exists claims (
  scope         text not null,     -- 'individual' | 'guts'
  ref           text not null,     -- individual_id, or 'team:set'
  grader_id     text not null,
  grader_name   text not null,
  claimed_at    timestamptz not null default now(),
  primary key (scope, ref)
);

create table if not exists graders (
  grader_id  text primary key,
  name       text not null,
  last_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- The ONLY table the public leaderboard can read.
--
-- It holds finished standings — never raw answers and never the answer
-- key — so the page can be world-readable during the contest without
-- leaking anything a team could use.
-- ---------------------------------------------------------------------
create table if not exists guts_public (
  team         int primary key,
  name         text not null default '',
  division     char(1),
  score        numeric not null default 0,
  solved       int not null default 0,
  answered     int not null default 0,
  set_mask     int not null default 0,   -- bit n = set n+1 fully entered
  disqualified boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- Upgrading a database from before the board showed set progress.
alter table guts_public add column if not exists set_mask int not null default 0;

-- Recompute the public board from the private tables.
-- Returns early while the board is frozen, which is what makes the
-- freeze correct even for someone who loads the page mid-freeze: the
-- stored rows simply stop moving.
create or replace function refresh_guts_public() returns void
language plpgsql security definer as $$
begin
  if (select guts_frozen from contest_state where id = 1) then
    return;
  end if;

  insert into guts_public (team, name, division, score, solved, answered, set_mask,
                           disqualified, updated_at)
  select t.team,
         t.name,
         t.division,
         coalesce(sc.score, 0),
         coalesce(sc.solved, 0),
         coalesce(sc.answered, 0),
         coalesce(sm.set_mask, 0),
         t.disqualified,
         now()
  from teams t
  left join (
    select ga.team,
           sum(case when ak.answer is not null and ga.answer = ak.answer
                    then ak.points else 0 end) as score,
           count(*) filter (where ak.answer is not null and ga.answer = ak.answer) as solved,
           count(*) filter (where ga.answer is not null) as answered
      from guts_answers ga
      left join answer_key ak on ak.round = 'guts' and ak.division = '*'
                            and ak.problem = ga.problem
     group by ga.team
  ) sc on sc.team = t.team
  -- Which sets a team has fully turned in, as a bitmask: bit 0 is set 1.
  -- A set counts as done only when all four of its answers are in, so a
  -- team that skipped one is not shown as further along than it is.
  left join (
    select team, sum(bit)::int as set_mask
      from (
        select team, (1 << ((problem - 1) / 4)) as bit
          from guts_answers
         where answer is not null
         group by team, (problem - 1) / 4
        having count(*) = 4
      ) per_set
     group by team
  ) sm on sm.team = t.team
  on conflict (team) do update set
    name = excluded.name,
    division = excluded.division,
    score = excluded.score,
    solved = excluded.solved,
    answered = excluded.answered,
    set_mask = excluded.set_mask,
    disqualified = excluded.disqualified,
    updated_at = now()
  -- Only write rows that actually changed. Without this guard a single
  -- guts entry rewrites all ~100 rows and emits a realtime message per
  -- team per save, which burns the free tier's message budget for no
  -- reason. With it, one save moves one row.
  where guts_public.score        is distinct from excluded.score
     or guts_public.solved       is distinct from excluded.solved
     or guts_public.answered     is distinct from excluded.answered
     or guts_public.set_mask     is distinct from excluded.set_mask
     or guts_public.name         is distinct from excluded.name
     or guts_public.division     is distinct from excluded.division
     or guts_public.disqualified is distinct from excluded.disqualified;

  delete from guts_public gp where not exists (select 1 from teams t where t.team = gp.team);
end $$;

create or replace function guts_public_trigger() returns trigger
language plpgsql security definer as $$
begin
  perform refresh_guts_public();
  return null;
end $$;

drop trigger if exists guts_answers_public on guts_answers;
create trigger guts_answers_public after insert or update or delete on guts_answers
  for each statement execute function guts_public_trigger();

drop trigger if exists answer_key_public on answer_key;
create trigger answer_key_public after insert or update or delete on answer_key
  for each statement execute function guts_public_trigger();

drop trigger if exists teams_public on teams;
create trigger teams_public after insert or update or delete on teams
  for each statement execute function guts_public_trigger();

-- Unfreezing has to publish everything that happened during the freeze.
create or replace function set_guts_frozen(frozen boolean) returns void
language plpgsql security invoker as $$
begin
  update contest_state set guts_frozen = frozen, updated_at = now() where id = 1;
  if not frozen then
    perform refresh_guts_public();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- updated_at upkeep
-- ---------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['teams','contestants','guts_answers','answer_key'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before update on %I
                    for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Row level security
--
-- Staff tables: signed-in only. The portal signs in with one shared
-- account whose password is typed at the door and is not in the repo,
-- so the published anon key reveals nothing.
--
-- guts_public and contest_state: readable by anyone, because the public
-- leaderboard runs with no login. Neither holds an answer or a key.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_settings','teams','contestants','guts_answers',
                           'answer_key','claims','graders','contest_state','guts_public'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists staff_all on %I', t);
    execute format(
      'create policy staff_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

drop policy if exists anon_read on guts_public;
create policy anon_read on guts_public for select to anon using (true);

drop policy if exists anon_read_state on contest_state;
create policy anon_read_state on contest_state for select to anon using (true);

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['app_settings','teams','contestants','guts_answers',
                           'answer_key','claims','graders','contest_state','guts_public'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

alter table claims       replica identity full;
alter table contestants  replica identity full;
alter table guts_answers replica identity full;
alter table guts_public  replica identity full;

-- ---------------------------------------------------------------------
-- Seed the key with the right number of blank rows, and give guts its
-- default rising point values (set 1 = 1 point ... set 7 = 7 points).
-- Existing rows are left exactly as they are.
-- ---------------------------------------------------------------------
insert into answer_key (round, division, problem, answer, points)
select 'individual', d, g, null, 1
  from generate_series(1, 20) g, unnest(array['A','B']) d
on conflict (round, division, problem) do nothing;

insert into answer_key (round, division, problem, answer, points)
select 'guts', '*', g, null, ceil(g / 4.0) from generate_series(1, 28) g
on conflict (round, division, problem) do nothing;

do $$
declare was_frozen boolean;
begin
  select guts_frozen into was_frozen from contest_state where id = 1;
  update contest_state set guts_frozen = false where id = 1;
  perform refresh_guts_public();
  update contest_state set guts_frozen = coalesce(was_frozen, false) where id = 1;
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------
create or replace function release_stale_claims(max_age_seconds int default 120)
returns int language plpgsql security invoker as $$
declare n int;
begin
  delete from claims where claimed_at < now() - (max_age_seconds || ' seconds')::interval;
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
--  REUSING THE OLD SFPO PROJECT? Run this first, then the file above.
--  It removes the proof-grading tables. Skip it on a fresh project.
--
--    drop table if exists grades, guts, claims, graders, teams,
--                         app_settings cascade;
-- =====================================================================

-- ---------------------------------------------------------------------
-- Function privileges
--
-- PostgREST exposes every function in the public schema as an RPC, and
-- by default the anonymous role may call them. refresh_guts_public() is
-- SECURITY DEFINER, so an anonymous caller could make it run a full
-- aggregate over the guts answers as often as it liked — no data leaks,
-- but it is a free lever against a free-tier project and no business of
-- anyone who is not signed in. None of these are meant to be called from
-- the public leaderboard, so take them away from anon entirely.
-- ---------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'refresh_guts_public()',
    'set_guts_frozen(boolean)',
    'release_stale_claims(int)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
