-- Auth refresh nesmí přepsat uživatelem zvolené zobrazované jméno hodnotou
-- z Google metadata. Nový profil metadata použije pouze při prvním založení.
begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (
    id, full_name, email, role, access_role, active, last_signed_in_at
  ) values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, ''), '@', 1), 'Nový uživatel'),
    new.email,
    'cleaner',
    'pending',
    true,
    coalesce(new.last_sign_in_at, now())
  )
  on conflict (id) do update
  set full_name = coalesce(nullif(btrim(profiles.full_name), ''), excluded.full_name),
      email = excluded.email,
      last_signed_in_at = excluded.last_signed_in_at;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email, last_sign_in_at, raw_user_meta_data on auth.users
for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;

comment on function public.handle_new_user() is
  'Synchronizuje email a poslední přihlášení; existující neprázdné profiles.full_name zachovává.';

do $$
declare
  function_oid oid := to_regprocedure('public.handle_new_user()');
  source text;
begin
  if function_oid is null then
    raise exception 'handle_new_user() neexistuje.';
  end if;
  select pg_get_functiondef(function_oid) into source;
  if position('coalesce(nullif(btrim(profiles.full_name), ''''), excluded.full_name)' in source) = 0 then
    raise exception 'Auth synchronizace nezachovává vlastní zobrazované jméno.';
  end if;
  if position('set full_name = excluded.full_name' in source) > 0 then
    raise exception 'Auth synchronizace stále bezpodmínečně přepisuje full_name.';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'on_auth_user_updated'
      and not tgisinternal
      and tgenabled <> 'D'
  ) then
    raise exception 'Trigger on_auth_user_updated není aktivní.';
  end if;
  if not (select prosecdef from pg_proc where oid = function_oid) then
    raise exception 'handle_new_user() musí zůstat SECURITY DEFINER.';
  end if;
end
$$;

commit;
