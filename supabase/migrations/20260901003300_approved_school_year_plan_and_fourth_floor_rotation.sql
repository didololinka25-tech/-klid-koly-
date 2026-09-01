begin;

-- Schválený provozní plán 2026/27. Historické úkoly ani completion řádky nemaže.

-- Stoly, lavičky a parapety se nově dělají společně každou středu.
update public.cleaning_tasks
set frequency = 'weekly', schedule_days = array[3]::smallint[], monthly_day = null,
    period_months = null, period_week = null, period_anchor_month = null
where active
  and plan_key like 'v2026|%'
  and (
    activity_type = 'tables'
    or (activity_type = 'surfaces' and frequency = 'weekly')
  );

-- Schodiště zůstává v pátek, jeho okna však patří mezi čtvrtletní okna.
update public.cleaning_tasks task
set frequency = 'weekly', schedule_days = array[5]::smallint[], monthly_day = null,
    period_months = null, period_week = null, period_anchor_month = null,
    cleaning_cycle_length = null, cleaning_cycle_offset = null
from public.rooms room
join public.floors floor on floor.id = room.floor_id
where task.room_id = room.id and task.active and task.plan_key like 'v2026|%'
  and floor.name = 'Schodiště' and task.activity_type <> 'windows';

-- Dveře měsíčně: osm menších stabilních skupin (4 týdny × Po/Pá).
-- Středa tak zůstává pro stoly a případnou jednu další kategorii.
with ranked as (
  select task.id, row_number() over(order by floor.sort_order, room.sort_order, task.sort_order, task.id) - 1 as position
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type = 'doors'
)
update public.cleaning_tasks task
set frequency = 'monthly', schedule_days = array[(array[1,5]::smallint[])[1 + (ranked.position % 2)::integer]]::smallint[],
    monthly_day = null, period_months = 1, period_week = (1 + ((ranked.position / 2) % 4))::smallint,
    period_anchor_month = date '2026-09-01', cleaning_cycle_length = null, cleaning_cycle_offset = null
from ranked where task.id = ranked.id;

-- Okna včetně schodiště čtvrtletně, rozložená do jedenácti menších skupin.
-- Čtvrtý pátek je rezervovaný pro dvouměsíční Řadírnu.
with ranked as (
  select task.id, row_number() over(order by floor.sort_order, room.sort_order, task.sort_order, task.id) - 1 as position
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type = 'windows'
)
update public.cleaning_tasks task
set frequency = 'monthly', schedule_days = array[(array[1,3,5]::smallint[])[1 + ((ranked.position % 11) % 3)::integer]]::smallint[],
    monthly_day = null, period_months = 3, period_week = (1 + ((ranked.position % 11) / 3))::smallint,
    period_anchor_month = date '2026-09-01', cleaning_cycle_length = null, cleaning_cycle_offset = null
from ranked where task.id = ranked.id;

-- Obklady WC/sprchy: 1., 2. a 3. patro v různých dnech třetího týdne.
update public.cleaning_tasks task
set frequency = 'monthly',
    schedule_days = array[case floor.name when '1. patro' then 1 when '2. patro' then 3 else 5 end]::smallint[],
    monthly_day = null, period_months = 1, period_week = 3, period_anchor_month = date '2026-09-01',
    cleaning_cycle_length = null, cleaning_cycle_offset = null
from public.rooms room
join public.floors floor on floor.id = room.floor_id
where task.room_id = room.id and task.active and task.plan_key like 'v2026|%'
  and task.activity_type = 'tiles' and floor.name in ('1. patro','2. patro','3. patro');

-- Měsíční skříňky, police, sedačky a velké povrchy v menších skupinách čtvrtého týdne.
with ranked as (
  select task.id, row_number() over(order by floor.sort_order, room.sort_order, task.sort_order, task.id) - 1 as position
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  where task.active and task.plan_key like 'v2026|%'
    and task.activity_type = 'surfaces' and task.frequency = 'monthly'
)
update public.cleaning_tasks task
set schedule_days = array[(array[1,3,5]::smallint[])[1 + (ranked.position % 3)::integer]]::smallint[],
    monthly_day = null, period_months = 1, period_week = 4, period_anchor_month = date '2026-09-01',
    cleaning_cycle_length = null, cleaning_cycle_offset = null
