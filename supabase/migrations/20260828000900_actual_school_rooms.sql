-- Skutečná struktura místností školy bez mazání historie.
-- Stejné názvy místností mohou být v různých patrech (např. WC kluci).
alter table public.rooms
  drop constraint if exists rooms_building_id_name_key;

create unique index if not exists rooms_building_floor_name_key
  on public.rooms (building_id, floor_id, name) nulls not distinct;

-- Cílové místnosti. Existující řádky se zachovají a znovu aktivují.
with target_rooms(floor_name, room_name, sort_order) as (
  values
    ('1. patro', 'Vstup', 10),
    ('1. patro', 'Šatna / chodba', 20),
    ('1. patro', 'Kuchyň', 30),
    ('1. patro', 'Jídelna', 40),
    ('1. patro', 'Úklidová místnost', 50),
    ('1. patro', 'Společenská místnost', 60),
    ('1. patro', 'WC dívky', 70),
    ('1. patro', 'WC kluci', 80),
    ('1. patro', 'WC ženy', 90),
    ('1. patro', 'Řadírna', 100),
    ('2. patro', 'Chodba', 10),
    ('2. patro', 'WC kluci', 20),
    ('2. patro', 'WC dívky', 30),
    ('2. patro', 'WC dospělí', 40),
    ('2. patro', 'Školní zázemí', 50),
    ('2. patro', 'Učebny', 60),
    ('3. patro', 'Chodba', 10),
    ('3. patro', 'Ateliér', 20),
    ('3. patro', 'WC holky', 30),
    ('3. patro', 'WC kluci', 40),
    ('3. patro', 'Úklidová místnost', 50),
    ('3. patro', 'Místnost s nářadím', 60),
    ('3. patro', 'Pohybovka', 70),
    ('4. patro', 'Chodba', 10),
    ('4. patro', 'Mediační místnost', 20),
    ('Schodiště', 'Schodiště', 10)
)
insert into public.rooms (building_id, floor_id, name, active, sort_order)
select b.id, f.id, target.room_name, true, target.sort_order
from target_rooms target
join public.buildings b on b.name = 'Škola'
join public.floors f on f.building_id = b.id and f.name = target.floor_name
on conflict (building_id, floor_id, name)
do update set active = true, sort_order = excluded.sort_order;

-- Jednoznačné přesuny stávajících generických úkolů zachovají task ID,
-- requires_task_id i všechny historické cleaning_completions.
with room_moves(old_room, target_floor, target_room) as (
  values
    ('Chodba – přízemí', '1. patro', 'Vstup'),
    ('Chodba – 1. patro', '1. patro', 'Šatna / chodba'),
    ('Chodba – 2. patro', '2. patro', 'Chodba'),
    ('Chodba – 3. patro', '3. patro', 'Chodba'),
    ('Chodba – 4. patro', '4. patro', 'Chodba'),
    ('Toalety – Přízemí', '1. patro', 'WC ženy'),
    ('Toalety – 1. patro', '1. patro', 'WC dívky'),
    ('Toalety – 2. patro', '2. patro', 'WC dospělí'),
    ('Toalety – 3. patro', '3. patro', 'WC holky'),
    ('Třídy', '2. patro', 'Učebny')
), resolved_moves as (
  select old_room.id as old_id, target_room.id as target_id
  from room_moves move
  join public.buildings b on b.name = 'Škola'
  join public.rooms old_room
    on old_room.building_id = b.id and old_room.name = move.old_room
  join public.floors target_floor
    on target_floor.building_id = b.id and target_floor.name = move.target_floor
  join public.rooms target_room
    on target_room.building_id = b.id
   and target_room.floor_id = target_floor.id
   and target_room.name = move.target_room
)
update public.cleaning_tasks task
set room_id = move.target_id
from resolved_moves move
where task.room_id = move.old_id;

-- Staré generické místnosti zůstanou v databázi kvůli historii, ale nebudou aktivní.
update public.rooms room
set active = false
from public.buildings building
where room.building_id = building.id
  and building.name = 'Škola'
  and (
    room.name like 'Chodba – %'
    or room.name like 'Toalety – %'
    or room.name = 'Třídy'
  );

-- Zbylé úkoly bez cílového protějšku (např. bývalé toalety ve 4. patře)
-- pouze deaktivujeme; completion historie se nemaže.
update public.cleaning_tasks task
set active = false
from public.rooms room
join public.buildings building on building.id = room.building_id
where task.room_id = room.id
  and building.name = 'Škola'
  and room.active = false;

