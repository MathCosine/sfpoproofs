-- =====================================================================
--  Is this database ready for contest day?
--
--  Paste into the Supabase SQL Editor and RUN, ideally the week before
--  and again on the morning. Read-only: it changes nothing.
--
--  Read the verdict column:
--
--    GO    nothing to do
--    FIX   do this before the contest starts
--    LOOK  probably fine, but worth a glance
--    INFO  a number, not a judgement
--
--  Two numbers you can set before running, if yours differ:
--
--    set preflight.graders = '20';   -- people scoring at once
--    set preflight.hours   = '6';    -- how long the day runs
--
--  Its siblings: verify.sql checks the schema is current, whatran.sql
--  checks nothing foreign has been run in here. This one checks the
--  contest itself is loaded and the day will hold together.
-- =====================================================================

with settings as (
  select greatest(1, coalesce(nullif(current_setting('preflight.graders', true), ''), '20')::int)
           as graders,
         greatest(1, coalesce(nullif(current_setting('preflight.hours', true), ''), '6')::numeric)
           as hours
),
mine(t) as (
  values ('app_settings'),('contest_state'),('answer_key'),('teams'),
         ('contestants'),('guts_answers'),('claims'),('graders'),('guts_public'),
         ('roster')
),
myfns(f) as (
  values ('refresh_guts_public'),('guts_public_trigger'),('set_guts_frozen'),
         ('touch_updated_at'),('is_admin'),('release_stale_claims')
),
-- Counts, or null where the table is not there. Named through
-- query_to_xml because a query that mentions a missing table cannot be
-- planned, and a readiness check that will not run is no use at all.
n as (
  select m.t,
         case when to_regclass('public.' || m.t) is null then null
              else (xpath('/table/row/c/text()', query_to_xml(
                     'select count(*) as c from public.' || quote_ident(m.t),
                     false, false, '')))[1]::text::bigint end as c
    from mine m
),
cnt as (select t, c from n),
ask as (
  -- One guarded way to run a scalar query against a table that might
  -- not exist, used by everything below that needs more than a count.
  select null::text as unused
),
results as (

-- ---- 1. the database itself -----------------------------------------
select 10 as ord, 'Schema is complete' as item,
  case when (select count(*) from n where c is null) = 0
        and (select count(*) from myfns f
              where not exists (select 1 from pg_proc p
                                  join pg_namespace ns on ns.oid = p.pronamespace
                                 where ns.nspname = 'public' and p.proname = f.f)) = 0
    then 'GO' else 'FIX' end as verdict,
  case when (select count(*) from n where c is null) = 0
    then 'all ten tables and all six functions are here'
    else 'missing: ' || coalesce((select string_agg(t, ', ' order by t) from n where c is null),
                                 'functions') || ' — re-run schema.sql' end as detail

union all
select 11, 'Two scorers saving at once cannot deadlock',
  case when (select prosrc from pg_proc
              where proname = 'refresh_guts_public'
                and pronamespace = 'public'::regnamespace) like '%pg_advisory_xact_lock%'
    then 'GO' else 'FIX' end,
  case when (select prosrc from pg_proc
              where proname = 'refresh_guts_public'
                and pronamespace = 'public'::regnamespace) like '%pg_advisory_xact_lock%'
    then 'the public-board rebuild takes a lock before it touches a row'
    else 'the rebuild does not take a lock, so two saves landing together can'
         || ' deadlock and one scorer loses the save — re-run schema.sql' end

union all
select 12, 'Row level security is on everywhere',
  case when (select count(*) from pg_class c
               join pg_namespace ns on ns.oid = c.relnamespace
               join mine m on m.t = c.relname
              where ns.nspname = 'public' and c.relrowsecurity) = 10
    then 'GO' else 'FIX' end,
  (select count(*)::text from pg_class c
     join pg_namespace ns on ns.oid = c.relnamespace
     join mine m on m.t = c.relname
    where ns.nspname = 'public' and c.relrowsecurity) || ' of 10 tables protected'

union all
select 13, 'Live updates reach every screen',
  case when (select count(*) from pg_publication_tables p
               join mine m on m.t = p.tablename
              where p.pubname = 'supabase_realtime' and p.schemaname = 'public') = 10
    then 'GO' else 'FIX' end,
  (select count(*)::text from pg_publication_tables p
     join mine m on m.t = p.tablename
    where p.pubname = 'supabase_realtime' and p.schemaname = 'public')
  || ' of 10 tables published'

union all
select 14, 'Nothing foreign is in this database',
  case when (select count(*) from pg_class c
               join pg_namespace ns on ns.oid = c.relnamespace
              where ns.nspname = 'public' and c.relkind in ('r','p','v','m')
                and c.relname not in (select t from mine)
                and not exists (select 1 from pg_depend d
                                 where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                   and d.deptype = 'e')) = 0
    then 'GO' else 'LOOK' end,
  coalesce((select 'tables that are not this contest''s: '
                   || string_agg(c.relname, ', ' order by c.relname)
                   || ' — see whatran.sql'
              from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
             where ns.nspname = 'public' and c.relkind in ('r','p','v','m')
               and c.relname not in (select t from mine)
               and not exists (select 1 from pg_depend d
                                where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                  and d.deptype = 'e')),
           'only the ten tables this contest owns')

-- ---- 2. who can reach what -------------------------------------------
union all
select 20, 'Self-service sign-up is off',
  case when to_regclass('auth.users') is null then 'INFO'
       when (xpath('/table/row/c/text()', query_to_xml(
              'select count(*) as c from auth.users', false, false, '')))[1]::text::int <= 2
         then 'GO' else 'FIX' end,
  case when to_regclass('auth.users') is null
    then 'not a Supabase database — run this in the SQL Editor to see the accounts'
    else coalesce((xpath('/table/row/e/text()', query_to_xml(
           'select string_agg(email, '', '' order by email) as e from auth.users',
           false, false, '')))[1]::text, 'none')
      || ' — more than the staff and admin logins means a stranger signed themselves up.'
      || ' Authentication -> Sign In / Providers -> Email -> Allow new users to sign up' end

union all
select 21, 'The published key reaches only the public board',
  case when (select count(*) from pg_policies
              where schemaname = 'public' and 'anon' = any(roles)) = 2
    then 'GO' else 'FIX' end,
  coalesce((select string_agg(tablename, ', ' order by tablename) from pg_policies
             where schemaname = 'public' and 'anon' = any(roles)), 'nothing')
  || ' — anything past guts_public and contest_state is readable by anyone with the site'

union all
select 22, 'The published key cannot call anything',
  case when to_regprocedure('public.refresh_guts_public()') is null
         or to_regprocedure('public.set_guts_frozen(boolean)') is null
         or to_regprocedure('public.release_stale_claims(int)') is null then 'FIX'
       when not has_function_privilege('anon', 'public.refresh_guts_public()', 'EXECUTE')
        and not has_function_privilege('anon', 'public.set_guts_frozen(boolean)', 'EXECUTE')
        and not has_function_privilege('anon', 'public.release_stale_claims(int)', 'EXECUTE')
    then 'GO' else 'FIX' end,
  case when to_regprocedure('public.refresh_guts_public()') is null
    then 'the functions are not here at all — re-run schema.sql'
    else 'refresh_guts_public, set_guts_frozen and release_stale_claims'
         || ' must all be closed to anon' end

union all
select 23, 'Only a director can change the answer key',
  case when exists (select 1 from pg_policies where schemaname = 'public'
                      and tablename = 'answer_key' and policyname = 'admin_write')
        and exists (select 1 from pg_policies where schemaname = 'public'
                      and tablename = 'answer_key' and policyname = 'staff_read')
        and exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname = 'public' and p.proname = 'is_admin')
    then 'GO' else 'FIX' end,
  'scorers read it, the admin account writes it — enforced here, not just in the browser'

