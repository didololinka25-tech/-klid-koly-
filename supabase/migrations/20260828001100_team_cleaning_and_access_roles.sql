-- Sjednocení týmového úklidu a bezpečného onboarding modelu.
-- Legacy role cleaner/caretaker, A/B části a task assignments zůstávají zachované,
-- ale již nerozhodují o viditelnosti běžného úklidu.

begin;

alter table public.profiles
  add column if not exists access_role text,
  add column if not exists is_owner boolean not null default false,
  add column if not exists email text,
  add column if not exists first_signed_in_at timestamptz not null default now(),
  add column if not exists last_signed_in_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_access_role_valid'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_access_role_valid
      check (access_role in ('pending', 'cleaning_team', 'admin', 'visitor'));
  end if;
end $$;

-- Bezpečný převod existujících účtů: nikdo, kdo dnes aplikaci používá,
-- se migrací nezamkne ven.
update public.profiles
set access_role = case role::text
  when 'caretaker' then 'admin'
  else 'cleaning_team'
end
where access_role is null;

alter table public.profiles
  alter column access_role set default 'pending',
  alter column access_role set not null;

update public.profiles profile
set email = auth_user.email,
    first_signed_in_at = coalesce(auth_user.created_at, profile.first_signed_in_at),
    last_signed_in_at = auth_user.last_sign_in_at
from auth.users auth_user
where profile.id = auth_user.id;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, full_name, role, access_role, active, email,
    first_signed_in_at, last_signed_in_at
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'cleaner',
    'pending',
    true,
    new.email,
    coalesce(new.created_at, now()),
    new.last_sign_in_at
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      email = excluded.email,
      last_signed_in_at = excluded.last_signed_in_at;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email, last_sign_in_at, raw_user_meta_data on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.current_access_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select access_role from public.profiles
  where id = auth.uid() and active;
$$;

create or replace function public.is_active_profile()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and active
  );
$$;

create or replace function public.can_view_school_data()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.current_access_role() in ('cleaning_team', 'admin', 'visitor'), false);
$$;

create or replace function public.can_work_in_app()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.current_access_role() in ('cleaning_team', 'admin'), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.current_access_role() = 'admin', false);
$$;

create or replace function public.is_owner()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active and access_role = 'admin' and is_owner
  );
$$;

-- Kompatibilita pro starší SQL funkce. Význam caretaker je od této migrace admin.
create or replace function public.is_caretaker()
returns boolean
language sql
security definer
set search_path = public
stable
as $$ select public.is_admin(); $$;

create or replace function public.is_active_worker()
returns boolean
language sql
security definer
set search_path = public
stable
as $$ select public.can_work_in_app(); $$;

