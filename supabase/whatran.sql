-- =====================================================================
--  Did something else get run in this database?
--
--  Paste into the Supabase SQL Editor and RUN. Read-only: it changes
--  nothing, writes nothing, deletes nothing.
--
--  Use it when you are not sure whether a script meant for a different
--  project landed here. It answers three questions:
--
--    1. Is anything in this database that this contest never created?
--    2. Is anything missing, or emptied, that should be here?
--    3. What statements has this database actually been asked to run?
--
--  Every row should say OK or INFO. A CHECK row is not proof of damage
--  -- it means "this is not what schema.sql builds, go and look".
--
--  Supabase keeps your own history too: SQL Editor -> the list in the
--  left sidebar. That shows what you pasted and when, and is worth
--  reading alongside this.
--
--  Every count below is taken through query_to_xml rather than named
--  directly, because a query that mentions a dropped table cannot even
--  be planned -- and a file that fails to run when a table is missing
--  is useless for the one case it exists to diagnose.
-- =====================================================================

with mine(t) as (
  values ('app_settings'),('contest_state'),('answer_key'),('teams'),
         ('contestants'),('guts_answers'),('claims'),('graders'),('guts_public'),
         ('roster')
),
myfns(f) as (
  values ('refresh_guts_public'),('guts_public_trigger'),('set_guts_frozen'),
         ('touch_updated_at'),('is_admin'),('release_stale_claims')
),
mytrg(g) as (
  values ('guts_answers_public'),('answer_key_public'),('teams_public'),
         ('teams_touch'),('contestants_touch'),('guts_answers_touch'),
         ('answer_key_touch')
),
-- Extension-owned functions are neither ours nor strays: pgcrypto alone
-- puts about forty into whichever schema it was installed in.
extension_fns as (
  select objid from pg_depend where classid = 'pg_proc'::regclass and deptype = 'e'
),
-- Only public is this contest's business. Supabase's own schemas --
-- auth, storage, realtime, cron -- carry triggers and functions of their
-- own, and calling those strays would send you hunting something that
-- was always meant to be there. The table name is carried along because
-- one trigger name on six tables is six findings, not one.
stray_triggers as (
  select c.relname || '.' || t.tgname as who
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal
     and n.nspname = 'public'
     and t.tgname not in (select g from mytrg)
),
strays as (
  select c.relname, c.relkind from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','p','v','m','f')
     and c.relname not in (select t from mine)
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid
                        and d.deptype = 'e')
),
-- Row counts, or null where the table is not there any more.
counts as (
  select m.t,
         case when to_regclass('public.' || m.t) is null then null
              else (xpath('/table/row/c/text()', query_to_xml(
                     'select count(*) as c from public.' || quote_ident(m.t),
                     false, false, '')))[1]::text::bigint
         end as n
    from mine m
),
n as (select t, n from counts),
-- Supabase installs pg_stat_statements into the extensions schema; some
-- projects have it in public. Resolve it once, and carry null when it is
-- nowhere, so the two rows that read it can say so instead of failing.
pgss as (
  select coalesce(to_regclass('extensions.pg_stat_statements'),
                  to_regclass('public.pg_stat_statements'))::text as rel
),
-- Rows left stranded by a table that was dropped underneath them.
orphans as (
  select
    case when to_regclass('public.contestants') is null
           or to_regclass('public.teams') is null then null
         else (xpath('/table/row/c/text()', query_to_xml(
                'select count(*) as c from public.contestants c
                  where not exists (select 1 from public.teams t where t.team = c.team)',
                false, false, '')))[1]::text::bigint end as sheets,
    case when to_regclass('public.guts_answers') is null
           or to_regclass('public.teams') is null then null
         else (xpath('/table/row/c/text()', query_to_xml(
                'select count(*) as c from public.guts_answers g
                  where not exists (select 1 from public.teams t where t.team = g.team)',
                false, false, '')))[1]::text::bigint end as guts
),
-- A stray table is reachable by the published key if row level security
-- is off, or if it is on but a policy lets anon in.
exposed as (
  select s.relname,
         case when not c.relrowsecurity then 'row level security is off'
              else 'a policy lets anon in' end as why
    from strays s
    join pg_class c on c.relname = s.relname
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where s.relkind in ('r','p')
     -- has_table_privilege raises on a role that is not there, and this
     -- file has to survive being run somewhere that is not Supabase.
     and exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', c.oid, 'SELECT')
     and (not c.relrowsecurity
          or exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = s.relname
                        and 'anon' = any(p.roles)))
),
results as (

-- 1. here, and should not be ---------------------------------------------
select 1 as ord, 'Tables that this contest did not create' as item,
  case when (select count(*) from strays) = 0 then 'OK' else 'CHECK' end as status,
  coalesce((select string_agg(relname || case when relkind in ('v','m') then ' (view)'
                                              else '' end, ', ' order by relname)
              from strays),
           'none -- only the ten this contest owns') as detail

union all
select 2, 'Functions that this contest did not create',
  case when (select count(*) from pg_proc p
               join pg_namespace n2 on n2.oid = p.pronamespace
              where n2.nspname = 'public'
                and p.proname not in (select f from myfns)
                and p.oid not in (select objid from extension_fns)) = 0
    then 'OK' else 'CHECK' end,
  coalesce((select string_agg(distinct p.proname, ', ' order by p.proname)
              from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
             where n2.nspname = 'public'
               and p.proname not in (select f from myfns)
               and p.oid not in (select objid from extension_fns)),
           'none -- only the six this contest owns')

union all
select 3, 'Triggers on public tables that this contest did not create',
  case when (select count(*) from stray_triggers) = 0 then 'OK' else 'CHECK' end,
  coalesce((select string_agg(who, ', ' order by who) from stray_triggers),
           'none -- only the seven this contest owns')

-- 2. should be here, and is not -------------------------------------------
union all
select 4, 'Tables missing',
  case when (select count(*) from n where n is null) = 0 then 'OK' else 'CHECK' end,
  coalesce(nullif((select string_agg(t, ', ' order by t) from n where n is null), ''),
           'none -- all ten present')

union all
select 5, 'Functions and triggers missing',
  case when (select count(*) from myfns f
              where not exists (select 1 from pg_proc p
                                  join pg_namespace n2 on n2.oid = p.pronamespace
                                 where n2.nspname = 'public' and p.proname = f.f)) = 0
   and (select count(*) from mytrg g
         where not exists (select 1 from pg_trigger
                            where not tgisinternal and tgname = g.g)) = 0
    then 'OK' else 'CHECK' end,
  coalesce(nullif(concat_ws(', ',
    (select string_agg(f.f, ', ' order by f.f) from myfns f
      where not exists (select 1 from pg_proc p
                          join pg_namespace n2 on n2.oid = p.pronamespace
                         where n2.nspname = 'public' and p.proname = f.f)),
    (select string_agg(g.g, ', ' order by g.g) from mytrg g
      where not exists (select 1 from pg_trigger
                         where not tgisinternal and tgname = g.g))), ''),
    'none -- and re-running schema.sql restores any of these anyway')

-- 3. the fingerprint a wrong paste leaves ---------------------------------
-- The one dangerous script that names this contest's tables is the
-- clean-up block at the bottom of schema.sql, meant for reusing the old
-- proof-grading project:
--
--   drop table if exists grades, guts, claims, graders, teams,
--                        app_settings cascade;
--
-- Four of those six names belong to this contest as well. Run here, it
-- takes teams, claims, graders and the settings while leaving the answer
-- sheets and guts answers standing -- and sheets without their teams
-- cannot happen any other way, so it is a fingerprint rather than a
-- guess.
union all
select 6, 'Answer sheets whose team row is gone',
  case when (select sheets from orphans) is null then 'CHECK'
       when (select sheets from orphans) = 0 then 'OK' else 'CHECK' end,
  case when (select sheets from orphans) is null
         then 'cannot tell -- contestants or teams is missing entirely'
       when (select sheets from orphans) = 0
         then 'none -- every sheet still has its team'
       else (select sheets from orphans)::text
            || ' sheets whose team is gone. Something dropped the teams table' end

union all
select 7, 'Guts answers whose team row is gone',
  case when (select guts from orphans) is null then 'CHECK'
       when (select guts from orphans) = 0 then 'OK' else 'CHECK' end,
  case when (select guts from orphans) is null
         then 'cannot tell -- guts_answers or teams is missing entirely'
       when (select guts from orphans) = 0
         then 'none -- every guts answer still has its team'
       else (select guts from orphans)::text || ' answers whose team is gone' end

union all
select 8, 'Settings still say what you set them to',
  case when to_regclass('public.app_settings') is null then 'CHECK' else 'INFO' end,
  case when to_regclass('public.app_settings') is null then 'the settings table is gone'
    else coalesce((xpath('/table/row/s/text()', query_to_xml(
      $q$select 'admin account ' || admin_email
              || ', combined = individual x ' || individual_multiplier
              || ', ' || coalesce(cardinality(string_to_array(nullif(admin_names,''),
                                              chr(10))), 0)
              || ' director name(s) on the list' as s
           from public.app_settings where id = 1$q$, false, false, '')))[1]::text,
      'the settings row itself is gone') end

-- 4. what this database has actually been asked to run --------------------
-- pg_stat_statements is on by default in Supabase and remembers the
-- shape of every statement run since it was last reset. It is the
-- closest thing to a receipt.
union all
select 9, 'Statements that dropped, truncated or altered something', 'INFO',
  case when (select rel from pgss) is null
    then 'pg_stat_statements not available here -- read the SQL Editor history instead'
    else coalesce((xpath('/table/row/c/text()', query_to_xml(
           'select count(*) as c from ' || (select rel from pgss) ||
           ' where query ~* ''^\s*(drop|truncate|alter)\s''', false, false, '')))[1]::text,
         '0') || ' remembered -- the next row lists the destructive ones' end

union all
select 10, 'The destructive ones, most-run first', 'INFO',
  case when (select rel from pgss) is null
    then 'SQL Editor -> the query list in the left sidebar is your own history'
    else coalesce((xpath('/table/row/q/text()', query_to_xml(
           'select coalesce(string_agg(left(regexp_replace(query, ''\s+'', '' '', ''g''), 90),
                            '' | '' order by calls desc), ''none so far'') as q
              from (select query, calls from ' || (select rel from pgss) ||
           '     where query ~* ''^\s*(drop|truncate)\s''
                 order by calls desc limit 8) top', false, false, '')))[1]::text,
         'none so far') end

-- 5. can the published key read what does not belong here? -----------------
-- The anon key ships with the site, so anything in public that anon can
-- reach is readable by anyone who views the page. That is fine for this
-- contest's two public tables and is exactly what row level security is
-- there to stop everywhere else -- but a stray table from another
-- project arrives under its own rules, not ours.
union all
select 10.5, 'Stray tables the published key can read',
  case when (select count(*) from exposed) = 0 then 'OK' else 'CHECK' end,
  coalesce((select string_agg(relname || ' (' || why || ')', ', ' order by relname)
              from exposed),
           'none -- nothing foreign is reachable with the anon key')

-- 6. what is in there right now --------------------------------------------
union all
select 11, 'Data on hand', 'INFO',
  concat_ws(', ',
    coalesce((select n::text from n where t = 'teams'), '(no teams table)') || ' teams',
    coalesce((select n::text from n where t = 'contestants'), '(no table)') || ' answer sheets',
    coalesce((select n::text from n where t = 'guts_answers'), '(no table)') || ' guts answers',
    coalesce((select n::text from n where t = 'roster'), '(no table)') || ' roster rows',
    coalesce((select n::text from n where t = 'answer_key'), '(no table)') || ' answer key rows')
)
select item, status, detail from results order by ord;