-- ---- 3. is the contest actually loaded? -------------------------------
union all
select 30, 'The answer key is filled in',
  case when to_regclass('public.answer_key') is null then 'FIX'
       when (xpath('/table/row/c/text()', query_to_xml(
              'select count(*) as c from public.answer_key where answer is null',
              false, false, '')))[1]::text::int = 0 then 'GO' else 'FIX' end,
  case when to_regclass('public.answer_key') is null then 'there is no answer key table'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
    $q$select case when sum(gaps) = 0 then 'every problem is keyed'
              else sum(gaps) || ' still unset (' || string_agg(lbl || ' ' || gaps, ', '
                                                               order by lbl)
                        filter (where gaps > 0)
                   || '). Nothing scores until they are in — and entering them later'
                   || ' re-scores every sheet already marked, so a gap found mid-contest'
                   || ' is not a disaster' end as s
         from (select case when round = 'guts' then 'guts'
                           else 'individual ' || division end as lbl,
                      count(*) filter (where answer is null) as gaps
                 from public.answer_key group by 1) k
        having true$q$, false, false, '')))[1]::text, 'no answer key rows') end

union all
select 31, 'The participant list is loaded',
  case when (select c from cnt where t = 'roster') is null then 'FIX'
       when (select c from cnt where t = 'roster') = 0 then 'LOOK'
       else 'GO' end,
  case when (select c from cnt where t = 'roster') is null
    then 'there is no participant list table — re-run schema.sql'
    when (select c from cnt where t = 'roster') = 0
    then 'empty — names will be blank on the entry screen, which works but is slower'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
      $q$select sum(people) || ' on the list — '
              || string_agg(d || ': ' || people || ' in ' || teams || ' team(s)', ', ' order by d)
              as s
           from (select left(individual_id, 1) as d, count(*) as people,
                        count(distinct team) as teams
                   from public.roster group by left(individual_id, 1)) x
          having true$q$, false, false, '')))[1]::text, 'loaded') end

