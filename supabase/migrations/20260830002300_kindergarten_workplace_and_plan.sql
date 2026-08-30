-- Druhé pracoviště Školka a opatrný výchozí úterní plán.
-- Nedestruktivní: existující školní data ani historii nemění.
begin;

insert into public.buildings(name, active)
values ('Školka', true)
on conflict (name) do update set active = true;

insert into public.floors(building_id, name, sort_order)
select id, 'Prostory', 10 from public.buildings where name = 'Školka'
on conflict (building_id, name) do update set sort_order = excluded.sort_order;

with desired(name, sort_order) as (
  values
    ('Kuchyň',10),('Vstup',20),('Šatna',30),('WC dívky',40),
    ('WC chlapci',50),('WC dospělí',60),('Úklidová místnost',70),
    ('Chodbička',80),('Místnost 1',90),('Místnost 2',100),
    ('Místnost 3 – spací',110)
)
insert into public.rooms(building_id, floor_id, name, active, sort_order)
select building.id, floor.id, desired.name, true, desired.sort_order
from desired
join public.buildings building on building.name = 'Školka'
join public.floors floor on floor.building_id = building.id and floor.name = 'Prostory'
on conflict (building_id, floor_id, name) do update
set active = true, sort_order = excluded.sort_order;

with plan(room_name, task_code, task_name, activity_type, sort_order, requires_code) as (
  values
    ('Vstup','vacuum','Zamést / vysát podlahu','vacuum',10,null),
    ('Vstup','mop','Vytřít podlahu','mop',20,'vacuum'),
    ('Vstup','trash','Vynést koš','trash',30,null),
    ('Šatna','vacuum','Zamést / vysát podlahu','vacuum',10,null),
    ('Šatna','mop','Vytřít podlahu','mop',20,'vacuum'),
    ('Šatna','trash','Vynést koš','trash',30,null),
    ('Šatna','benches','Otřít lavičky a běžné povrchy','tables',40,null),
    ('Kuchyň','trash','Vynést koše','trash',10,null),
    ('Kuchyň','sink','Vyčistit dřez / umyvadlo a baterii','sink',20,null),
    ('Kuchyň','vacuum','Zamést / vysát podlahu','vacuum',30,null),
    ('Kuchyň','mop','Vytřít podlahu','mop',40,'vacuum'),
    ('Úklidová místnost','utility-sink','Vyčistit výlevku / technické umyvadlo','sink',10,null),
    ('Úklidová místnost','vacuum','Zamést / vysát podlahu','vacuum',20,null),
    ('Úklidová místnost','mop','Vytřít podlahu','mop',30,'vacuum'),
    ('Chodbička','vacuum','Zamést / vysát podlahu','vacuum',10,null),
    ('Chodbička','mop','Vytřít podlahu','mop',20,'vacuum'),
    ('Místnost 1','trash','Vynést koš','trash',10,null),
    ('Místnost 1','vacuum','Zamést / vysát podlahu','vacuum',20,null),
    ('Místnost 1','mop','Vytřít podlahu','mop',30,'vacuum'),
    ('Místnost 2','trash','Vynést koš','trash',10,null),
    ('Místnost 2','vacuum','Zamést / vysát podlahu','vacuum',20,null),
    ('Místnost 2','mop','Vytřít podlahu','mop',30,'vacuum'),
    ('Místnost 3 – spací','trash','Vynést koš','trash',10,null),
    ('Místnost 3 – spací','vacuum','Zamést / vysát podlahu','vacuum',20,null),
    ('Místnost 3 – spací','mop','Vytřít podlahu','mop',30,'vacuum')
), toilets(room_name) as (
  values ('WC dívky'),('WC chlapci'),('WC dospělí')
), toilet_tasks(task_code,task_name,activity_type,sort_order,requires_code) as (
  values
    ('toilet','Vyčistit toaletu a splachování','toilet',10,null),
    ('sink','Vyčistit umyvadlo a baterii','sink',20,null),
    ('mirror','Vyčistit zrcadlo','mirror',30,null),
    ('trash','Vynést koš','trash',40,null),
    ('vacuum','Zamést / vysát podlahu','vacuum',50,null),
    ('mop','Vytřít podlahu','mop',60,'vacuum')
), complete_plan as (
  select * from plan
  union all
  select toilets.room_name, task_code, task_name, activity_type, sort_order, requires_code
  from toilets cross join toilet_tasks
)
insert into public.cleaning_tasks(
  plan_key, room_id, name, activity_type, frequency, active, sort_order,
  schedule_days, monthly_day, requires_task_id, work_part_id, assignment_mode,
  rotation_anchor_date, rotation_interval_weeks, cleaning_cycle_length,
  cleaning_cycle_offset, period_months, period_week, period_anchor_month
)
select
  'v2026-kindergarten|Prostory|' || complete_plan.room_name || '|' || complete_plan.task_code,
  room.id, complete_plan.task_name, complete_plan.activity_type,
  'cleaning_day'::public.task_frequency, true, complete_plan.sort_order,
  array[2]::smallint[], null, null, null, 'fixed', null, 1,
  null, null, null, null, null
from complete_plan
join public.buildings building on building.name = 'Školka'
join public.floors floor on floor.building_id = building.id and floor.name = 'Prostory'
join public.rooms room on room.building_id = building.id
  and room.floor_id = floor.id and room.name = complete_plan.room_name
on conflict (plan_key) where plan_key is not null do update set
  room_id=excluded.room_id, name=excluded.name, activity_type=excluded.activity_type,
  frequency=excluded.frequency, active=true, sort_order=excluded.sort_order,
  schedule_days=excluded.schedule_days, monthly_day=null, requires_task_id=null,
  work_part_id=null, assignment_mode='fixed', rotation_anchor_date=null,
  rotation_interval_weeks=1, cleaning_cycle_length=null,
  cleaning_cycle_offset=null, period_months=null, period_week=null,
  period_anchor_month=null;

update public.cleaning_tasks mop
set requires_task_id = vacuum.id
from public.cleaning_tasks vacuum
where mop.active and mop.plan_key like 'v2026-kindergarten|%|mop'
  and vacuum.active
  and vacuum.plan_key = regexp_replace(mop.plan_key, '[^|]+$', 'vacuum');

do $$
begin
  if (select count(*) from public.rooms room join public.buildings building on building.id=room.building_id where building.name='Školka' and room.active) <> 11 then
    raise exception 'Školka nemá přesně 11 aktivních prostorů.';
  end if;
  if (select count(*) from public.cleaning_tasks where active and plan_key like 'v2026-kindergarten|%') <> 43 then
    raise exception 'Výchozí plán Školky nemá přesně 43 aktivních úkolů.';
  end if;
  if exists (select 1 from public.cleaning_tasks where active and plan_key like 'v2026-kindergarten|%' and (schedule_days <> array[2]::smallint[] or activity_type='disinfect' or work_part_id is not null)) then
    raise exception 'Plán Školky není čistý úterní týmový plán.';
  end if;
  if exists (select 1 from public.cleaning_tasks mop where mop.active and mop.plan_key like 'v2026-kindergarten|%|mop' and not exists (select 1 from public.cleaning_tasks vacuum where vacuum.id=mop.requires_task_id and vacuum.room_id=mop.room_id and vacuum.activity_type='vacuum' and vacuum.active)) then
    raise exception 'Některé vytírání ve Školce nemá správnou dependency.';
  end if;
end $$;

commit;