from ranked where task.id = ranked.id;

-- Hloubkové koberce čtvrtletně, jednotlivě. Kotva říjen je odděluje od čtvrtletních oken.
with ranked as (
  select task.id, row_number() over(order by floor.sort_order, room.sort_order, task.sort_order, task.id) - 1 as position
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type = 'deep_clean'
    and room.name in ('Vstup','Šatna / chodba','Společenská místnost','Mediační místnost')
)
update public.cleaning_tasks task
set frequency = 'monthly', schedule_days = array[(array[1,3,5]::smallint[])[1 + (ranked.position % 3)::integer]]::smallint[],
    monthly_day = null, period_months = 3, period_week = (1 + (ranked.position % 4))::smallint,
    period_anchor_month = date '2026-10-01', cleaning_cycle_length = null, cleaning_cycle_offset = null
from ranked where task.id = ranked.id;

-- Řadírna zůstává samostatný dvouměsíční větší úkol.
update public.cleaning_tasks task
set frequency = 'monthly', schedule_days = array[5]::smallint[], monthly_day = null,
    period_months = 2, period_week = 4, period_anchor_month = date '2026-09-01',
    cleaning_cycle_length = null, cleaning_cycle_offset = null
from public.rooms room
where task.room_id = room.id and task.active and task.plan_key like 'v2026|%'
  and room.name = 'Řadírna' and task.activity_type = 'deep_clean';

-- Praní je podle potřeby a zrcadlo v Jídelně neexistuje: pouze soft-deaktivace.
update public.cleaning_tasks set active = false
where active and plan_key like 'v2026|%' and activity_type = 'laundry';

update public.cleaning_tasks task set active = false
from public.rooms room
where task.room_id = room.id and task.active and task.plan_key like 'v2026|%'
  and room.name = 'Jídelna' and task.activity_type = 'mirror';

-- Historická a UUID-stabilní rotace společného úkolu 4. patra.
create table if not exists public.cleaning_rotation_definitions (
  rotation_key text primary key,
  title text not null,
  anchor_date date not null,
  weekday smallint not null check (weekday between 1 and 7),
  slot_count smallint not null check (slot_count between 2 and 12),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cleaning_rotation_slot_assignments (
  id uuid primary key default gen_random_uuid(),
  rotation_key text not null references public.cleaning_rotation_definitions(rotation_key) on delete restrict,
  slot_index smallint not null check (slot_index between 0 and 11),
  worker_id uuid references public.profiles(id) on delete restrict,
  valid_from date not null,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete restrict,
  check (valid_to is null or valid_to >= valid_from)
);

create index if not exists cleaning_rotation_slot_lookup_idx
  on public.cleaning_rotation_slot_assignments(rotation_key, slot_index, active, valid_from, valid_to);

create or replace function public.enforce_cleaning_rotation_slot_unambiguous()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not new.active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.rotation_key || '|' || new.slot_index::text, 3300));
  if exists (
    select 1 from public.cleaning_rotation_slot_assignments existing
    where existing.rotation_key=new.rotation_key and existing.slot_index=new.slot_index
      and existing.active and existing.id<>new.id
      and daterange(existing.valid_from,coalesce(existing.valid_to,'infinity'::date),'[]')
          && daterange(new.valid_from,coalesce(new.valid_to,'infinity'::date),'[]')
  ) then raise exception 'Platnost rotační pozice se překrývá s existujícím přiřazením.'; end if;
  return new;
end; $$;