union all
select 32, 'Every team on the list is a sensible size',
  case when coalesce((select c from cnt where t = 'roster'), 0) = 0 then 'INFO'
       -- Fewer than four is ordinary: a team scores its best three, so a
       -- three is not handicapped. More than four, or fewer than three,
       -- is worth a look before the day rather than during it.
       when (xpath('/table/row/c/text()', query_to_xml(
              'select count(*) as c from (select team from public.roster
                 group by team having count(*) > 4 or count(*) < 3) x',
              false, false, '')))[1]::text::int = 0
         then 'GO' else 'LOOK' end,
  case when coalesce((select c from cnt where t = 'roster'), 0) = 0 then 'no list to check'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
      $q$select coalesce('not four: ' || string_agg(team || ' has ' || n, ', ' order by team)
              || '. A team of three is fine -- it scores its best three either way --'
              || ' but a fifth member can never count, and a two cannot field three',
              'every team has four') as s
           from (select team, count(*) as n from public.roster
                  group by team having count(*) <> 4) x$q$, false, false, '')))[1]::text,
      'every team has four') end

union all
select 33, 'Every ID on the list can be read',
  case when coalesce((select c from cnt where t = 'roster'), 0) = 0 then 'INFO'
       when (xpath('/table/row/c/text()', query_to_xml(
              $q$select count(*) as c from public.roster
                  where individual_id !~ '^[AB][0-9]{1,3}[1-9]$'$q$,
              false, false, '')))[1]::text::int = 0 then 'GO' else 'FIX' end,
  case when to_regclass('public.roster') is null then 'there is no participant list table'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
    $q$select coalesce('cannot be read as a contestant ID: '
            || string_agg(individual_id, ', ' order by individual_id),
            'every ID reads as division, team and member') as s
         from public.roster where individual_id !~ '^[AB][0-9]{1,3}[1-9]$'$q$,
    false, false, '')))[1]::text, 'no list to check') end

-- ---- 4. the clock and the settings -------------------------------------
union all
select 40, 'The clock is parked and the board is open',
  case when to_regclass('public.contest_state') is null then 'FIX'
       when (xpath('/table/row/c/text()', query_to_xml(
              'select (guts_running or guts_frozen)::int as c from public.contest_state
                where id = 1', false, false, '')))[1]::text::int = 0
         then 'GO' else 'LOOK' end,
  case when to_regclass('public.contest_state') is null then 'there is no contest state table'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
    $q$select 'guts ' || guts_duration / 60 || ' min, board freezes with '
            || freeze_minutes || ' min left, clock '
            || case when guts_running then 'RUNNING' else 'stopped' end
            || ', board ' || case when guts_frozen then 'FROZEN' else 'open' end as s
         from public.contest_state where id = 1$q$, false, false, '')))[1]::text,
    'no contest state row') end

