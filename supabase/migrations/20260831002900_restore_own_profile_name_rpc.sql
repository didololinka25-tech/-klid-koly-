-- Obnova bezpečné změny vlastního zobrazovaného jména v databázích, ve kterých
-- nebyla historická migrace 01600 aplikována kompletně.

begin;

create or replace function public.update_own_profile_name(new_full_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  cleaned_name text := btrim(coalesce(new_full_name, ''));
begin
  if actor_id is null then
    raise exception 'Nejste přihlášeni.';
  end if;
  if not public.can_view_school_data() then
    raise exception 'Zobrazované jméno může měnit pouze schválený aktivní uživatel.';
  end if;
  if char_length(cleaned_name) < 2 or char_length(cleaned_name) > 100 then
    raise exception 'Zobrazované jméno musí mít 2 až 100 znaků.';
  end if;
  if cleaned_name ~ '[[:cntrl:]]' then
    raise exception 'Zobrazované jméno nesmí obsahovat řídicí znaky ani nové řádky.';
  end if;

  update public.profiles
  set full_name = cleaned_name,
      updated_at = now()
  where id = actor_id
    and active
    and access_role in ('cleaning_team', 'admin', 'visitor');

  if not found then
    raise exception 'Aktivní schválený profil nebyl nalezen.';
  end if;

  return cleaned_name;
end;
$$;

-- Profily se z klienta nadále přímo nemění. Role a další chráněná pole mají
-- vlastní administrátorská RPC; toto RPC přijímá pouze text nového jména.
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke all on function public.update_own_profile_name(text) from public, anon, authenticated;
grant execute on function public.update_own_profile_name(text) to authenticated;

comment on function public.update_own_profile_name(text) is
  'Mění pouze full_name aktivního schváleného profilu auth.uid(); nepřijímá ID uživatele ani autorizační pole.';

do $$
declare
  function_oid oid := to_regprocedure('public.update_own_profile_name(text)');
  function_source text;
begin
  if function_oid is null then
    raise exception 'RPC update_own_profile_name(text) nebylo vytvořeno.';
  end if;

  select pg_get_functiondef(function_oid) into function_source;

  if not exists (
    select 1 from pg_proc
    where oid = function_oid and prosecdef
  ) then
    raise exception 'RPC update_own_profile_name musí být SECURITY DEFINER.';
  end if;
  if position('auth.uid()' in function_source) = 0
     or position('set full_name = cleaned_name' in function_source) = 0 then
    raise exception 'RPC neověřuje auth.uid() nebo nemění očekávané pole full_name.';
  end if;
  if not has_function_privilege('authenticated', function_oid, 'EXECUTE')
     or has_function_privilege('anon', function_oid, 'EXECUTE') then
    raise exception 'Oprávnění RPC update_own_profile_name nejsou bezpečná.';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     or has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     or has_table_privilege('authenticated', 'public.profiles', 'DELETE') then
    raise exception 'Authenticated nesmí zapisovat do profiles přímo.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'RLS na profiles musí zůstat zapnuté.';
  end if;
end
$$;

commit;