revoke all on function public.enforce_cleaning_rotation_slot_unambiguous() from public;
drop trigger if exists cleaning_rotation_slot_unambiguous on public.cleaning_rotation_slot_assignments;
create trigger cleaning_rotation_slot_unambiguous
before insert or update of rotation_key,slot_index,valid_from,valid_to,active
on public.cleaning_rotation_slot_assignments for each row
execute function public.enforce_cleaning_rotation_slot_unambiguous();

insert into public.cleaning_rotation_definitions(rotation_key,title,anchor_date,weekday,slot_count)
values('school-fourth-floor','4. patro',date '2026-09-04',5,3)
on conflict(rotation_key) do update set title=excluded.title, anchor_date=excluded.anchor_date,
  weekday=excluded.weekday, slot_count=excluded.slot_count, active=true, updated_at=now();

insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,valid_from,active)
select 'school-fourth-floor', slot, null, date '2026-09-04', true
from generate_series(0,2) slot
where not exists (
  select 1 from public.cleaning_rotation_slot_assignments existing
  where existing.rotation_key='school-fourth-floor' and existing.slot_index=slot and existing.active
);

alter table public.cleaning_rotation_definitions enable row level security;
alter table public.cleaning_rotation_slot_assignments enable row level security;

drop policy if exists "approved users read cleaning rotations" on public.cleaning_rotation_definitions;
create policy "approved users read cleaning rotations" on public.cleaning_rotation_definitions
  for select to authenticated using (public.can_view_school_data());
drop policy if exists "approved users read cleaning rotation slots" on public.cleaning_rotation_slot_assignments;
create policy "approved users read cleaning rotation slots" on public.cleaning_rotation_slot_assignments
  for select to authenticated using (public.can_view_school_data());

grant select on public.cleaning_rotation_definitions, public.cleaning_rotation_slot_assignments to authenticated;
revoke insert, update, delete on public.cleaning_rotation_definitions, public.cleaning_rotation_slot_assignments from anon, authenticated;

create or replace function public.admin_set_cleaning_rotation_slot(
  target_rotation_key text,
  target_slot_index smallint,
  target_worker_id uuid,
  target_effective_from date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  definition public.cleaning_rotation_definitions%rowtype;
  current_slot public.cleaning_rotation_slot_assignments%rowtype;
  next_valid_from date;
  saved_id uuid;
begin
  if not public.is_admin() then raise exception 'Rotaci může měnit pouze správce.'; end if;
  select * into definition from public.cleaning_rotation_definitions where rotation_key=target_rotation_key and active;
  if not found or target_slot_index < 0 or target_slot_index >= definition.slot_count then raise exception 'Neplatná rotační pozice.'; end if;
  if target_worker_id is not null and not exists (
    select 1 from public.profiles where id=target_worker_id and active and access_role in ('cleaning_team','admin')
  ) then raise exception 'Vybraný pracovník není aktivní člen úklidového týmu.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_rotation_key || '|' || target_slot_index::text, 3300));
  select * into current_slot from public.cleaning_rotation_slot_assignments
  where rotation_key=target_rotation_key and slot_index=target_slot_index and active
    and valid_from <= target_effective_from and (valid_to is null or valid_to >= target_effective_from)
  order by valid_from desc limit 1 for update;
  if found and current_slot.valid_from = target_effective_from then
    update public.cleaning_rotation_slot_assignments
    set worker_id=target_worker_id, updated_at=now(), updated_by=auth.uid()
    where id=current_slot.id returning id into saved_id;
    return saved_id;
  end if;
  if found then
    update public.cleaning_rotation_slot_assignments
    set valid_to=target_effective_from-1, updated_at=now(), updated_by=auth.uid()
    where id=current_slot.id;
  end if;
  select min(valid_from) into next_valid_from from public.cleaning_rotation_slot_assignments
  where rotation_key=target_rotation_key and slot_index=target_slot_index and active and valid_from>target_effective_from;
  insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,valid_from,valid_to,active,created_by,updated_by)
  values(target_rotation_key,target_slot_index,target_worker_id,target_effective_from,
    case when next_valid_from is null then null else next_valid_from-1 end,true,auth.uid(),auth.uid())
  returning id into saved_id;
  return saved_id;
