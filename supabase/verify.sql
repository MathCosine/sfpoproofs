-- =====================================================================
--  Is this database up to date?
--
--  Paste into the Supabase SQL Editor and RUN. Read-only: it changes
--  nothing. Every row should say OK.
--
--  Any FAIL means re-run supabase/schema.sql — it is idempotent and
--  migrates in place, so nothing you have entered is lost.
-- =====================================================================

with expected_tables(t) as (
  values ('app_settings'),('contest_state'),('answer_key'),('teams'),
         ('contestants'),('guts_answers'),('claims'),('graders'),('guts_public')
),
results as (

-- 1. every table present -----------------------------------------------
select 1 as ord, 'Tables present' as item,
  case when (select count(*) from expected_tables e
             where exists (select 1 from information_schema.tables i
               where i.table_schema='public' and i.table_name=e.t)) = 9
       then 'OK' else 'FAIL' end as status,
  coalesce(nullif((select string_agg(e.t, ', ' order by e.t) from expected_tables e
     where not exists (select 1 from information_schema.tables i
       where i.table_schema='public' and i.table_name=e.t)), ''),
    'all nine') as detail

-- 2. the answer key is split by division -------------------------------
union all
select 2, 'Answer key has a division column',
  case when exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='answer_key' and column_name='division')
    then 'OK' else 'FAIL' end,
  'Added when the two divisions got separate individual papers'

union all
select 3, 'Answer key is keyed per division',
  case when (select count(*) from information_schema.key_column_usage
      where table_schema='public' and constraint_name='answer_key_pkey') = 3
    then 'OK' else 'FAIL' end,
  'Primary key should be (round, division, problem)'

union all
select 4, 'Answer key rows seeded',
  case when (select count(*) from answer_key where round='individual' and division='A') >= 20
        and (select count(*) from answer_key where round='individual' and division='B') >= 20
        and (select count(*) from answer_key where round='guts' and division='*') >= 28
    then 'OK' else 'FAIL' end,
  (select count(*) filter (where round='individual' and division='A') || ' A, '
        || count(*) filter (where round='individual' and division='B') || ' B, '
        || count(*) filter (where round='guts') || ' guts' from answer_key)

-- 3. the public board carries set progress -----------------------------
union all
select 5, 'Public board has set_mask',
  case when exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='guts_public' and column_name='set_mask')
    then 'OK' else 'FAIL' end,
  'Drives the seven-segment bars on the projector board'

-- 4. security -----------------------------------------------------------
union all
select 6, 'Row level security on every table',
  case when (select count(*) from pg_class c
     join pg_namespace n on n.oid=c.relnamespace
     join expected_tables e on e.t=c.relname
    where n.nspname='public' and c.relrowsecurity) = 9
    then 'OK' else 'FAIL' end,
  (select count(*)::text from pg_class c
     join pg_namespace n on n.oid=c.relnamespace
     join expected_tables e on e.t=c.relname
    where n.nspname='public' and c.relrowsecurity) || ' of 9 protected'

union all
select 7, 'Anonymous can read only the board and the clock',
  case when (select count(*) from pg_policies
      where schemaname='public' and 'anon' = any(roles)) = 2
    then 'OK' else 'FAIL' end,
  coalesce((select string_agg(tablename, ', ' order by tablename) from pg_policies
    where schemaname='public' and 'anon' = any(roles)), 'none') ||
    ' — anything beyond guts_public and contest_state is a leak'

union all
select 8, 'Anonymous cannot call the functions',
  case when not has_function_privilege('anon','public.refresh_guts_public()','EXECUTE')
        and not has_function_privilege('anon','public.set_guts_frozen(boolean)','EXECUTE')
        and not has_function_privilege('anon','public.release_stale_claims(int)','EXECUTE')
    then 'OK' else 'FAIL' end,
  'EXECUTE should be revoked from anon on all three'

-- 5. live updates -------------------------------------------------------
union all
select 9, 'Realtime publishes every table',
  case when (select count(*) from pg_publication_tables p
     join expected_tables e on e.t=p.tablename
    where p.pubname='supabase_realtime' and p.schemaname='public') = 9
    then 'OK' else 'FAIL' end,
  (select count(*)::text from pg_publication_tables p
     join expected_tables e on e.t=p.tablename
    where p.pubname='supabase_realtime' and p.schemaname='public') || ' of 9 published'

union all
select 10, 'Deletes carry their old row',
  case when (select count(*) from pg_class c
     join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relreplident='f'
      and c.relname in ('claims','contestants','guts_answers','guts_public')) = 4
    then 'OK' else 'FAIL' end,
  'Without this a released lock never clears on other screens'

union all
select 11, 'Public board rebuild triggers',
  case when (select count(*) from pg_trigger
    where tgname in ('guts_answers_public','answer_key_public','teams_public')
      and not tgisinternal) = 3
    then 'OK' else 'FAIL' end,
  'One each on guts_answers, answer_key and teams'

-- 6. the singleton rows --------------------------------------------------
union all
select 12, 'Settings and contest state rows exist',
  case when (select count(*) from app_settings where id=1) = 1
        and (select count(*) from contest_state where id=1) = 1
    then 'OK' else 'FAIL' end,
  (select 'guts ' || guts_duration/60 || ' min, freeze at ' || freeze_minutes
        || ' min, frozen: ' || guts_frozen from contest_state where id=1)

-- 7. what is actually in there ------------------------------------------
union all
select 13, 'Data on hand', 'INFO',
  (select count(*) from teams) || ' teams, ' ||
  (select count(*) from contestants) || ' answer sheets, ' ||
  (select count(*) from guts_answers) || ' guts answers, ' ||
  (select count(*) from guts_public) || ' board rows'

union all
select 14, 'Answer key still to fill', 'INFO',
  (select count(*) filter (where answer is null) || ' of ' || count(*)
     || ' answers unset' from answer_key)
)
select item, status, detail from results order by ord;
