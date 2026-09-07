-- Bezpečný společný onboarding. Úklid nadále používá profiles.access_role,
-- Jídelna používá user_module_roles; tento RPC oba modely mění atomicky.
begin;

create table public.user_access_approval_events (
  id bigint generated always as identity primary key,
  target_user_id uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid not null references public.profiles(id) on delete restrict,
  assignments jsonb not null check (
    jsonb_typeof(assignments) = 'array' and jsonb_array_length(assignments) > 0
  ),
  occurred_at timestamptz not null default now()
);

create index user_access_approval_events_target_time_idx
  on public.user_access_approval_events (target_user_id, occurred_at desc);
create index user_access_approval_events_actor_time_idx
  on public.user_access_approval_events (approved_by, occurred_at desc);

alter table public.user_access_approval_events enable row level security;
revoke all on table public.user_access_approval_events from public, anon, authenticated;
revoke all on sequence public.user_access_approval_events_id_seq from public, anon, authenticated;
grant select on table public.user_access_approval_events to authenticated;

-- Modulové role se po této migraci nepřidělují přímým Data API zápisem.
-- Čtení zůstává podle stávajícího RLS, zápis provádí pouze kontrolované RPC.
revoke insert, delete on table public.user_module_roles from authenticated;

create policy "owner reads access approval audit"
on public.user_access_approval_events
for select
to authenticated
using ((select public.is_owner()));

create or replace function private.prevent_last_active_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_owner
     and old.active
     and old.access_role = 'admin'
     and (
       tg_op = 'DELETE'
       or not new.is_owner
       or not new.active
       or new.access_role <> 'admin'
     )
     and not exists (
       select 1
       from public.profiles profile
       where profile.id <> old.id
         and profile.is_owner
         and profile.active
         and profile.access_role = 'admin'
     ) then
    raise exception 'Posledního hlavního správce nelze odebrat ani deaktivovat.'
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.prevent_last_active_owner() from public, anon, authenticated;

drop trigger if exists profiles_prevent_last_active_owner on public.profiles;
create trigger profiles_prevent_last_active_owner
before update of is_owner, active, access_role or delete on public.profiles
for each row execute function private.prevent_last_active_owner();

create or replace function public.school_pending_access_users()
returns table (
  user_id uuid,
  full_name text,
  email text,
  first_signed_in_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null or not exists (
    select 1
    from public.profiles actor
    where actor.id = actor_id
      and actor.active
      and actor.is_owner
      and actor.access_role = 'admin'
  ) then
    raise exception 'Čekající uživatele může zobrazit pouze hlavní správce.'
      using errcode = '42501';
  end if;

  return query
  select profile.id,
         profile.full_name,
         profile.email,
         profile.first_signed_in_at
  from public.profiles profile
  where profile.active
    and profile.access_role = 'pending'
    and not exists (
      select 1
      from public.user_module_roles module_role
      where module_role.user_id = profile.id
    )
  order by profile.first_signed_in_at, profile.id;
end;
$$;

create or replace function public.school_approve_user_access(
  target_user_id uuid,
  requested_assignments jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  target_profile public.profiles%rowtype;
  assignment jsonb;
  assignment_module text;
  assignment_role text;
  assignment_key text;
  assignment_family_id uuid;
  cleaning_role text := null;
  seen_assignments text[] := array[]::text[];
  canonical_assignments jsonb := '[]'::jsonb;
begin
  if actor_id is null or not exists (
    select 1
    from public.profiles actor
    where actor.id = actor_id
      and actor.active
      and actor.is_owner
      and actor.access_role = 'admin'
  ) then
    raise exception 'Uživatele může schválit pouze hlavní správce.'
      using errcode = '42501';
  end if;

  if target_user_id is null then
    raise exception 'Uživatel je povinný.' using errcode = '22023';
  end if;
  if target_user_id = actor_id then
    raise exception 'Sami sebe tímto formulářem schválit nemůžete.'
      using errcode = '42501';
  end if;
  if requested_assignments is null
     or jsonb_typeof(requested_assignments) <> 'array'
     or jsonb_array_length(requested_assignments) = 0
     or jsonb_array_length(requested_assignments) > 10 then
    raise exception 'Vyberte jednu až deset platných rolí.' using errcode = '22023';
  end if;

  select profile.*
  into target_profile
  from public.profiles profile
  where profile.id = target_user_id
  for update;

  if not found or not target_profile.active then
    raise exception 'Aktivní profil nebyl nalezen.' using errcode = '22023';
  end if;
  if target_profile.is_owner then
    raise exception 'Přístup hlavního správce nelze měnit schvalovacím formulářem.'
      using errcode = '42501';
  end if;
  if target_profile.access_role <> 'pending'
     or exists (
       select 1 from public.user_module_roles module_role
       where module_role.user_id = target_user_id
     ) then
    raise exception 'Uživatel už má přidělený přístup.' using errcode = '23505';
  end if;

  for assignment in
    select item.value
    from jsonb_array_elements(requested_assignments) with ordinality as item(value, position)
    order by item.position
  loop
    if jsonb_typeof(assignment) <> 'object' then
      raise exception 'Neplatný formát role.' using errcode = '22023';
    end if;

    assignment_module := assignment ->> 'module';
    assignment_role := assignment ->> 'role';
    assignment_key := concat_ws(':', assignment_module, assignment_role);

    if assignment_module = 'cafeteria' then
      if assignment_role not in ('parent', 'diner', 'kitchen', 'admin') then
        raise exception 'Neplatná role Jídelny.' using errcode = '22023';
      end if;
    elsif assignment_module = 'cleaning' then
      if assignment_role not in ('cleaning_team', 'visitor', 'admin') then
        raise exception 'Neplatná role Úklidu.' using errcode = '22023';
      end if;
      if cleaning_role is not null then
        raise exception 'Pro Úklid lze při schválení vybrat jen jednu roli.' using errcode = '22023';
      end if;
      cleaning_role := assignment_role;
    else
      raise exception 'Neplatný modul.' using errcode = '22023';
    end if;

    if assignment_key = any(seen_assignments) then
      raise exception 'Stejná role je ve formuláři vícekrát.' using errcode = '22023';
    end if;
    seen_assignments := array_append(seen_assignments, assignment_key);

    if assignment ? 'family_id' and nullif(assignment ->> 'family_id', '') is not null then
      if assignment_module <> 'cafeteria' or assignment_role <> 'parent' then
        raise exception 'Rodinu lze přiřadit pouze roli rodiče.' using errcode = '22023';
      end if;
      begin
        assignment_family_id := (assignment ->> 'family_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Neplatná rodina.' using errcode = '22023';
      end;
      if not exists (
        select 1 from public.cafeteria_families family
        where family.id = assignment_family_id and family.active
      ) then
        raise exception 'Vybraná rodina není aktivní.' using errcode = '22023';
      end if;
    else
      assignment_family_id := null;
    end if;

    canonical_assignments := canonical_assignments || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'module', assignment_module,
        'role', assignment_role,
        'family_id', assignment_family_id
      ))
    );

    if assignment_module = 'cafeteria' then
      insert into public.user_module_roles (user_id, module, role, created_by)
      values (target_user_id, 'cafeteria', assignment_role, actor_id);

      if assignment_role = 'parent' and assignment_family_id is not null then
        insert into public.cafeteria_family_users (
          family_id, user_id, active, valid_from, valid_to, created_by
        ) values (
          assignment_family_id, target_user_id, true, current_date, null, actor_id
        )
        on conflict (family_id, user_id, valid_from) do update
        set active = true,
            valid_to = null;
      end if;
    end if;
  end loop;

  if cleaning_role is not null then
    update public.profiles
    set access_role = cleaning_role,
        role = case
          when cleaning_role = 'admin' then 'caretaker'::public.app_role
          else 'cleaner'::public.app_role
        end
    where id = target_user_id;
  end if;

  insert into public.user_access_approval_events (
    target_user_id, approved_by, assignments
  ) values (
    target_user_id, actor_id, canonical_assignments
  );
