-- =====================================================================
--  Change the staff and admin passwords
--
--  Why this is SQL: the two accounts have made-up addresses
--  (staff@sfpo.local, admin@sfpo.local), so the dashboard's "Send
--  password recovery" emails an inbox that does not exist, and Studio
--  has no box for typing a new password in directly. This sets them in
--  the database, the same way Supabase Auth stores them.
--
--  1. Put the two new passwords between the quotes on the marked line.
--  2. Run.
--  3. Read the result. If both say "changed", you are done.
--  4. Delete this snippet from the SQL Editor sidebar -- it now has the
--     passwords in it.
--
--  It changes both or neither: if either password fails a check below,
--  nothing is touched and the result says why. Everyone currently signed
--  in with the old passwords is signed out, so the old ones stop working
--  now rather than whenever their browser next refreshes. Do this before
--  the contest, not during it.
--
--  The checks:
--    * at least 12 characters -- four short words is plenty, and easier
--      to write on twenty cards than a scramble;
--    * the two must differ -- if they matched, a scorer could type the
--      staff password into the admin box and open Admin;
--    * no spaces at either end -- a password pasted with a trailing
--      space is one nobody can ever type again.
--
--  Written as one statement with each password typed once, and with the
--  checks as conditions rather than errors, for two reasons: nothing is
--  ever half-changed, and nothing fails -- a failed statement is copied
--  into the database log with the passwords in it. Postgres's own
--  statistics store this statement with the passwords replaced by $1
--  and $2, so they do not end up there either.
-- =====================================================================

-- Wherever pgcrypto lives on this project, crypt() below will find it.
set search_path = public, extensions;

with pw(staff, admin) as (
  values ('PUT-THE-NEW-STAFF-PASSWORD-HERE', 'PUT-THE-NEW-ADMIN-PASSWORD-HERE')
  --      ^ staff: every scorer               ^ admin: directors only
),
problem as (
  select case
    when staff like 'PUT-THE-NEW-%' or admin like 'PUT-THE-NEW-%'
      then 'Put the new passwords between the quotes first.'
    when staff <> btrim(staff) or admin <> btrim(admin)
      then 'One of them starts or ends with a space. Take it out -- nobody could type it.'
    when length(staff) < 12 or length(admin) < 12
      then 'Use at least 12 characters for each. Four short words will do.'
    when staff = admin
      then 'The two must differ, or a scorer could open Admin with the staff password.'
  end as why
  from pw
),
ok as (
  select staff, admin from pw where (select why from problem) is null
),
staff_done as (
  update auth.users u
     set encrypted_password = crypt(ok.staff, gen_salt('bf', 10)),
         updated_at = now()
    from ok
   where u.email = 'staff@sfpo.local'
  returning u.id
),
admin_done as (
  update auth.users u
     set encrypted_password = crypt(ok.admin, gen_salt('bf', 10)),
         updated_at = now()
    from ok
   where u.email = 'admin@sfpo.local'
  returning u.id
),
-- Only the accounts that actually changed, and only if they did.
signed_out as (
  delete from auth.sessions s
   where s.user_id in (select id from staff_done union all select id from admin_done)
  returning 1
)
select 'Staff password' as "what",
       case when exists (select 1 from staff_done) then 'CHANGED'
            else 'not changed' end as "result",
       coalesce((select why from problem),
                case when exists (select 1 from staff_done)
                     then 'scorers type the new one in the first box'
                     else 'there is no staff@sfpo.local account to change' end) as "detail"
union all
select 'Admin password',
       case when exists (select 1 from admin_done) then 'CHANGED' else 'not changed' end,
       coalesce((select why from problem),
                case when exists (select 1 from admin_done)
                     then 'directors type the new one in the second box'
                     else 'there is no admin@sfpo.local account to change' end)
union all
select 'Signed out',
       (select count(*) from signed_out)::text || ' session(s)',
       case when (select count(*) from signed_out) > 0
            then 'anyone signed in with an old password is out within the hour'
            else 'nobody was signed in, or nothing changed' end
union all
select 'Now',
       case when exists (select 1 from staff_done) and exists (select 1 from admin_done)
            then 'done' else 'nothing was changed' end,
       case when exists (select 1 from staff_done) and exists (select 1 from admin_done)
            then 'Delete this snippet from the SQL Editor sidebar. Write the staff password'
                 || ' on the scorer cards by hand; never put it in the repo.'
            else 'Fix the line above and run it again.' end;
