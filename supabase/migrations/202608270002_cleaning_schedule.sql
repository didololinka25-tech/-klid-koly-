-- Rozšíření plánování úklidu. Tato migrace nic nemaže.
do $$ begin create type public.task_assignment_mode as enum ('fixed', 'rotating'); exception when duplicate_object then null; end $$;

alter table public.cleaning_tasks
  add column if not exists schedule_days smallint[] not null default '{}',
  add column if not exists monthly_day smallint,
  add column if not exists assignment_mode public.task_assignment_mode not null default 'fixed',
  add column if not exists rotation_anchor_date date,
  add column if not exists rotation_interval_weeks integer not null default 1;
alter table public.cleaning_tasks
  add constraint cleaning_tasks_schedule_days_valid check (schedule_days <@ array[1,2,3,4,5,6,7]::smallint[]),
  add constraint cleaning_tasks_monthly_day_valid check (monthly_day is null or monthly_day between 1 and 31),
  add constraint cleaning_tasks_rotation_interval_valid check (rotation_interval_weeks >= 1);
alter table public.task_assignments add column if not exists rotation_order smallint;

create table public.cleaning_work_parts (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  code text not null check (code in ('A', 'B')),
  name text not null,
  active boolean not null default true,
  unique (building_id, code)
);
create table public.work_part_assignments (
  id uuid primary key default gen_random_uuid(),
  work_part_id uuid not null references public.cleaning_work_parts(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete restrict,
  starts_on date not null default current_date,
  ends_on date,
  active boolean not null default true,
  check (ends_on is null or ends_on >= starts_on)
);
create unique index work_part_one_current_worker_idx on public.work_part_assignments(work_part_id) where active;
create unique index worker_one_current_part_idx on public.work_part_assignments(worker_id) where active;
alter table public.cleaning_tasks add column if not exists work_part_id uuid references public.cleaning_work_parts(id) on delete set null;

comment on column public.cleaning_tasks.schedule_days is 'Dny v týdnu ISO: 1=pondělí, 7=neděle. Prázdné pole se používá pro měsíční a mimořádné úkoly.';
comment on column public.cleaning_tasks.assignment_mode is 'fixed = jeden pracovník; rotating = střídání podle rotation_order, rotation_anchor_date a rotation_interval_weeks.';
comment on column public.cleaning_tasks.work_part_id is 'Pracovní část A/B. Pravidelné úkoly patří části, ne trvale konkrétní osobě.';

-- Jediný schválený plán úklidu se seeduje zde; první migrace nevkládá provizorní úkoly.
-- Doplnění místností pro celé patro školy.
insert into public.rooms (building_id, floor_id, name, sort_order)
select b.id, f.id, 'Chodba – ' || f.name, f.sort_order * 10 + 1
from public.buildings b join public.floors f on f.building_id = b.id
where b.name = 'Škola' and f.name in ('1. patro', '2. patro', '3. patro', '4. patro')
  and not exists (select 1 from public.rooms r where r.building_id = b.id and r.name = 'Chodba – ' || f.name);

insert into public.rooms (building_id, floor_id, name, sort_order)
select b.id, f.id, 'Toalety – ' || f.name, f.sort_order * 10 + 2
from public.buildings b join public.floors f on f.building_id = b.id
where b.name = 'Škola' and f.name in ('Přízemí', '1. patro', '2. patro', '3. patro', '4. patro')
  and not exists (select 1 from public.rooms r where r.building_id = b.id and r.name = 'Toalety – ' || f.name);

-- David před úklidem projde školu a odstraní věci z cesty. Tento úkol nepatří části A/B.
insert into public.cleaning_tasks (room_id, name, frequency, schedule_days, sort_order, assignment_mode)
select null, 'Projít školu a odstranit věci z cesty', 'cleaning_day', array[1,3,5]::smallint[], 1, 'fixed'
where not exists (
  select 1 from public.cleaning_tasks
  where room_id is null and name = 'Projít školu a odstranit věci z cesty'
);

-- Chodby: při každém úklidovém dni; vytírání je závislé na předchozím zametení/vysátí.
insert into public.cleaning_tasks (room_id, name, frequency, schedule_days, sort_order)
select r.id, v.name, 'cleaning_day', array[1,3,5]::smallint[], v.sort_order
from public.rooms r join public.buildings b on b.id = r.building_id
cross join (values ('Zamést / vysát chodbu', 10), ('Vytřít chodbu', 20), ('Dezinfikovat kliky a vypínače', 30)) v(name, sort_order)
where b.name = 'Škola' and r.name like 'Chodba – %'
  and not exists (select 1 from public.cleaning_tasks t where t.room_id = r.id and t.name = v.name);

update public.cleaning_tasks mop set requires_task_id = sweep.id
from public.cleaning_tasks sweep
where mop.name = 'Vytřít chodbu' and sweep.name = 'Zamést / vysát chodbu' and mop.room_id = sweep.room_id;

-- Toalety: WC, umyvadla, zrcadla, dezinfekce dotykových ploch a podlaha při každém úklidovém dni.
insert into public.cleaning_tasks (room_id, name, frequency, schedule_days, sort_order)
select r.id, v.name, 'cleaning_day', array[1,3,5]::smallint[], v.sort_order
from public.rooms r join public.buildings b on b.id = r.building_id
cross join (values ('Vyčistit WC a splachovadla', 10), ('Vyčistit umyvadla, baterie a zrcadla', 20), ('Dezinfikovat kliky, vypínače, baterie a splachovadla', 30), ('Zamést / vysát podlahu', 40), ('Vytřít podlahu', 50)) v(name, sort_order)
where b.name = 'Škola' and r.name like 'Toalety – %'
  and not exists (select 1 from public.cleaning_tasks t where t.room_id = r.id and t.name = v.name);

update public.cleaning_tasks mop set requires_task_id = sweep.id
from public.cleaning_tasks sweep
where mop.name = 'Vytřít podlahu' and sweep.name = 'Zamést / vysát podlahu' and mop.room_id = sweep.room_id;

-- Schody se uklízí v pondělí a v pátek. Oba úkoly se střídají mezi Danou a Martinou po týdnech.
insert into public.cleaning_tasks (room_id, name, frequency, schedule_days, sort_order, assignment_mode, rotation_anchor_date, rotation_interval_weeks)
select r.id, v.name, 'once_or_twice_weekly', array[1,5]::smallint[], v.sort_order, 'rotating', date '2026-08-24', 1
from public.rooms r join public.buildings b on b.id = r.building_id
cross join (values ('Zamést / vysát schody', 10), ('Vytřít schody', 20)) v(name, sort_order)
where b.name = 'Škola' and r.name = 'Schodiště'
  and not exists (select 1 from public.cleaning_tasks t where t.room_id = r.id and t.name = v.name);

update public.cleaning_tasks mop set requires_task_id = sweep.id
from public.cleaning_tasks sweep
where mop.name = 'Vytřít schody' and sweep.name = 'Zamést / vysát schody' and mop.room_id = sweep.room_id;

-- Část A a B si mohou Dana a Martina kdykoliv prohodit; místnosti nejsou trvale přidělené osobě.
insert into public.cleaning_work_parts (building_id, code, name)
select b.id, v.code, v.name from public.buildings b cross join (values
  ('A', 'Část A – přízemí až 2. patro'),
  ('B', 'Část B – 3. a 4. patro, třídy')
) v(code, name)
where b.name = 'Škola' on conflict (building_id, code) do nothing;

update public.cleaning_tasks t set work_part_id = part.id
from public.rooms r join public.cleaning_work_parts part on part.building_id = r.building_id
where t.room_id = r.id and part.code = case
  when r.name in ('Chodba – přízemí', 'Chodba – 1. patro', 'Chodba – 2. patro', 'Toalety', 'Toalety – Přízemí', 'Toalety – 1. patro', 'Toalety – 2. patro') then 'A'
  when r.name in ('Chodba – 3. patro', 'Chodba – 4. patro', 'Toalety – 3. patro', 'Toalety – 4. patro', 'Třídy') then 'B'
  else null end;

-- Třídy: koše při každém úklidu, stoly vždy ve středu; stoly se střídají mezi uklízečkami po týdnech.
insert into public.cleaning_tasks (room_id, name, frequency, schedule_days, sort_order, assignment_mode, rotation_anchor_date, rotation_interval_weeks)
select r.id, v.name, v.frequency::public.task_frequency, v.days, v.sort_order, v.assignment_mode::public.task_assignment_mode, v.anchor_date, 1
from public.rooms r join public.buildings b on b.id = r.building_id
cross join (values ('Vynést koše', 'cleaning_day', array[1,3,5]::smallint[], 10, 'fixed', null::date), ('Otřít stoly', 'weekly', array[3]::smallint[], 20, 'rotating', date '2026-08-26')) v(name, frequency, days, sort_order, assignment_mode, anchor_date)
where b.name = 'Škola' and r.name = 'Třídy'
  and not exists (select 1 from public.cleaning_tasks t where t.room_id = r.id and t.name = v.name);

update public.cleaning_tasks t set work_part_id = part.id
from public.rooms r join public.cleaning_work_parts part on part.building_id = r.building_id
where t.room_id = r.id and part.code = case
  when r.name in ('Chodba – přízemí', 'Chodba – 1. patro', 'Chodba – 2. patro', 'Toalety', 'Toalety – Přízemí', 'Toalety – 1. patro', 'Toalety – 2. patro') then 'A'
  when r.name in ('Chodba – 3. patro', 'Chodba – 4. patro', 'Toalety – 3. patro', 'Toalety – 4. patro', 'Třídy') then 'B'
  else null end;

-- Měsíční okna patří jednotlivým pracovním částem a lze je přesunout společně s částí.
insert into public.cleaning_tasks (work_part_id, name, frequency, monthly_day, sort_order)
select part.id, 'Mytí oken – část ' || part.code, 'monthly', 1, 90
from public.cleaning_work_parts part
where not exists (select 1 from public.cleaning_tasks t where t.work_part_id = part.id and t.name = 'Mytí oken – část ' || part.code);

-- Výchozí držitelé částí se vloží jen tehdy, pokud již existují Auth profily.
insert into public.work_part_assignments (work_part_id, worker_id, starts_on, active)
select part.id, p.id, current_date, true
from public.cleaning_work_parts part join public.profiles p on (part.code = 'A' and p.full_name = 'Dana') or (part.code = 'B' and p.full_name = 'Martina')
where part.active and p.active on conflict do nothing;

-- Pro úkoly, které se střídají po týdnech, se eviduje pořadí obou uklízeček.
insert into public.task_assignments (task_id, worker_id, active, rotation_order)
select t.id, p.id, true, case p.full_name when 'Dana' then 1 else 2 end
from public.cleaning_tasks t join public.profiles p on p.full_name in ('Dana', 'Martina') and p.active
where t.assignment_mode = 'rotating'
on conflict (task_id, worker_id) do update set active = excluded.active, rotation_order = excluded.rotation_order;

-- David má pouze provozní úkol projít školu; role caretaker se nastavuje samostatně správcem.
insert into public.task_assignments (task_id, worker_id, active)
select t.id, p.id, true from public.cleaning_tasks t join public.profiles p on p.full_name = 'David' and p.active
where t.room_id is null and t.name = 'Projít školu a odstranit věci z cesty'
on conflict (task_id, worker_id) do update set active = excluded.active;

-- Po vytvoření nového Auth účtu se Dana a Martina automaticky vloží do výchozí části a k týdennímu střídání.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
declare profile_name text; assigned_part text;
begin
  profile_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  insert into public.profiles(id, full_name, role) values(new.id, profile_name, 'cleaner') on conflict(id) do nothing;
  assigned_part := case profile_name when 'Dana' then 'A' when 'Martina' then 'B' else null end;
  if assigned_part is not null then
    insert into public.work_part_assignments(work_part_id, worker_id, starts_on, active)
    select part.id, new.id, current_date, true from public.cleaning_work_parts part join public.buildings b on b.id = part.building_id
    where b.name = 'Škola' and part.code = assigned_part on conflict do nothing;
    insert into public.task_assignments(task_id, worker_id, active, rotation_order)
    select t.id, new.id, true, case profile_name when 'Dana' then 1 else 2 end from public.cleaning_tasks t where t.assignment_mode = 'rotating'
    on conflict(task_id, worker_id) do update set active = excluded.active, rotation_order = excluded.rotation_order;
  end if;
  if profile_name = 'David' then
    insert into public.task_assignments(task_id, worker_id, active)
    select t.id, new.id, true from public.cleaning_tasks t where t.room_id is null and t.name = 'Projít školu a odstranit věci z cesty'
    on conflict(task_id, worker_id) do update set active = excluded.active;
  end if;
  return new;
end;
$$;

-- Týdenní plán praní je jen evidence; nevzniká z něj cleaning_task ani completion.
create table public.laundry_schedules (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  name text not null,
  schedule_days smallint[] not null default '{}',
  active boolean not null default true,
  unique (building_id, name),
  check (schedule_days <@ array[1,2,3,4,5,6,7]::smallint[])
);
insert into public.laundry_schedules (building_id, name, schedule_days)
select id, 'Praní utěrek a hadrů', array[5]::smallint[] from public.buildings where name = 'Škola'
on conflict (building_id, name) do nothing;

alter table public.cleaning_work_parts enable row level security;
alter table public.work_part_assignments enable row level security;
alter table public.laundry_schedules enable row level security;
grant select on public.cleaning_work_parts, public.work_part_assignments, public.laundry_schedules to authenticated;
grant insert, update, delete on public.cleaning_work_parts, public.work_part_assignments, public.laundry_schedules to authenticated;
create policy "read work parts" on public.cleaning_work_parts for select to authenticated using (true);
create policy "manage work parts" on public.cleaning_work_parts for all to authenticated using (public.is_caretaker()) with check (public.is_caretaker());
create policy "read work part assignments" on public.work_part_assignments for select to authenticated using (true);
create policy "manage work part assignments" on public.work_part_assignments for all to authenticated using (public.is_caretaker()) with check (public.is_caretaker());
create policy "read laundry schedules" on public.laundry_schedules for select to authenticated using (true);
create policy "manage laundry schedules" on public.laundry_schedules for all to authenticated using (public.is_caretaker()) with check (public.is_caretaker());

create or replace function public.can_complete_task(target_task_id uuid, target_date date) returns boolean language sql security definer set search_path=public stable as $$
  select public.is_caretaker() or exists (
    select 1 from public.cleaning_tasks t
    left join public.task_assignments ta on ta.task_id = t.id and ta.worker_id = auth.uid() and ta.active
    left join public.work_part_assignments wpa on wpa.work_part_id = t.work_part_id and wpa.worker_id = auth.uid() and wpa.active
    where t.id = target_task_id and (
      wpa.id is not null or (
        t.assignment_mode = 'fixed' and ta.id is not null
      ) or (
        t.assignment_mode = 'rotating' and ta.rotation_order = ((floor((target_date - t.rotation_anchor_date)::numeric / 7) / t.rotation_interval_weeks)::integer % 2) + 1
      )
    )
  );
$$;
revoke all on function public.can_complete_task(uuid, date) from public;
grant execute on function public.can_complete_task(uuid, date) to authenticated;
drop policy "complete assigned task" on public.cleaning_completions;
drop policy "change own completion" on public.cleaning_completions;
create policy "complete assigned task" on public.cleaning_completions for insert to authenticated with check (worker_id = auth.uid() and public.can_complete_task(task_id, completion_date));
create policy "change own completion" on public.cleaning_completions for update to authenticated using (worker_id = auth.uid() or public.is_caretaker()) with check ((worker_id = auth.uid() and public.can_complete_task(task_id, completion_date)) or public.is_caretaker());

create or replace function public.swap_cleaning_work_parts() returns void language plpgsql security definer set search_path=public as $$
declare worker_a uuid; worker_b uuid; part_a uuid; part_b uuid;
begin
  if not public.is_caretaker() then raise exception 'Pouze správce může prohodit pracovní části.'; end if;
  select id into part_a from public.cleaning_work_parts where code = 'A' and active limit 1;
  select id into part_b from public.cleaning_work_parts where code = 'B' and active limit 1;
  select worker_id into worker_a from public.work_part_assignments where work_part_id = part_a and active;
  select worker_id into worker_b from public.work_part_assignments where work_part_id = part_b and active;
  if worker_a is null or worker_b is null then raise exception 'Obě pracovní části musí mít aktuálního pracovníka.'; end if;
  update public.work_part_assignments set active = false, ends_on = current_date where active and work_part_id in (part_a, part_b);
  insert into public.work_part_assignments (work_part_id, worker_id, starts_on) values (part_a, worker_b, current_date), (part_b, worker_a, current_date);
end;
$$;
revoke all on function public.swap_cleaning_work_parts() from public;
grant execute on function public.swap_cleaning_work_parts() to authenticated;
