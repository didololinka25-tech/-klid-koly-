-- Korekce: na skutečné místnosti aplikovat pouze již schválený plán.
-- Nic se nemaže; nadbytečné úkoly z migrace 00900 se pouze deaktivují.

begin;

-- Úkoly domyšlené podle názvu místnosti nebyly součástí původního plánu.
-- Deaktivujeme pouze přesné kombinace místností a šablon vložených migrací 00900.
with nonplanned_rooms(floor_name, room_name) as (
  values
    ('1. patro', 'Kuchyň'),
    ('1. patro', 'Jídelna'),
    ('1. patro', 'Úklidová místnost'),
    ('1. patro', 'Společenská místnost'),
    ('1. patro', 'Řadírna'),
    ('3. patro', 'Ateliér'),
    ('3. patro', 'Úklidová místnost'),
    ('3. patro', 'Místnost s nářadím'),
    ('3. patro', 'Pohybovka'),
    ('4. patro', 'Mediační místnost')
), resolved_rooms as (
  select room.id
  from nonplanned_rooms target
  join public.buildings building on building.name = 'Škola'
  join public.floors floor
    on floor.building_id = building.id and floor.name = target.floor_name
  join public.rooms room
    on room.building_id = building.id
   and room.floor_id = floor.id
   and room.name = target.room_name
)
update public.cleaning_tasks task
set active = false
from resolved_rooms room
where task.room_id = room.id
  and task.name in (
    'Vynést koše',
    'Vyčistit umyvadlo a baterii',
    'Otřít stoly',
    'Dezinfikovat kliky a vypínače',
    'Zamést / vysát podlahu',
    'Vytřít podlahu'
  );

-- Učebny přebírají z původních Tříd pouze koše a středeční stoly.
with target_room as (
  select room.id
  from public.rooms room
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Učebny'
)
update public.cleaning_tasks task
set active = false
from target_room room
where task.room_id = room.id
  and task.name in (
    'Dezinfikovat kliky a vypínače',
    'Zamést / vysát podlahu',
    'Vytřít podlahu'
  );

-- Školní zázemí nemá v původním plánu automaticky domyšlené koše ani podlahy.
with target_room as (
  select room.id
  from public.rooms room
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Školní zázemí'
)
update public.cleaning_tasks task
set active = false
from target_room room
where task.room_id = room.id
  and task.name in (
    'Vynést koše',
    'Dezinfikovat kliky a vypínače',
    'Zamést / vysát podlahu',
    'Vytřít podlahu'
  );

-- Skutečné chodby dostanou přesně původní tři činnosti Po/St/Pá.
with corridor_rooms(floor_name, room_name) as (
  values
    ('1. patro', 'Vstup'),
    ('1. patro', 'Šatna / chodba'),
    ('2. patro', 'Chodba'),
    ('3. patro', 'Chodba'),
    ('4. patro', 'Chodba')
), resolved_rooms as (
  select room.id
  from corridor_rooms target
  join public.buildings building on building.name = 'Škola'
  join public.floors floor
    on floor.building_id = building.id and floor.name = target.floor_name
  join public.rooms room
    on room.building_id = building.id
   and room.floor_id = floor.id
   and room.name = target.room_name
)
update public.cleaning_tasks task
set active = true,
    frequency = 'cleaning_day',
    schedule_days = array[1,3,5]::smallint[]
from resolved_rooms room
where task.room_id = room.id
  and task.activity_type in ('vacuum', 'mop', 'disinfect');

-- Každé skutečné WC má samostatně WC, umyvadla, zrcadla, dezinfekci a podlahy.
with toilet_rooms(floor_name, room_name) as (
  values
    ('1. patro', 'WC dívky'),
    ('1. patro', 'WC kluci'),
    ('1. patro', 'WC ženy'),
    ('2. patro', 'WC kluci'),
    ('2. patro', 'WC dívky'),
    ('2. patro', 'WC dospělí'),
    ('3. patro', 'WC holky'),
    ('3. patro', 'WC kluci')
), resolved_rooms as (
  select room.id
  from toilet_rooms target
  join public.buildings building on building.name = 'Škola'
  join public.floors floor
    on floor.building_id = building.id and floor.name = target.floor_name
  join public.rooms room
    on room.building_id = building.id
   and room.floor_id = floor.id
   and room.name = target.room_name
)
update public.cleaning_tasks task
set active = true,
    frequency = 'cleaning_day',
    schedule_days = array[1,3,5]::smallint[]
from resolved_rooms room
where task.room_id = room.id
  and task.activity_type in ('toilet', 'sink', 'mirror', 'disinfect', 'vacuum', 'mop');

-- Učebny: původní koše Po/St/Pá a stoly ve středu, včetně existující rotace.
with target_room as (
  select room.id
  from public.rooms room
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Učebny'
)
update public.cleaning_tasks task
set active = true,
    frequency = case when task.activity_type = 'tables' then 'weekly'::public.task_frequency else 'cleaning_day'::public.task_frequency end,
    schedule_days = case when task.activity_type = 'tables' then array[3]::smallint[] else array[1,3,5]::smallint[] end