end;
$$;

revoke all on function public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) from public;
grant execute on function public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) to authenticated;

-- Rozšíření stávajícího čtecího RPC; původní assignments/exceptions zůstávají beze změny.
create or replace function public.get_worker_work_planning()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.can_view_school_data() then raise exception 'Nemáte oprávnění zobrazit pracovní rozdělení.'; end if;
  return jsonb_build_object(
    'assignments', coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'worker_id',a.worker_id,'worker_name',coalesce(nullif(btrim(p.full_name),''),'Pracovník'),
      'building_id',a.building_id,'building_name',b.name,'floor_id',a.floor_id,'floor_name',f.name,
      'area_label',a.area_label,'weekdays',a.weekdays,'valid_from',a.valid_from,'valid_to',a.valid_to,'active',a.active
    ) order by p.full_name,a.valid_from,a.area_label)
    from public.worker_work_assignments a join public.profiles p on p.id=a.worker_id
    join public.buildings b on b.id=a.building_id left join public.floors f on f.id=a.floor_id), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'worker_id',e.worker_id,'worker_name',coalesce(nullif(btrim(p.full_name),''),'Pracovník'),
      'exception_date',e.exception_date,'planned',e.planned,'building_id',e.building_id,'building_name',b.name,
      'floor_id',e.floor_id,'floor_name',f.name,'area_label',e.area_label,'note',e.note,'active',e.active
    ) order by e.exception_date,p.full_name)
    from public.worker_schedule_exceptions e join public.profiles p on p.id=e.worker_id
    left join public.buildings b on b.id=e.building_id left join public.floors f on f.id=e.floor_id), '[]'::jsonb),
    'rotation_definitions', coalesce((select jsonb_agg(jsonb_build_object(
      'rotation_key',d.rotation_key,'title',d.title,'anchor_date',d.anchor_date,'weekday',d.weekday,
      'slot_count',d.slot_count,'active',d.active
    ) order by d.rotation_key) from public.cleaning_rotation_definitions d), '[]'::jsonb),
    'rotation_slots', coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'rotation_key',s.rotation_key,'slot_index',s.slot_index,'worker_id',s.worker_id,
      'worker_name',case when s.worker_id is null then null else coalesce(nullif(btrim(p.full_name),''),'Pracovník') end,
      'valid_from',s.valid_from,'valid_to',s.valid_to,'active',s.active
    ) order by s.rotation_key,s.slot_index,s.valid_from)
    from public.cleaning_rotation_slot_assignments s left join public.profiles p on p.id=s.worker_id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_worker_work_planning() from public;
grant execute on function public.get_worker_work_planning() to authenticated;

do $$
begin
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type='laundry') then raise exception 'Praní nesmí zůstat v aktivním plánu.'; end if;
  if exists(select 1 from public.cleaning_tasks task join public.rooms room on room.id=task.room_id where task.active and task.plan_key like 'v2026|%' and room.name='Jídelna' and task.activity_type='mirror') then raise exception 'Zrcadlo Jídelny nesmí zůstat aktivní.'; end if;
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type='windows' and period_months is distinct from 3::smallint) then raise exception 'Všechna okna musí být čtvrtletní.'; end if;
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type='tables' and schedule_days is distinct from array[3]::smallint[]) then raise exception 'Stoly musí být ve středu.'; end if;
  if (select count(*) from public.cleaning_rotation_slot_assignments where rotation_key='school-fourth-floor' and active and valid_to is null) <> 3 then raise exception 'Rotace 4. patra musí mít tři aktuální pozice.'; end if;
  if has_table_privilege('authenticated','public.cleaning_rotation_slot_assignments','INSERT,UPDATE,DELETE') then raise exception 'Přímý zápis rotace nesmí být povolen.'; end if;
  if to_regprocedure('public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date)') is null then raise exception 'Chybí RPC správy rotace.'; end if;
end $$;

commit;