-- Druh místnosti určuje explicitní sadu jednotlivých úkolů.
with room_kinds(floor_name, room_name, room_kind) as (
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
    ('2. patro', 'Školní zázemí', 'standard'),
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
), task_templates(room_kind, task_name, activity_type, frequency, schedule_days, sort_order, assignment_mode, rotation_anchor_date) as (
  values
    ('traffic', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40, 'fixed', null::date),
    ('traffic', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50, 'fixed', null::date),
    ('traffic', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30, 'fixed', null::date),
    ('standard', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10, 'fixed', null::date),
    ('standard', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30, 'fixed', null::date),
    ('standard', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40, 'fixed', null::date),
    ('standard', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50, 'fixed', null::date),
    ('kitchen', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10, 'fixed', null::date),
    ('kitchen', 'Vyčistit umyvadlo a baterii', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20, 'fixed', null::date),
    ('kitchen', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30, 'fixed', null::date),
    ('kitchen', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40, 'fixed', null::date),
    ('kitchen', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50, 'fixed', null::date),
    ('tables', 'Vynést koše', 'trash', 'cleaning_day', array[1,3,5]::smallint[], 10, 'fixed', null::date),
    ('tables', 'Otřít stoly', 'tables', 'weekly', array[3]::smallint[], 20, 'rotating', date '2026-08-26'),
    ('tables', 'Dezinfikovat kliky a vypínače', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30, 'fixed', null::date),
    ('tables', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40, 'fixed', null::date),
    ('tables', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50, 'fixed', null::date),
    ('toilet', 'Vyčistit WC a splachovadla', 'toilet', 'cleaning_day', array[1,3,5]::smallint[], 10, 'fixed', null::date),
    ('toilet', 'Vyčistit umyvadla a baterie', 'sink', 'cleaning_day', array[1,3,5]::smallint[], 20, 'fixed', null::date),
    ('toilet', 'Vyčistit zrcadla', 'mirror', 'cleaning_day', array[1,3,5]::smallint[], 25, 'fixed', null::date),
    ('toilet', 'Dezinfikovat kliky, vypínače, baterie a splachovadla', 'disinfect', 'cleaning_day', array[1,3,5]::smallint[], 30, 'fixed', null::date),
    ('toilet', 'Zamést / vysát podlahu', 'vacuum', 'cleaning_day', array[1,3,5]::smallint[], 40, 'fixed', null::date),
    ('toilet', 'Vytřít podlahu', 'mop', 'cleaning_day', array[1,3,5]::smallint[], 50, 'fixed', null::date)
), resolved_rooms as (
  select room.id, floor.name as floor_name, kind.room_kind,
         case when floor.name in ('1. patro', '2. patro') then 'A' else 'B' end as part_code
  from room_kinds kind
  join public.buildings building on building.name = 'Škola'
  join public.floors floor
    on floor.building_id = building.id and floor.name = kind.floor_name
  join public.rooms room
    on room.building_id = building.id
   and room.floor_id = floor.id
   and room.name = kind.room_name
)
insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, schedule_days, sort_order,
  assignment_mode, rotation_anchor_date, rotation_interval_weeks, work_part_id
)
select room.id, template.task_name, template.activity_type,
       template.frequency::public.task_frequency, true, template.schedule_days,
       template.sort_order, template.assignment_mode::public.task_assignment_mode,
       template.rotation_anchor_date, 1, part.id
from resolved_rooms room
join task_templates template on template.room_kind = room.room_kind
join public.cleaning_work_parts part on part.code = room.part_code and part.active
where not exists (
  select 1 from public.cleaning_tasks existing
  where existing.room_id = room.id
    and existing.activity_type = template.activity_type
    and existing.active
);

-- Původní společný úkol umyvadel a zrcadel zachová ID a historii jako úkol
-- umyvadel; zrcadla jsou od této migrace samostatná činnost.
update public.cleaning_tasks task
set name = 'Vyčistit umyvadla a baterie'
from public.rooms room
where task.room_id = room.id
  and room.active
  and task.activity_type = 'sink'
  and task.name = 'Vyčistit umyvadla, baterie a zrcadla';

-- Všechny aktivní úkoly cílových místností dostanou správnou část A/B.
update public.cleaning_tasks task
set work_part_id = part.id
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
join public.cleaning_work_parts part
  on part.building_id = building.id
 and part.code = case
   when floor.name in ('1. patro', '2. patro') then 'A'
   when floor.name in ('3. patro', '4. patro') then 'B'
 end
where task.room_id = room.id
  and building.name = 'Škola'
  and room.active
  and floor.name in ('1. patro', '2. patro', '3. patro', '4. patro');

-- Zachování pravidla: nejdříve zamést/vysát, potom vytřít.
update public.cleaning_tasks mop
set requires_task_id = vacuum.id
from public.cleaning_tasks vacuum
where mop.room_id = vacuum.room_id
  and mop.activity_type = 'mop'
  and vacuum.activity_type = 'vacuum'
  and mop.active and vacuum.active;

-- Nové středeční úkoly stolů převezmou rotační pracovníky podle user_id
-- z již existujícího rotačního úkolu, nikoli podle zobrazovaného jména.
with rotation_workers as (
  select distinct assignment.worker_id, assignment.rotation_order
  from public.task_assignments assignment
  join public.cleaning_tasks task on task.id = assignment.task_id
  where task.assignment_mode = 'rotating'
    and assignment.active
    and assignment.rotation_order is not null
), rotating_tasks as (
  select id from public.cleaning_tasks
  where active and assignment_mode = 'rotating' and activity_type = 'tables'
)
insert into public.task_assignments (task_id, worker_id, active, rotation_order)
select task.id, worker.worker_id, true, worker.rotation_order
from rotating_tasks task cross join rotation_workers worker
on conflict (task_id, worker_id)
do update set active = true, rotation_order = excluded.rotation_order;