-- Úkol je společný pro tým; A/B a konkrétní assignment nejsou podmínkou.
-- Splatnost se ale vždy ověřuje serverově pro konkrétní datum.
create or replace function public.can_complete_task(target_task_id uuid, target_date date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_date is not null
    and public.can_work_in_app()
    and exists (
    select 1
    from public.cleaning_tasks task
    left join public.rooms room on room.id = task.room_id
    where task.id = target_task_id
      and task.active
      and (task.room_id is null or room.active)
      and case task.frequency::text
        when 'cleaning_day' then extract(isodow from target_date)::smallint = any(task.schedule_days)
        when 'weekly' then extract(isodow from target_date)::smallint = any(task.schedule_days)
        when 'once_or_twice_weekly' then extract(isodow from target_date)::smallint = any(task.schedule_days)
        when 'monthly' then task.monthly_day = extract(day from target_date)::smallint
        when 'extraordinary' then false
        else false
      end
  );
$$;

create or replace function public.app_current_date()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Europe/Prague')::date;
$$;

create or replace function public.can_complete_task(target_task_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$ select public.can_complete_task(target_task_id, public.app_current_date()); $$;

-- Jediná zapisovací cesta pro běžné dokončování úkolů. Klient neposílá
-- worker_id; autora vždy určuje databáze z auth.uid(). Redundantní označení
-- již hotového úkolu je no-op a původního autora nepřepíše.
create or replace function public.set_cleaning_task_completion(
  target_task_id uuid,
  target_completion_date date,
  target_completed boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  current_completion public.cleaning_completions%rowtype;
  inserted_id uuid;
begin
  if actor_id is null or not public.can_work_in_app() then
    raise exception 'K dokončování úkolů nemáte oprávnění.';
  end if;

  if target_task_id is null or target_completion_date is null or target_completed is null then
    raise exception 'Úkol, datum a stav dokončení jsou povinné.';
  end if;

  -- Běžné klientské RPC nezapisuje historii ani budoucnost. Případná ruční
  -- oprava historie musí mít samostatné, výhradně adminské RPC.
  if target_completion_date <> public.app_current_date() then
    raise exception 'Úkol lze běžně změnit pouze pro dnešní datum.';
  end if;

  if not public.can_complete_task(target_task_id, target_completion_date) then
    raise exception 'Úkol není pro zvolené datum splatný nebo k němu nemáte oprávnění.';
  end if;

  select completion.*
  into current_completion
  from public.cleaning_completions completion
  where completion.completion_date = target_completion_date
    and completion.task_id = target_task_id
  for update;

  if not found then
    if not target_completed then
      return;
    end if;

    insert into public.cleaning_completions (
      completion_date, task_id, worker_id, completed
    ) values (
      target_completion_date, target_task_id, actor_id, true
    )
    on conflict (completion_date, task_id) do nothing
    returning id into inserted_id;

    if inserted_id is not null then
      return;
    end if;

    -- Souběžný požadavek mohl řádek právě vytvořit. Zamkneme jej a znovu
    -- vyhodnotíme stav, aby redundantní HOTOVO nepřepsalo prvního autora.
    select completion.*
    into current_completion
    from public.cleaning_completions completion
    where completion.completion_date = target_completion_date
      and completion.task_id = target_task_id
    for update;
  end if;

  if target_completed then
    if current_completion.completed then
      return;
    end if;

    update public.cleaning_completions
    set completed = true,
        worker_id = actor_id,
        completed_at = null
    where id = current_completion.id;
    return;
  end if;

  if not current_completion.completed then
    return;
  end if;

  if exists (
    select 1
    from public.cleaning_tasks dependent_task
    join public.cleaning_completions dependent_completion
      on dependent_completion.task_id = dependent_task.id
     and dependent_completion.completion_date = target_completion_date
     and dependent_completion.completed
    where dependent_task.requires_task_id = target_task_id
      and dependent_task.active
  ) then
    raise exception 'Nejdříve vraťte na nehotovo navazující činnost.';
  end if;

  update public.cleaning_completions
  set completed = false,
      completed_at = null
  where id = current_completion.id;
end;
$$;

revoke all on function public.current_access_role() from public;
revoke all on function public.is_active_profile() from public;
revoke all on function public.can_view_school_data() from public;
revoke all on function public.can_work_in_app() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_owner() from public;
revoke all on function public.is_caretaker() from public;
revoke all on function public.is_active_worker() from public;
revoke all on function public.can_complete_task(uuid) from public;
revoke all on function public.can_complete_task(uuid, date) from public;
revoke all on function public.app_current_date() from public;
revoke all on function public.set_cleaning_task_completion(uuid, date, boolean) from public, anon;
grant execute on function public.current_access_role() to authenticated;
grant execute on function public.is_active_profile() to authenticated;
grant execute on function public.can_view_school_data() to authenticated;
grant execute on function public.can_work_in_app() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_caretaker() to authenticated;
grant execute on function public.is_active_worker() to authenticated;
grant execute on function public.can_complete_task(uuid) to authenticated;
grant execute on function public.can_complete_task(uuid, date) to authenticated;
grant execute on function public.set_cleaning_task_completion(uuid, date, boolean) to authenticated;

-- Jednorázový owner bootstrap je dostupný pouze důvěryhodné serverové roli
-- (např. postgres v Supabase SQL Editoru), nikdy frontendovému uživateli.
create or replace function public.set_initial_owner(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles where is_owner) then
    raise exception 'Hlavní správce už je nastaven.';
  end if;
  if not exists (select 1 from public.profiles where id = target_user_id and active) then
    raise exception 'Aktivní profil s tímto UUID neexistuje.';
  end if;
  update public.profiles
  set access_role = 'admin', role = 'caretaker', is_owner = true
  where id = target_user_id;
end;
$$;
revoke all on function public.set_initial_owner(uuid) from public, anon, authenticated;
grant execute on function public.set_initial_owner(uuid) to postgres, service_role;

create or replace function public.owner_set_user_access(
  target_user_id uuid,
  new_access_role text,
  new_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Role uživatelů může měnit pouze hlavní správce.';
  end if;
  if new_access_role is null or new_access_role not in ('pending', 'cleaning_team', 'admin', 'visitor') then
    raise exception 'Neplatná role.';
  end if;
  if new_active is null then raise exception 'Stav aktivního účtu musí být vyplněn.'; end if;
  if exists (select 1 from public.profiles where id = target_user_id and is_owner) then
    raise exception 'Hlavní správce nemůže tímto formulářem změnit vlastní přístup.';
  end if;
  update public.profiles
  set access_role = new_access_role,
      active = new_active,
      role = case when new_access_role = 'admin' then 'caretaker'::public.app_role else 'cleaner'::public.app_role end
  where id = target_user_id;
  if not found then raise exception 'Profil nebyl nalezen.'; end if;
end;
$$;
revoke all on function public.owner_set_user_access(uuid, text, boolean) from public;
grant execute on function public.owner_set_user_access(uuid, text, boolean) to authenticated;

create or replace function public.set_own_planned_shifts_per_week(value smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_work_in_app() then raise exception 'Docházka není pro tento účet dostupná.'; end if;
  if value not between 1 and 7 then raise exception 'Počet směn týdně musí být mezi 1 a 7.'; end if;
  update public.profiles set planned_shifts_per_week = value where id = auth.uid();
end;
$$;

create or replace function public.admin_set_planned_shifts_per_week(target_user_id uuid, value smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Pouze správce může měnit nastavení jiného pracovníka.'; end if;
  if value not between 1 and 7 then raise exception 'Počet směn týdně musí být mezi 1 a 7.'; end if;
  update public.profiles set planned_shifts_per_week = value where id = target_user_id and active;
end;
$$;
revoke all on function public.admin_set_planned_shifts_per_week(uuid, smallint) from public;
grant execute on function public.admin_set_planned_shifts_per_week(uuid, smallint) to authenticated;

-- Legacy prohazování A/B už není součástí produktu.
revoke execute on function public.swap_cleaning_work_parts() from authenticated;

-- Finální baseline skutečných místností.
with target_rooms(floor_name, room_name, room_kind) as (
  values
    ('1. patro', 'Vstup', 'traffic'),
    ('1. patro', 'Šatna / chodba', 'traffic'),
    ('1. patro', 'Kuchyň', 'kitchen'),
    ('1. patro', 'Jídelna', 'tables'),
    ('1. patro', 'Úklidová místnost', 'standard'),
    ('1. patro', 'Společenská místnost', 'tables'),
    ('1. patro', 'WC dívky', 'toilet'),
    ('1. patro', 'WC kluci', 'toilet'),
    ('1. patro', 'WC ženy', 'toilet'),
    ('1. patro', 'Řadírna', 'standard'),
    ('2. patro', 'Chodba', 'traffic'),
    ('2. patro', 'WC kluci', 'toilet'),
    ('2. patro', 'WC dívky', 'toilet'),
    ('2. patro', 'WC dospělí', 'toilet'),
    ('2. patro', 'Školní zázemí', 'tables'),
    ('2. patro', 'Učebny', 'tables'),
    ('3. patro', 'Chodba', 'traffic'),
    ('3. patro', 'Ateliér', 'tables'),
    ('3. patro', 'WC holky', 'toilet'),
    ('3. patro', 'WC kluci', 'toilet'),
    ('3. patro', 'Úklidová místnost', 'standard'),
    ('3. patro', 'Místnost s nářadím', 'standard'),
    ('3. patro', 'Pohybovka', 'standard'),
    ('4. patro', 'Chodba', 'traffic'),
    ('4. patro', 'Mediační místnost', 'tables')
), templates(room_kind, task_name, activity_type, frequency, days, sort_order) as (
  values
    ('traffic', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('traffic', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('traffic', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('standard', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('standard', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('standard', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('standard', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('kitchen', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('kitchen', 'Vyčistit umyvadlo a baterii', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20),
    ('kitchen', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('kitchen', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('kitchen', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('tables', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('tables', 'Otřít stoly', 'tables', 'weekly', array[3]::smallint[], 20),
    ('tables', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('tables', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('tables', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('toilet', 'Vyčistit WC a splachovadla', 'toilet', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('toilet', 'Vyčistit umyvadla a baterie', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20),
    ('toilet', 'Vyčistit zrcadla', 'mirror', 'cleaning_day', array[1,3,5]::smallint[], 25),
    ('toilet', 'Dezinfikovat kliky, vypínače, baterie a splachovadla', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('toilet', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('toilet', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50)
), desired as (
  select room.id as room_id, template.*
  from target_rooms target
  join public.buildings building on building.name = 'Škola'
  join public.floors floor on floor.building_id = building.id and floor.name = target.floor_name
  join public.rooms room on room.building_id = building.id and room.floor_id = floor.id and room.name = target.room_name
  join templates template on template.room_kind = target.room_kind
)
update public.cleaning_tasks task
set name = desired.task_name,
    frequency = desired.frequency::public.task_frequency,
    schedule_days = desired.days,
    monthly_day = null,
    sort_order = desired.sort_order,
    active = true,
    work_part_id = null,
    assignment_mode = 'fixed',
    rotation_anchor_date = null,
    rotation_interval_weeks = 1
from desired
where task.room_id = desired.room_id
  and task.activity_type = desired.activity_type;

with target_rooms(floor_name, room_name, room_kind) as (
  values
    ('1. patro', 'Vstup', 'traffic'), ('1. patro', 'Šatna / chodba', 'traffic'),
    ('1. patro', 'Kuchyň', 'kitchen'), ('1. patro', 'Jídelna', 'tables'),
    ('1. patro', 'Úklidová místnost', 'standard'), ('1. patro', 'Společenská místnost', 'tables'),
    ('1. patro', 'WC dívky', 'toilet'), ('1. patro', 'WC kluci', 'toilet'),
    ('1. patro', 'WC ženy', 'toilet'), ('1. patro', 'Řadírna', 'standard'),
    ('2. patro', 'Chodba', 'traffic'), ('2. patro', 'WC kluci', 'toilet'),
    ('2. patro', 'WC dívky', 'toilet'), ('2. patro', 'WC dospělí', 'toilet'),
    ('2. patro', 'Školní zázemí', 'tables'), ('2. patro', 'Učebny', 'tables'),
    ('3. patro', 'Chodba', 'traffic'), ('3. patro', 'Ateliér', 'tables'),
    ('3. patro', 'WC holky', 'toilet'), ('3. patro', 'WC kluci', 'toilet'),
    ('3. patro', 'Úklidová místnost', 'standard'), ('3. patro', 'Místnost s nářadím', 'standard'),
    ('3. patro', 'Pohybovka', 'standard'), ('4. patro', 'Chodba', 'traffic'),
    ('4. patro', 'Mediační místnost', 'tables')
), templates(room_kind, task_name, activity_type, frequency, days, sort_order) as (
  values
    ('traffic', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('traffic', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('traffic', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('standard', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('standard', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('standard', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('standard', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('kitchen', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('kitchen', 'Vyčistit umyvadlo a baterii', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20),
    ('kitchen', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('kitchen', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('kitchen', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('tables', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('tables', 'Otřít stoly', 'tables', 'weekly', array[3]::smallint[], 20),
    ('tables', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('tables', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('tables', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50),
    ('toilet', 'Vyčistit WC a splachovadla', 'toilet', 'cleaning_day', array[1,3,5]::smallint[], 10),
    ('toilet', 'Vyčistit umyvadla a baterie', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20),
    ('toilet', 'Vyčistit zrcadla', 'mirror', 'cleaning_day', array[1,3,5]::smallint[], 25),
    ('toilet', 'Dezinfikovat kliky, vypínače, baterie a splachovadla', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30),
    ('toilet', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40),
    ('toilet', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50)
), desired as (
  select room.id as room_id, template.*
  from target_rooms target
  join public.buildings building on building.name = 'Škola'
  join public.floors floor on floor.building_id = building.id and floor.name = target.floor_name
  join public.rooms room on room.building_id = building.id and room.floor_id = floor.id and room.name = target.room_name
  join templates template on template.room_kind = target.room_kind
)
insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  monthly_day, work_part_id, assignment_mode, rotation_anchor_date, rotation_interval_weeks
)
select desired.room_id, desired.task_name, desired.activity_type,
       desired.frequency::public.task_frequency, true, desired.sort_order,
       desired.days, null, null, 'fixed', null, 1
from desired
where not exists (
  select 1 from public.cleaning_tasks existing
  where existing.room_id = desired.room_id
    and existing.activity_type = desired.activity_type
);

insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  work_part_id, assignment_mode, rotation_anchor_date, rotation_interval_weeks
)
select room.id, template.name, template.activity_type,
       template.frequency::public.task_frequency, true, template.sort_order,
       template.days, null, 'fixed', null, 1
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
cross join (values
  ('Zamést / vysát schody', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 10),
  ('Vytřít schody', 'mop', 'once_or_twice_weekly', array[1,5]::smallint[], 20)
) template(name, activity_type, frequency, days, sort_order)
where building.name = 'Škola'
  and floor.name = 'Schodiště'
  and room.name = 'Schodiště'
  and not exists (
    select 1 from public.cleaning_tasks existing
    where existing.room_id = room.id
      and existing.activity_type = template.activity_type
  );

insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  work_part_id, assignment_mode, rotation_anchor_date, rotation_interval_weeks
)
select null, 'Projít školu a odstranit věci z cesty', 'other',
       'cleaning_day', true, 1, array[1,3,5]::smallint[], null, 'fixed', null, 1
where not exists (
  select 1 from public.cleaning_tasks
  where room_id is null and name = 'Projít školu a odstranit věci z cesty'
);

-- Schodiště a společný úkol rovněž přecházejí na týmový režim bez rotace/A-B.
update public.cleaning_tasks task
set active = true,
    frequency = case when task.activity_type = 'mop' then 'once_or_twice_weekly'::public.task_frequency else 'cleaning_day'::public.task_frequency end,
    schedule_days = case when task.activity_type = 'mop' then array[1,5]::smallint[] else array[1,3,5]::smallint[] end,
    work_part_id = null,
    assignment_mode = 'fixed',
    rotation_anchor_date = null,
    rotation_interval_weeks = 1
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
where task.room_id = room.id
  and building.name = 'Škola'
  and floor.name = 'Schodiště'
  and room.name = 'Schodiště'
  and task.activity_type in ('vacuum', 'mop');

update public.cleaning_tasks
set active = true,
    frequency = 'cleaning_day',
    schedule_days = array[1,3,5]::smallint[],
    work_part_id = null,
    assignment_mode = 'fixed',
    rotation_anchor_date = null,
    rotation_interval_weeks = 1
where room_id is null and name = 'Projít školu a odstranit věci z cesty';

-- Okna zůstávají dvě historické položky, ale zobrazování už work_part_id nefiltruje.
update public.cleaning_tasks
set active = true, assignment_mode = 'fixed', rotation_anchor_date = null, rotation_interval_weeks = 1
where room_id is null and activity_type = 'windows';

-- Případné duplicitní aktivní varianty pouze deaktivujeme; nejstarší ID a jeho
-- completion historie zůstává kanonická.
with ranked as (
  select id, row_number() over (
    partition by room_id, activity_type
    order by created_at, id
  ) as position
  from public.cleaning_tasks
  where active and room_id is not null
)
update public.cleaning_tasks task
set active = false
from ranked
where task.id = ranked.id and ranked.position > 1;

-- Vytírání vždy odkazuje na aktivní vysávání stejné místnosti.
update public.cleaning_tasks mop
set requires_task_id = vacuum.id
from public.cleaning_tasks vacuum
where mop.room_id = vacuum.room_id
  and mop.activity_type = 'mop'
  and vacuum.activity_type = 'vacuum'
  and mop.active and vacuum.active;

-- RLS: nejprve odstranění všech předchozích překrývajících se pravidel.
drop policy if exists "profiles own or caretaker" on public.profiles;
drop policy if exists "caretaker manages profiles" on public.profiles;
drop policy if exists "profiles visible to self or admin" on public.profiles;
create policy "profiles visible to self or admin"
on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "read buildings" on public.buildings;
drop policy if exists "manage buildings" on public.buildings;
drop policy if exists "approved users read buildings" on public.buildings;
drop policy if exists "admins manage buildings" on public.buildings;
create policy "approved users read buildings" on public.buildings for select to authenticated using (public.can_view_school_data());
create policy "admins manage buildings" on public.buildings for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read floors" on public.floors;
drop policy if exists "manage floors" on public.floors;
drop policy if exists "approved users read floors" on public.floors;
drop policy if exists "admins manage floors" on public.floors;
create policy "approved users read floors" on public.floors for select to authenticated using (public.can_view_school_data());
create policy "admins manage floors" on public.floors for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read rooms" on public.rooms;
drop policy if exists "manage rooms" on public.rooms;
drop policy if exists "active workers manage rooms" on public.rooms;
drop policy if exists "approved users read rooms" on public.rooms;
drop policy if exists "admins manage rooms" on public.rooms;
create policy "approved users read rooms" on public.rooms for select to authenticated using (public.can_view_school_data());
create policy "admins manage rooms" on public.rooms for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read tasks" on public.cleaning_tasks;
drop policy if exists "manage tasks" on public.cleaning_tasks;
drop policy if exists "active workers read tasks" on public.cleaning_tasks;
drop policy if exists "active workers manage tasks" on public.cleaning_tasks;
drop policy if exists "approved users read tasks" on public.cleaning_tasks;
drop policy if exists "admins manage tasks" on public.cleaning_tasks;
create policy "approved users read tasks" on public.cleaning_tasks for select to authenticated using (public.can_view_school_data() and (active or public.is_admin()));
create policy "admins manage tasks" on public.cleaning_tasks for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read own assignments" on public.task_assignments;
drop policy if exists "manage assignments" on public.task_assignments;
drop policy if exists "active workers read task assignments" on public.task_assignments;
drop policy if exists "active workers manage task assignments" on public.task_assignments;
drop policy if exists "admins read legacy task assignments" on public.task_assignments;
drop policy if exists "admins manage legacy task assignments" on public.task_assignments;
create policy "admins read legacy task assignments" on public.task_assignments for select to authenticated using (public.is_admin());
create policy "admins manage legacy task assignments" on public.task_assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read work parts" on public.cleaning_work_parts;
drop policy if exists "manage work parts" on public.cleaning_work_parts;
drop policy if exists "active workers manage work parts" on public.cleaning_work_parts;
drop policy if exists "admins read legacy work parts" on public.cleaning_work_parts;
drop policy if exists "admins manage legacy work parts" on public.cleaning_work_parts;
create policy "admins read legacy work parts" on public.cleaning_work_parts for select to authenticated using (public.is_admin());
create policy "admins manage legacy work parts" on public.cleaning_work_parts for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read work part assignments" on public.work_part_assignments;
drop policy if exists "manage work part assignments" on public.work_part_assignments;
drop policy if exists "active workers manage work part assignments" on public.work_part_assignments;
drop policy if exists "admins read legacy work part assignments" on public.work_part_assignments;
drop policy if exists "admins manage legacy work part assignments" on public.work_part_assignments;
create policy "admins read legacy work part assignments" on public.work_part_assignments for select to authenticated using (public.is_admin());
create policy "admins manage legacy work part assignments" on public.work_part_assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read completions" on public.cleaning_completions;
drop policy if exists "complete assigned task" on public.cleaning_completions;
drop policy if exists "change own completion" on public.cleaning_completions;
drop policy if exists "approved users read completions" on public.cleaning_completions;
drop policy if exists "team creates shared completions" on public.cleaning_completions;
drop policy if exists "team updates shared completions" on public.cleaning_completions;
create policy "approved users read completions" on public.cleaning_completions for select to authenticated using (public.can_view_school_data());
-- INSERT/UPDATE nemají přímou klientskou policy. Zápis je možný pouze přes
-- set_cleaning_task_completion(), které serverově určuje autora i splatnost.

drop policy if exists "read own attendance" on public.attendance;
drop policy if exists "start own attendance" on public.attendance;
drop policy if exists "update own attendance" on public.attendance;
drop policy if exists "delete own attendance" on public.attendance;
drop policy if exists "active workers read attendance" on public.attendance;
drop policy if exists "active worker starts own attendance" on public.attendance;
drop policy if exists "active workers update attendance" on public.attendance;
drop policy if exists "active workers delete attendance" on public.attendance;
drop policy if exists "team reads attendance" on public.attendance;
drop policy if exists "team starts own attendance" on public.attendance;
drop policy if exists "team updates attendance" on public.attendance;
drop policy if exists "team deletes attendance" on public.attendance;
create policy "team reads attendance" on public.attendance for select to authenticated using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
create policy "team starts own attendance" on public.attendance for insert to authenticated with check (public.can_work_in_app() and worker_id = auth.uid());
create policy "team updates attendance" on public.attendance for update to authenticated
using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()))
with check (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
create policy "team deletes attendance" on public.attendance for delete to authenticated using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));

drop policy if exists "read own shifts" on public.shifts;
drop policy if exists "manage shifts" on public.shifts;
drop policy if exists "team reads shifts" on public.shifts;
drop policy if exists "admins manage shifts" on public.shifts;
create policy "team reads shifts" on public.shifts for select to authenticated using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
create policy "admins manage shifts" on public.shifts for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read stock" on public.stock_items;
drop policy if exists "manage stock" on public.stock_items;
drop policy if exists "approved users read stock" on public.stock_items;
drop policy if exists "admins manage stock" on public.stock_items;
create policy "approved users read stock" on public.stock_items for select to authenticated using (public.can_view_school_data());
create policy "admins manage stock" on public.stock_items for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read own laundry" on public.laundry_records;
drop policy if exists "create own laundry" on public.laundry_records;
drop policy if exists "team reads laundry" on public.laundry_records;
drop policy if exists "team creates own laundry" on public.laundry_records;
create policy "team reads laundry" on public.laundry_records for select to authenticated using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
create policy "team creates own laundry" on public.laundry_records for insert to authenticated with check (public.can_work_in_app() and worker_id = auth.uid());

drop policy if exists "read incidents" on public.incidents;
drop policy if exists "report own incident" on public.incidents;
drop policy if exists "manage incidents" on public.incidents;
drop policy if exists "approved users read incidents" on public.incidents;
drop policy if exists "team reports incidents" on public.incidents;
drop policy if exists "admins manage incidents" on public.incidents;
create policy "approved users read incidents" on public.incidents for select to authenticated using (public.can_view_school_data());
create policy "team reports incidents" on public.incidents for insert to authenticated with check (public.can_work_in_app() and worker_id = auth.uid());
create policy "admins manage incidents" on public.incidents for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read laundry schedules" on public.laundry_schedules;
drop policy if exists "manage laundry schedules" on public.laundry_schedules;
drop policy if exists "approved users read laundry schedules" on public.laundry_schedules;
drop policy if exists "admins manage laundry schedules" on public.laundry_schedules;
create policy "approved users read laundry schedules" on public.laundry_schedules for select to authenticated using (public.can_view_school_data());
create policy "admins manage laundry schedules" on public.laundry_schedules for all to authenticated using (public.is_admin()) with check (public.is_admin());

commit;