union all
select 41, 'Scoring and the sign-in lists',
  case when to_regclass('public.app_settings') is null then 'FIX' else 'INFO' end,
  case when to_regclass('public.app_settings') is null then 'there is no settings table'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
    $q$select 'combined = individual x ' || individual_multiplier || ' + guts; '
            || coalesce(cardinality(string_to_array(nullif(admin_names, ''), chr(10))), 0)
            || ' director name(s) may open Admin; '
            || case when nullif(grader_names, '') is null
                    then 'any name may sign in with the staff password'
               else cardinality(string_to_array(grader_names, chr(10)))
                    || ' scorer name(s) may sign in' end as s
         from public.app_settings where id = 1$q$, false, false, '')))[1]::text,
    'no settings row') end

-- ---- 5. anything left over from a rehearsal ----------------------------
union all
select 50, 'Rehearsal data has been cleared out',
  case when coalesce((select c from cnt where t = 'contestants'), 0)
          + coalesce((select c from cnt where t = 'guts_answers'), 0)
          + coalesce((select c from cnt where t = 'teams'), 0) = 0
    then 'GO' else 'LOOK' end,
  case when coalesce((select c from cnt where t = 'contestants'), 0)
          + coalesce((select c from cnt where t = 'guts_answers'), 0)
          + coalesce((select c from cnt where t = 'teams'), 0) = 0
    then 'nothing scored yet — a clean start'
    else coalesce((select c from cnt where t = 'contestants'), 0) || ' answer sheets, '
      || coalesce((select c from cnt where t = 'guts_answers'), 0) || ' guts answers, '
      || coalesce((select c from cnt where t = 'teams'), 0) || ' teams already in here.'
      || ' If this was practice, Admin -> Erase everything before the contest'
  end

union all
select 51, 'No locks or scorers left hanging about',
  case when coalesce((select c from cnt where t = 'claims'), 0) = 0 then 'GO' else 'LOOK' end,
  coalesce((select c from cnt where t = 'claims'), 0) || ' sheet lock(s) and '
  || coalesce((select c from cnt where t = 'graders'), 0)
  || ' scorer(s) on the list. Locks clear themselves after two minutes'

-- ---- 6. will the free tier hold? ----------------------------------------
union all
select 60, 'Realtime messages, estimated for the day', 'INFO',
  (select
     'about ' || to_char(round(msgs / 1000.0) * 1000, 'FM999,999,999')
     || ' of the 2,000,000 a month (' || round(100.0 * msgs / 2000000.0)::int || '%)'
     || ' for ' || graders || ' scorers over ' || hours || ' hours'
     || ' — the two timers every tab runs are most of it, not anything anyone types'
   from (
     select s.graders, s.hours,
       -- presence every 60s and a lock renewed every 80s, each fanned
       -- out to every open portal; then the actual work.
       (s.hours * 60) * s.graders * s.graders
       + (s.hours * 3600 / 80) * s.graders * s.graders
       + coalesce((select c from cnt where t = 'roster'), 176) * 2 * s.graders
       + coalesce((select c from cnt where t = 'roster'), 176) * 1.4 * s.graders
       + coalesce(nullif((select c from cnt where t = 'roster'), 0), 176) / 4 * 28 * s.graders
       + coalesce(nullif((select c from cnt where t = 'roster'), 0), 176) / 4 * 7 * (s.graders + 3)
       as msgs
       from settings s) e)

union all
select 61, 'Egress, estimated for the day', 'INFO',
  (select 'about ' || round(mb)::int || ' MB of the 5,000 MB a month — '
          || 'one full load of this contest is ' || round(kb)::int || ' KB compressed'
     from (select
             (coalesce((select c from cnt where t = 'roster'), 176) * 0.055
              + coalesce(nullif((select c from cnt where t = 'roster'), 0), 176) / 4 * 0.135
              + 2)::numeric as kb,
             s.graders, s.hours from settings s) b,
          lateral (select (kb * (graders * hours * 12 + graders) / 1024)::numeric as mb) m)

union all
select 62, 'A free project pauses when nothing touches it', 'LOOK',
  'Supabase pauses a free project after about a week of inactivity, and waking it is'
  || ' a manual restore that takes a few minutes. Open the portal once in the week'
  || ' before the contest, and again the morning of, so it is awake when the room is.'
)
select item as "check", verdict, detail from results order by ord;
