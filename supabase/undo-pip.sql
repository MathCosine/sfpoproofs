-- =====================================================================
--  Take the "pip" tables back out of the contest project
--
--  For the case where pip's schema was pasted into this project's SQL
--  Editor by mistake. It only ever added things -- no contest table,
--  function or row was touched -- so undoing it is a matter of removing
--  what it put here.
--
--  Paste into the SQL Editor and RUN. What it removes:
--
--    tables     lists, tags, tasks, blocks, logs, prefs
--               (and with them their triggers, indexes, policies, the
--                foreign keys to auth.users, and their places in the
--                supabase_realtime publication)
--    functions  pip_stamp, pip_sweep, pip_delete_me -- whichever exist
--
--  What it will not do:
--
--  * It will not touch anything this contest owns. The ten contest
--    tables and six contest functions are listed below and checked
--    against the removal list before a single statement runs.
--  * It will not quietly throw away data. If any pip table still holds
--    rows it stops, names them, and changes nothing. Read the numbers,
--    and only if you are sure that data is not wanted, change the first
--    line to 'yes' and run it again.
--  * It will not guess. Anything else foreign in this database is left
--    alone and printed at the end, with the source of any function, so
--    you can decide with your eyes open.
--
--  Safe to run more than once, and safe to run when pip was never here:
--  with nothing to remove it removes nothing and says so.
-- =====================================================================

-- 'no' stops if any pip table still holds rows. 'yes' drops them anyway.
set pip.force = 'no';

do $$
declare
  -- Nothing on this list may ever be dropped by this file.
  contest_tables text[] := array['app_settings','contest_state','answer_key','teams',
                                 'contestants','guts_answers','claims','graders',
                                 'guts_public','roster'];
  contest_fns    text[] := array['refresh_guts_public','guts_public_trigger',
                                 'set_guts_frozen','touch_updated_at','is_admin',
                                 'release_stale_claims'];
  pip_tables     text[] := array['lists','tags','tasks','blocks','logs','prefs'];
  pip_fns        text[] := array['pip_stamp','pip_sweep','pip_delete_me'];
  t text;
  n bigint;
  total bigint := 0;
  holding text := '';
  found_tables int := 0;
  found_fns int := 0;
  fn record;
begin
  -- A typo in either list above could turn this file into the very
  -- thing it is cleaning up after, so the two lists are checked against
  -- each other before anything is dropped.
  if pip_tables && contest_tables then
    raise exception 'refusing to run: % is on both lists',
      array_to_string(array(select unnest(pip_tables) intersect select unnest(contest_tables)), ', ');
  end if;
  if pip_fns && contest_fns then
    raise exception 'refusing to run: function % is on both lists',
      array_to_string(array(select unnest(pip_fns) intersect select unnest(contest_fns)), ', ');
  end if;

  -- Is there anything in them? Counted before anything is dropped, so
  -- the answer is still true when it is acted on.
  foreach t in array pip_tables loop
    if to_regclass('public.' || t) is not null then
      found_tables := found_tables + 1;
      execute format('select count(*) from public.%I', t) into n;
      total := total + n;
      if n > 0 then holding := holding || t || ' (' || n || ' rows), '; end if;
    end if;
  end loop;

  if total > 0 and coalesce(current_setting('pip.force', true), 'no') <> 'yes' then
    raise exception E'pip tables still hold data: %\n'
      '  Nothing has been changed. If that data matters, copy it out first --\n'
      '  it belongs in pip''s own project, not this one. If it does not matter,\n'
      '  change the first line of this file to  set pip.force = ''yes'';  and run again.',
      rtrim(holding, ', ');
  end if;

  -- Tables first: cascade takes their triggers, indexes, policies, the
  -- foreign keys into auth.users and their membership of the realtime
  -- publication with them, which leaves the functions with nothing
  -- depending on them.
  foreach t in array pip_tables loop
    -- Only the ones that are actually there, so running this a second
    -- time is silent rather than six lines of "does not exist".
    if to_regclass('public.' || t) is not null then
      execute format('drop table public.%I cascade', t);
    end if;
  end loop;

  -- Then the functions, by their real signatures rather than a guessed
  -- one, so an older pip with different arguments is still matched. No
  -- cascade: if something unexpected still depends on one of these, the
  -- right outcome is a loud stop, not a silent removal.
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = any(pip_fns)
  loop
    execute format('drop function if exists %s', fn.sig);
    found_fns := found_fns + 1;
  end loop;

  if found_tables = 0 and found_fns = 0 then
    raise notice 'pip was not in this database. Nothing to remove.';
  else
    raise notice 'Removed % pip table(s) and % pip function(s).', found_tables, found_fns;
  end if;
end $$;

-- What the database looks like now. Anything still listed here is
-- something this file was not sure enough about to remove on its own.
with mine(t) as (
  values ('app_settings'),('contest_state'),('answer_key'),('teams'),
         ('contestants'),('guts_answers'),('claims'),('graders'),('guts_public'),
         ('roster')
),
myfns(f) as (
  values ('refresh_guts_public'),('guts_public_trigger'),('set_guts_frozen'),
         ('touch_updated_at'),('is_admin'),('release_stale_claims')
),
leftovers as (
  select c.relname as name, 'table' as kind, '' as body
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p','v','m')
     and c.relname not in (select t from mine)
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                       and d.objid = c.oid and d.deptype = 'e')
  union all
  -- The full signature, so removing one by hand afterwards is a
  -- copy-paste rather than a guess, and enough of the source to see
  -- what it was for before you do.
  select p.oid::regprocedure::text, 'function',
         left(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'), 200)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname not in (select f from myfns)
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                       and d.objid = p.oid and d.deptype = 'e')
),
results as (
  select 1 as ord, 'The contest' as item,
    case when (select count(*) from mine m where to_regclass('public.' || m.t) is null) = 0
      then 'OK' else 'CHECK' end as status,
    case when (select count(*) from mine m where to_regclass('public.' || m.t) is null) = 0
      then 'all ten tables still here, untouched'
      else 'MISSING: ' || (select string_agg(m.t, ', ') from mine m
                            where to_regclass('public.' || m.t) is null) end as detail
  union all
  select 2, 'pip',
    case when (select count(*) from leftovers
                where split_part(name, '(', 1) in ('lists','tags','tasks','blocks',
                        'logs','prefs','pip_stamp','pip_sweep','pip_delete_me')) = 0
      then 'OK' else 'CHECK' end,
    coalesce((select string_agg(name, ', ' order by name) from leftovers
               where split_part(name, '(', 1) in ('lists','tags','tasks','blocks',
                       'logs','prefs','pip_stamp','pip_sweep','pip_delete_me')),
             'gone -- nothing of pip''s is left in this database')
  union all
  select 3, 'Still here and not ours -- have a look before removing it',
    case when (select count(*) from leftovers
                where split_part(name, '(', 1) not in ('lists','tags','tasks','blocks',
                        'logs','prefs','pip_stamp','pip_sweep','pip_delete_me')) = 0
      then 'OK' else 'INFO' end,
    coalesce((select string_agg(kind || ' ' || name ||
                                case when body = '' then '' else ' -- ' || body end,
                                E'\n' order by name)
                from leftovers
               where split_part(name, '(', 1) not in ('lists','tags','tasks','blocks',
                       'logs','prefs','pip_stamp','pip_sweep','pip_delete_me')),
             'nothing -- only the contest is in here now')
)
select item, status, detail from results order by ord;