from target_room room
where task.room_id = room.id
  and task.activity_type in ('trash', 'tables');

-- Školní zázemí: jediný výslovně požadovaný úkol stolů zkopírujeme
-- z existujícího rotačního úkolu Učeben, nikoli z názvu osoby.
with source_task as (
  select task.*
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Učebny'
    and task.activity_type = 'tables'
  order by task.created_at
  limit 1
), target as (
  select room.id as room_id, part.id as work_part_id
  from public.rooms room
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  join public.cleaning_work_parts part
    on part.building_id = building.id and part.code = 'A' and part.active
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Školní zázemí'
)
insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  monthly_day, work_part_id, assignment_mode, rotation_anchor_date,
  rotation_interval_weeks
)
select target.room_id, source.name, source.activity_type, source.frequency,
       true, source.sort_order, source.schedule_days, source.monthly_day,
       target.work_part_id, source.assignment_mode, source.rotation_anchor_date,
       source.rotation_interval_weeks
from source_task source cross join target
where not exists (
  select 1 from public.cleaning_tasks existing
  where existing.room_id = target.room_id and existing.activity_type = 'tables'
);

-- Pokud už úkol stolů ve Školním zázemí existuje, pouze jej normalizujeme.
update public.cleaning_tasks task
set active = true,
    frequency = 'weekly',
    schedule_days = array[3]::smallint[],
    assignment_mode = 'rotating',
    rotation_anchor_date = coalesce(task.rotation_anchor_date, date '2026-08-26'),
    rotation_interval_weeks = coalesce(task.rotation_interval_weeks, 1),
    work_part_id = part.id
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
join public.cleaning_work_parts part
  on part.building_id = building.id and part.code = 'A' and part.active
where task.room_id = room.id
  and building.name = 'Škola'
  and floor.name = '2. patro'
  and room.name = 'Školní zázemí'
  and task.activity_type = 'tables';

-- Rotaci stolů zkopírujeme podle worker_id/rotation_order z Učeben.
with source_assignments as (
  select assignment.worker_id, assignment.rotation_order
  from public.task_assignments assignment
  join public.cleaning_tasks task on task.id = assignment.task_id
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Učebny'
    and task.activity_type = 'tables'
    and assignment.active
), target_task as (
  select task.id
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.floors floor on floor.id = room.floor_id
  join public.buildings building on building.id = room.building_id
  where building.name = 'Škola'
    and floor.name = '2. patro'
    and room.name = 'Školní zázemí'
    and task.activity_type = 'tables'
    and task.active
)
insert into public.task_assignments (task_id, worker_id, active, rotation_order)
select target.id, source.worker_id, true, source.rotation_order
from target_task target cross join source_assignments source
on conflict (task_id, worker_id)
do update set active = true, rotation_order = excluded.rotation_order;

-- Schodiště: vysávání každý úklidový den, vytírání pouze Po/Pá.
update public.cleaning_tasks task
set active = true,
    frequency = 'cleaning_day',
    schedule_days = array[1,3,5]::smallint[]
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
where task.room_id = room.id
  and building.name = 'Škola'
  and floor.name = 'Schodiště'
  and room.name = 'Schodiště'
  and task.activity_type = 'vacuum';

update public.cleaning_tasks task
set active = true,
    frequency = 'once_or_twice_weekly',
    schedule_days = array[1,5]::smallint[]
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
where task.room_id = room.id
  and building.name = 'Škola'
  and floor.name = 'Schodiště'
  and room.name = 'Schodiště'
  and task.activity_type = 'mop';

-- A/B: běžný plán 1.–2. patra = A, 3.–4. patra = B.
-- Učebny zachovávají původní výjimku části B z generické místnosti Třídy.
update public.cleaning_tasks task
set work_part_id = part.id
from public.rooms room
join public.floors floor on floor.id = room.floor_id
join public.buildings building on building.id = room.building_id
join public.cleaning_work_parts part
  on part.building_id = building.id
 and part.code = case
   when floor.name = '2. patro' and room.name = 'Učebny' then 'B'
   when floor.name in ('1. patro', '2. patro') then 'A'
   when floor.name in ('3. patro', '4. patro') then 'B'
 end
where task.room_id = room.id
  and task.active
  and building.name = 'Škola'
  and floor.name in ('1. patro', '2. patro', '3. patro', '4. patro');

-- Requires vazby se opravují pouze mezi aktivními úkoly stejné místnosti.
update public.cleaning_tasks mop
set requires_task_id = vacuum.id
from public.cleaning_tasks vacuum
where mop.room_id = vacuum.room_id
  and mop.activity_type = 'mop'
  and vacuum.activity_type = 'vacuum'
  and mop.active
  and vacuum.active;

commit;