end;
$$;

-- Legacy editor zůstává pro následnou správu už schváleného přístupu do
-- Úklidu. První schválení však musí projít atomickým a auditovaným RPC výše.
create or replace function public.owner_set_user_access(
  target_user_id uuid,
  new_access_role text,
  new_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  target_profile public.profiles%rowtype;
begin
  if actor_id is null or not exists (
    select 1 from public.profiles actor
    where actor.id = actor_id
      and actor.active
      and actor.is_owner
      and actor.access_role = 'admin'
  ) then
    raise exception 'Role uživatelů může měnit pouze hlavní správce.'
      using errcode = '42501';
  end if;
  if new_access_role is null or new_access_role not in ('pending', 'cleaning_team', 'admin', 'visitor') then
    raise exception 'Neplatná role.' using errcode = '22023';
  end if;
  if new_active is null then
    raise exception 'Stav aktivního účtu musí být vyplněn.' using errcode = '22023';
  end if;

  select profile.* into target_profile
  from public.profiles profile
  where profile.id = target_user_id
  for update;
  if not found then
    raise exception 'Profil nebyl nalezen.' using errcode = '22023';
  end if;
  if target_profile.is_owner then
    raise exception 'Hlavní správce nemůže tímto formulářem změnit vlastní přístup.'
      using errcode = '42501';
  end if;
  if target_profile.active
     and target_profile.access_role = 'pending'
     and new_access_role <> 'pending'
     and not exists (
       select 1 from public.user_module_roles module_role
       where module_role.user_id = target_user_id
     ) then
    raise exception 'Nový účet schvalte přes auditovaný schvalovací formulář.'
      using errcode = '42501';
  end if;

  update public.profiles
  set access_role = new_access_role,
      active = new_active,
      role = case
        when new_access_role = 'admin' then 'caretaker'::public.app_role
        else 'cleaner'::public.app_role
      end
  where id = target_user_id;
end;
$$;

revoke all on function public.school_pending_access_users() from public, anon, authenticated;
revoke all on function public.school_approve_user_access(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.owner_set_user_access(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.school_pending_access_users() to authenticated;
grant execute on function public.school_approve_user_access(uuid, jsonb) to authenticated;
grant execute on function public.owner_set_user_access(uuid, text, boolean) to authenticated;

commit;
