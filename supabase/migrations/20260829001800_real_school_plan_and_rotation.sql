-- Skutečná struktura školy, rotační plán pater a obecné periodické úkoly.
-- Nedestruktivní: historické rooms, tasks a completions se nemažou.

begin;

alter table public.cleaning_tasks
  add column if not exists plan_key text,
  add column if not exists cleaning_cycle_length smallint,
  add column if not exists cleaning_cycle_offset smallint,
  add column if not exists period_months smallint,
  add column if not exists period_week smallint,
  add column if not exists period_anchor_month date;

create unique index if not exists cleaning_tasks_plan_key_unique
  on public.cleaning_tasks(plan_key) where plan_key is not null;

alter table public.cleaning_tasks drop constraint if exists cleaning_tasks_cycle_valid;
alter table public.cleaning_tasks add constraint cleaning_tasks_cycle_valid check (
  (cleaning_cycle_length is null and cleaning_cycle_offset is null)
  or (cleaning_cycle_length >= 2 and cleaning_cycle_offset between 0 and cleaning_cycle_length - 1)
);
alter table public.cleaning_tasks drop constraint if exists cleaning_tasks_period_valid;
alter table public.cleaning_tasks add constraint cleaning_tasks_period_valid check (
  (period_months is null and period_week is null and period_anchor_month is null)
  or (period_months >= 1 and period_week between 1 and 4 and period_anchor_month is not null)
);

alter table public.cleaning_tasks drop constraint if exists cleaning_tasks_activity_type_valid;
alter table public.cleaning_tasks add constraint cleaning_tasks_activity_type_valid check (
  -- Legacy hodnoty včetně disinfect zůstávají schema-validní kvůli historii.
  -- Produkt je nezobrazuje a aktivní disinfect řádky se níže deaktivují.
  activity_type in (
    'trash','toilet','sink','mirror','vacuum','mop','tables','windows',
    'disinfect','doors','tiles','surfaces','deep_clean','laundry','other'
  )
);

-- Chybějící skutečné místnosti. Existující ID se zachovávají.
with desired(floor_name, room_name, sort_order) as (
  values
    ('1. patro','Vstup',10),('1. patro','Šatna / chodba',20),
    ('1. patro','Kuchyň',30),('1. patro','Jídelna',40),
    ('1. patro','Úklidová místnost',50),('1. patro','Společenská místnost',60),
    ('1. patro','WC dívky',70),('1. patro','WC kluci',80),
    ('1. patro','WC ženy',90),('1. patro','Řadírna',100),('1. patro','Chodba',110),
    ('2. patro','WC kluci',10),('2. patro','WC dívky',20),
    ('2. patro','WC dospělí',30),('2. patro','Chodba',40),
    ('2. patro','Školní zázemí',50),('2. patro','Učebna 1',60),
    ('2. patro','Učebna 2',70),('2. patro','Učebna 3',80),
    ('2. patro','Učebna 4',90),('2. patro','Učebna 5',100),
    ('3. patro','Ateliér',10),('3. patro','WC holky',20),
    ('3. patro','WC kluci',30),('3. patro','WC / sprcha',40),
    ('3. patro','Úklidová místnost',50),('3. patro','Místnost s nářadím',60),
    ('3. patro','Pohybovka',70),('3. patro','Chodba',80),
    ('4. patro','Mediační místnost',10),('4. patro','Chodba',20),
    ('Schodiště','Schodiště',10)
)
insert into public.rooms(building_id, floor_id, name, active, sort_order)
select building.id, floor.id, desired.room_name, true, desired.sort_order
from desired
join public.buildings building on building.name = 'Škola'
join public.floors floor on floor.building_id = building.id and floor.name = desired.floor_name
on conflict (building_id, floor_id, name) do update
set active = true, sort_order = excluded.sort_order;

-- Staré agregované/generické místnosti pouze deaktivujeme.
with desired(floor_name, room_name) as (
  values
    ('1. patro','Vstup'),('1. patro','Šatna / chodba'),('1. patro','Kuchyň'),
    ('1. patro','Jídelna'),('1. patro','Úklidová místnost'),('1. patro','Společenská místnost'),
    ('1. patro','WC dívky'),('1. patro','WC kluci'),('1. patro','WC ženy'),
    ('1. patro','Řadírna'),('1. patro','Chodba'),
    ('2. patro','WC kluci'),('2. patro','WC dívky'),('2. patro','WC dospělí'),
    ('2. patro','Chodba'),('2. patro','Školní zázemí'),('2. patro','Učebna 1'),
    ('2. patro','Učebna 2'),('2. patro','Učebna 3'),('2. patro','Učebna 4'),('2. patro','Učebna 5'),
    ('3. patro','Ateliér'),('3. patro','WC holky'),('3. patro','WC kluci'),
    ('3. patro','WC / sprcha'),('3. patro','Úklidová místnost'),
    ('3. patro','Místnost s nářadím'),('3. patro','Pohybovka'),('3. patro','Chodba'),
    ('4. patro','Mediační místnost'),('4. patro','Chodba'),('Schodiště','Schodiště')
)
update public.rooms room set active = false
from public.buildings building
where room.building_id = building.id and building.name = 'Škola'
  and not exists (
    select 1 from desired
    join public.floors floor on floor.building_id = building.id and floor.name = desired.floor_name
    where room.floor_id = floor.id and desired.room_name = room.name
  );

-- Při prvním běhu odstavíme starý plán. Opakovaný běh seedu později
-- nedeaktivuje nové ručně vytvořené úkoly bez plan_key.
do $$
begin
  if not exists (select 1 from public.cleaning_tasks where plan_key like 'v2026|%') then
    update public.cleaning_tasks task set active = false
    where task.room_id in (
      select room.id from public.rooms room
      join public.buildings building on building.id = room.building_id
      where building.name = 'Škola'
    ) or task.room_id is null;
  end if;
end;
$$;

update public.cleaning_tasks set active = false where activity_type = 'disinfect' and active;
update public.task_assignments set active = false where active;
update public.cleaning_work_parts set active = false where active;
update public.work_part_assignments set active = false, ends_on = coalesce(ends_on, current_date) where active;

-- Migrační staging není TEMP: Supabase SQL Editor tak nemůže tabulku ztratit
-- mezi příkazy kvůli implicitnímu COMMITu. Vzniká i zaniká uvnitř této jediné
-- transakce, nikdy se nestane součástí výsledného schématu ani API.
drop table if exists public._migration_01800_desired_cleaning_plan;
create table public._migration_01800_desired_cleaning_plan (
  floor_name text,
  room_name text,
  task_code text,
  task_name text,
  activity_type text,
  frequency text,
  schedule_days smallint[],
  sort_order integer,
  period_months smallint,
  period_week smallint,
  period_anchor_month date,
  requires_code text
);

-- 1. patro: při každém úklidovém dni plus rozložené týdenní/periodické práce.
insert into public._migration_01800_desired_cleaning_plan values
('1. patro','Vstup','carpet-vacuum','Vysát koberec','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Vstup','carpet-deep','Hloubkově vyčistit koberec vodním vysavačem','deep_clean','monthly','{1,3,5}',20,3,1,'2026-09-01',null),
('1. patro','Vstup','bench','Otřít lavičku','tables','weekly','{1}',30,null,null,null,null),
('1. patro','Vstup','glass','Umýt skla','windows','monthly','{1,3,5}',40,1,2,'2026-09-01',null),
('1. patro','Vstup','doors','Umýt dveře','doors','monthly','{1,3,5}',50,1,1,'2026-09-01',null),

('1. patro','Šatna / chodba','carpet-vacuum','Vysát koberec','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Šatna / chodba','carpet-deep','Hloubkově vyčistit koberec vodním vysavačem','deep_clean','monthly','{1,3,5}',20,3,2,'2026-09-01',null),
('1. patro','Šatna / chodba','trash','Vynést koš','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('1. patro','Šatna / chodba','benches','Otřít lavičky','tables','weekly','{1}',40,null,null,null,null),
('1. patro','Šatna / chodba','lockers','Otřít skříňky zvenku','surfaces','monthly','{1,3,5}',50,1,4,'2026-09-01',null),
('1. patro','Šatna / chodba','glass','Umýt skla','windows','monthly','{1,3,5}',60,1,2,'2026-09-01',null),
('1. patro','Šatna / chodba','doors','Umýt dveře','doors','monthly','{1,3,5}',70,1,1,'2026-09-01',null),

('1. patro','Kuchyň','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Kuchyň','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('1. patro','Kuchyň','trash','Vynést koše','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('1. patro','Kuchyň','sink','Vyčistit umyvadla a baterie','sink','cleaning_day','{1,3,5}',40,null,null,null,null),
('1. patro','Kuchyň','doors','Umýt dveře','doors','monthly','{1,3,5}',50,1,1,'2026-09-01',null),
('1. patro','Kuchyň','windows','Umýt okna','windows','monthly','{1,3,5}',60,1,2,'2026-09-01',null),

('1. patro','Jídelna','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Jídelna','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('1. patro','Jídelna','trash','Vynést koš','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('1. patro','Jídelna','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',40,null,null,null,null),
('1. patro','Jídelna','tables','Otřít stoly','tables','weekly','{3}',50,null,null,null,null),
('1. patro','Jídelna','sills','Otřít parapety','surfaces','weekly','{1}',60,null,null,null,null),
('1. patro','Jídelna','mirror','Vyčistit zrcadlo','mirror','weekly','{5}',70,null,null,null,null),
('1. patro','Jídelna','lockers','Otřít skříňky zvenku','surfaces','monthly','{1,3,5}',80,1,4,'2026-09-01',null),
('1. patro','Jídelna','windows','Umýt okna','windows','monthly','{1,3,5}',90,1,2,'2026-09-01',null),
('1. patro','Jídelna','doors','Umýt dveře','doors','monthly','{1,3,5}',100,1,1,'2026-09-01',null),

('1. patro','Úklidová místnost','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Úklidová místnost','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('1. patro','Úklidová místnost','utility-sink','Vyčistit výlevku','sink','cleaning_day','{1,3,5}',30,null,null,null,null),
('1. patro','Úklidová místnost','shelves','Otřít police','surfaces','monthly','{1,3,5}',40,1,4,'2026-09-01',null),
('1. patro','Úklidová místnost','doors','Umýt dveře','doors','monthly','{1,3,5}',50,1,1,'2026-09-01',null),

('1. patro','Společenská místnost','vacuum','Zamést / vysát normální podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Společenská místnost','mop','Vytřít normální podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('1. patro','Společenská místnost','carpet-vacuum','Vysát koberec','vacuum','cleaning_day','{1,3,5}',30,null,null,null,null),
('1. patro','Společenská místnost','carpet-deep','Hloubkově vyčistit koberec vodním vysavačem','deep_clean','monthly','{1,3,5}',40,3,3,'2026-09-01',null),
('1. patro','Společenská místnost','trash','Vynést koš','trash','cleaning_day','{1,3,5}',50,null,null,null,null),
('1. patro','Společenská místnost','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',60,null,null,null,null),
('1. patro','Společenská místnost','tables','Otřít stoly','tables','weekly','{3}',70,null,null,null,null),
('1. patro','Společenská místnost','sills','Otřít parapety','surfaces','weekly','{1}',80,null,null,null,null),
('1. patro','Společenská místnost','couches','Vysát a očistit gauče','surfaces','monthly','{1,3,5}',90,1,4,'2026-09-01',null),
('1. patro','Společenská místnost','windows','Umýt okna','windows','monthly','{1,3,5}',100,1,2,'2026-09-01',null),
('1. patro','Společenská místnost','doors','Umýt dveře','doors','monthly','{1,3,5}',110,1,1,'2026-09-01',null),

('1. patro','Řadírna','foam-vacuum','Vysát pěnovou podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Řadírna','foam-deep','Rozebrat pěnovou podlahu a vytřít pod ní','deep_clean','monthly','{1,3,5}',20,2,4,'2026-09-01',null),
('1. patro','Řadírna','window','Umýt okno','windows','monthly','{1,3,5}',30,1,2,'2026-09-01',null),
('1. patro','Řadírna','doors','Umýt dveře','doors','monthly','{1,3,5}',40,1,1,'2026-09-01',null),

('1. patro','Chodba','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('1. patro','Chodba','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum');

-- Stejný úplný plán pro tři toalety v 1. patře.
insert into public._migration_01800_desired_cleaning_plan
select '1. patro', room_name, task_code, task_name, activity_type, frequency,
       schedule_days, sort_order, period_months, period_week, period_anchor_month, requires_code
from (values ('WC dívky'),('WC kluci'),('WC ženy')) rooms(room_name)
cross join (values
  ('toilet','Vyčistit záchod a splachovadlo','toilet','cleaning_day','{1,3,5}'::smallint[],10,null::smallint,null::smallint,null::date,null::text),
  ('sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',20,null,null,null,null),
  ('mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',30,null,null,null,null),
  ('trash','Vynést koš','trash','cleaning_day','{1,3,5}',40,null,null,null,null),
  ('vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',50,null,null,null,null),
  ('mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',60,null,null,null,'vacuum'),
  ('tiles','Umýt kachličky a obklady','tiles','monthly','{1,3,5}',70,1,3,'2026-09-01',null),
  ('doors','Umýt dveře','doors','monthly','{1,3,5}',80,1,1,'2026-09-01',null)
) task(task_code,task_name,activity_type,frequency,schedule_days,sort_order,period_months,period_week,period_anchor_month,requires_code);

-- 2. patro: návštěvy střídá cleaning_cycle trigger; týdenní práce jsou při první návštěvě týdne.
insert into public._migration_01800_desired_cleaning_plan values
('2. patro','WC kluci','toilet','Vyčistit záchod','toilet','cleaning_day','{1,3,5}',10,null,null,null,null),
('2. patro','WC kluci','urinal','Vyčistit pisoár','toilet','cleaning_day','{1,3,5}',20,null,null,null,null),
('2. patro','WC kluci','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',30,null,null,null,null),
('2. patro','WC kluci','mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',40,null,null,null,null),
('2. patro','WC kluci','trash','Vynést koš','trash','cleaning_day','{1,3,5}',50,null,null,null,null),
('2. patro','WC kluci','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',60,null,null,null,null),
('2. patro','WC kluci','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',70,null,null,null,'vacuum'),
('2. patro','WC kluci','tiles','Umýt kachličky','tiles','monthly','{1,3,5}',80,1,3,'2026-09-01',null),
('2. patro','WC kluci','doors','Umýt dveře','doors','monthly','{1,3,5}',90,1,1,'2026-09-01',null),

('2. patro','WC dívky','toilet','Vyčistit záchod','toilet','cleaning_day','{1,3,5}',10,null,null,null,null),
('2. patro','WC dívky','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',20,null,null,null,null),
('2. patro','WC dívky','mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',30,null,null,null,null),
('2. patro','WC dívky','trash','Vynést koš','trash','cleaning_day','{1,3,5}',40,null,null,null,null),
('2. patro','WC dívky','utility-sink','Vyčistit výlevku','sink','cleaning_day','{1,3,5}',50,null,null,null,null),
('2. patro','WC dívky','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',60,null,null,null,null),
('2. patro','WC dívky','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',70,null,null,null,'vacuum'),
('2. patro','WC dívky','tiles','Umýt kachličky','tiles','monthly','{1,3,5}',80,1,3,'2026-09-01',null),
('2. patro','WC dívky','doors','Umýt dveře','doors','monthly','{1,3,5}',90,1,1,'2026-09-01',null),

('2. patro','Chodba','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('2. patro','Chodba','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),

('2. patro','Školní zázemí','vacuum','Zamést / vysát podlahy','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('2. patro','Školní zázemí','mop','Vytřít podlahy','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('2. patro','Školní zázemí','trash','Vynést koš','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('2. patro','Školní zázemí','tables','Otřít stoly','tables','weekly','{1,3}',40,null,null,null,null),
('2. patro','Školní zázemí','sills','Otřít parapety','surfaces','weekly','{1,3}',50,null,null,null,null),
('2. patro','Školní zázemí','windows','Umýt okna','windows','monthly','{1,3,5}',60,1,2,'2026-09-01',null),
('2. patro','Školní zázemí','doors','Umýt dveře','doors','monthly','{1,3,5}',70,1,1,'2026-09-01',null);

-- WC dospělí a pět samostatných učeben.
insert into public._migration_01800_desired_cleaning_plan
select '2. patro','WC dospělí',task_code,task_name,activity_type,frequency,schedule_days,
       sort_order,period_months,period_week,period_anchor_month,requires_code
from (values
  ('toilet','Vyčistit záchod','toilet','cleaning_day','{1,3,5}'::smallint[],10,null::smallint,null::smallint,null::date,null::text),
  ('sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',20,null,null,null,null),
  ('mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',30,null,null,null,null),
  ('trash','Vynést koš','trash','cleaning_day','{1,3,5}',40,null,null,null,null),
  ('vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',50,null,null,null,null),
  ('mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',60,null,null,null,'vacuum'),
  ('tiles','Umýt kachličky','tiles','monthly','{1,3,5}',70,1,3,'2026-09-01',null),
  ('doors','Umýt dveře','doors','monthly','{1,3,5}',80,1,1,'2026-09-01',null)
) task(task_code,task_name,activity_type,frequency,schedule_days,sort_order,period_months,period_week,period_anchor_month,requires_code);

insert into public._migration_01800_desired_cleaning_plan
select '2. patro',room_name,task_code,task_name,activity_type,frequency,schedule_days,
       sort_order,period_months,period_week,period_anchor_month,requires_code
from (values ('Učebna 1'),('Učebna 2'),('Učebna 3'),('Učebna 4'),('Učebna 5')) rooms(room_name)
cross join (values
  ('vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}'::smallint[],10,null::smallint,null::smallint,null::date,null::text),
  ('mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
  ('trash','Vynést koš','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
  ('sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',40,null,null,null,null),
  ('tables','Otřít stoly','tables','weekly','{1,3}',50,null,null,null,null),
  ('sills','Otřít parapety','surfaces','weekly','{1,3}',60,null,null,null,null),
  ('windows','Umýt okna','windows','monthly','{1,3,5}',70,1,2,'2026-09-01',null),
  ('doors','Umýt dveře','doors','monthly','{1,3,5}',80,1,1,'2026-09-01',null)
) task(task_code,task_name,activity_type,frequency,schedule_days,sort_order,period_months,period_week,period_anchor_month,requires_code);

-- 3. patro: stejná alternace jako 2. patro, s opačným offsetem.
insert into public._migration_01800_desired_cleaning_plan values
('3. patro','Ateliér','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','Ateliér','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('3. patro','Ateliér','trash','Vynést koše','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('3. patro','Ateliér','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',40,null,null,null,null),
('3. patro','Ateliér','basin','Vyčistit dřez a baterii','sink','cleaning_day','{1,3,5}',50,null,null,null,null),
('3. patro','Ateliér','tables','Otřít stoly','tables','weekly','{1,3}',60,null,null,null,null),
('3. patro','Ateliér','cabinets','Otřít skříňky','surfaces','monthly','{1,3,5}',70,1,4,'2026-09-01',null),
('3. patro','Ateliér','windows','Umýt okna','windows','monthly','{1,3,5}',80,1,2,'2026-09-01',null),
('3. patro','Ateliér','doors','Umýt dveře','doors','monthly','{1,3,5}',90,1,1,'2026-09-01',null),

('3. patro','WC / sprcha','toilet','Vyčistit záchod','toilet','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','WC / sprcha','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',20,null,null,null,null),
('3. patro','WC / sprcha','mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',30,null,null,null,null),
('3. patro','WC / sprcha','trash','Vynést koš','trash','cleaning_day','{1,3,5}',40,null,null,null,null),
('3. patro','WC / sprcha','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',50,null,null,null,null),
('3. patro','WC / sprcha','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',60,null,null,null,'vacuum'),
('3. patro','WC / sprcha','shower','Vyčistit sprchový kout','tiles','cleaning_day','{1,3,5}',70,null,null,null,null),
('3. patro','WC / sprcha','tiles','Umýt kachličky a obklady','tiles','monthly','{1,3,5}',80,1,3,'2026-09-01',null),
('3. patro','WC / sprcha','doors','Umýt dveře','doors','monthly','{1,3,5}',90,1,1,'2026-09-01',null),

('3. patro','Úklidová místnost','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','Úklidová místnost','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('3. patro','Úklidová místnost','utility-sink','Vyčistit výlevku','sink','cleaning_day','{1,3,5}',30,null,null,null,null),
('3. patro','Úklidová místnost','window','Umýt okno','windows','monthly','{1,3,5}',40,1,2,'2026-09-01',null),
('3. patro','Úklidová místnost','doors','Umýt dveře','doors','monthly','{1,3,5}',50,1,1,'2026-09-01',null),

('3. patro','Místnost s nářadím','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','Místnost s nářadím','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('3. patro','Místnost s nářadím','doors','Umýt dveře','doors','monthly','{1,3,5}',30,1,1,'2026-09-01',null),

('3. patro','Pohybovka','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','Pohybovka','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum'),
('3. patro','Pohybovka','trash','Vynést koš','trash','cleaning_day','{1,3,5}',30,null,null,null,null),
('3. patro','Pohybovka','sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',40,null,null,null,null),
('3. patro','Pohybovka','mirrors','Vyčistit zrcadla','mirror','cleaning_day','{1,3,5}',50,null,null,null,null),
('3. patro','Pohybovka','cabinets','Otřít skříňky','surfaces','monthly','{1,3,5}',60,1,4,'2026-09-01',null),
('3. patro','Pohybovka','windows','Umýt okna','windows','monthly','{1,3,5}',70,1,2,'2026-09-01',null),
('3. patro','Pohybovka','doors','Umýt dveře','doors','monthly','{1,3,5}',80,1,1,'2026-09-01',null),

('3. patro','Chodba','vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',10,null,null,null,null),
('3. patro','Chodba','mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',20,null,null,null,'vacuum');

-- Dvě běžná WC ve 3. patře.
insert into public._migration_01800_desired_cleaning_plan
select '3. patro',room_name,task_code,task_name,activity_type,frequency,schedule_days,
       sort_order,period_months,period_week,period_anchor_month,requires_code
from (values ('WC holky'),('WC kluci')) rooms(room_name)
cross join (values
  ('toilet','Vyčistit záchod','toilet','cleaning_day','{1,3,5}'::smallint[],10,null::smallint,null::smallint,null::date,null::text),
  ('sink','Vyčistit umyvadlo a baterii','sink','cleaning_day','{1,3,5}',20,null,null,null,null),
  ('mirror','Vyčistit zrcadlo','mirror','cleaning_day','{1,3,5}',30,null,null,null,null),
  ('trash','Vynést koš','trash','cleaning_day','{1,3,5}',40,null,null,null,null),
  ('vacuum','Zamést / vysát podlahu','vacuum','cleaning_day','{1,3,5}',50,null,null,null,null),
  ('mop','Vytřít podlahu','mop','cleaning_day','{1,3,5}',60,null,null,null,'vacuum'),
  ('tiles','Umýt kachličky','tiles','monthly','{1,3,5}',70,1,3,'2026-09-01',null),
  ('doors','Umýt dveře','doors','monthly','{1,3,5}',80,1,1,'2026-09-01',null)
) task(task_code,task_name,activity_type,frequency,schedule_days,sort_order,period_months,period_week,period_anchor_month,requires_code);

-- 4. patro a schodiště jednou týdně v pátek.
insert into public._migration_01800_desired_cleaning_plan values
('4. patro','Mediační místnost','vacuum','Zamést / vysát normální podlahu','vacuum','weekly','{5}',10,null,null,null,null),
('4. patro','Mediační místnost','mop','Vytřít normální podlahu','mop','weekly','{5}',20,null,null,null,'vacuum'),
('4. patro','Mediační místnost','carpet-vacuum','Vysát koberec','vacuum','weekly','{5}',30,null,null,null,null),
('4. patro','Mediační místnost','carpet-deep','Hloubkově vyčistit koberec vodním vysavačem','deep_clean','monthly','{5}',40,3,4,'2026-09-01',null),
('4. patro','Mediační místnost','seating','Vysát a očistit gauč a křesla','surfaces','monthly','{5}',50,1,4,'2026-09-01',null),
('4. patro','Mediační místnost','cabinet','Otřít skříňku','surfaces','monthly','{5}',60,1,4,'2026-09-01',null),
('4. patro','Mediační místnost','window','Umýt okno','windows','monthly','{5}',70,1,2,'2026-09-01',null),
('4. patro','Mediační místnost','doors','Umýt dveře','doors','monthly','{5}',80,1,1,'2026-09-01',null),
('4. patro','Chodba','vacuum','Zamést / vysát podlahu','vacuum','weekly','{5}',10,null,null,null,null),
('4. patro','Chodba','mop','Vytřít podlahu','mop','weekly','{5}',20,null,null,null,'vacuum'),

('Schodiště','Schodiště','vacuum','Zamést / vysát schodiště','vacuum','weekly','{5}',10,null,null,null,null),
('Schodiště','Schodiště','mop','Vytřít schodiště','mop','weekly','{5}',20,null,null,null,'vacuum'),
('Schodiště','Schodiště','railing','Otřít zábradlí','surfaces','weekly','{5}',30,null,null,null,null),
('Schodiště','Schodiště','windows','Umýt okna','windows','monthly','{5}',40,1,2,'2026-09-01',null);

-- Společné úkoly školy.
insert into public._migration_01800_desired_cleaning_plan values
(null,null,'prepare','Projít školu a odstranit věci z cesty','other','cleaning_day','{1,3,5}',1,null,null,null,null),
(null,null,'laundry','Vyprat hadry a utěrky','laundry','weekly','{5}',2,null,null,null,null);

-- Kanonické řádky mají stabilní plan_key a lze je bezpečně upsertovat.
insert into public.cleaning_tasks(
  plan_key, room_id, name, activity_type, frequency, active, sort_order,
  schedule_days, monthly_day, requires_task_id, work_part_id, assignment_mode,
  rotation_anchor_date, rotation_interval_weeks, cleaning_cycle_length,
  cleaning_cycle_offset, period_months, period_week, period_anchor_month
)
select
  'v2026|' || coalesce(desired.floor_name,'school') || '|' || coalesce(desired.room_name,'common') || '|' || desired.task_code,
  room.id, desired.task_name, desired.activity_type,
  desired.frequency::public.task_frequency, true, desired.sort_order,
  desired.schedule_days, null, null, null, 'fixed', null, 1,
  case when desired.floor_name in ('2. patro','3. patro') then 2 else null end,
  case when desired.floor_name = '2. patro' then 0 when desired.floor_name = '3. patro' then 1 else null end,
  desired.period_months, desired.period_week, desired.period_anchor_month
from public._migration_01800_desired_cleaning_plan desired
left join public.buildings building on building.name = 'Škola'
left join public.floors floor on floor.building_id = building.id and floor.name = desired.floor_name
left join public.rooms room on room.building_id = building.id and room.floor_id = floor.id and room.name = desired.room_name
on conflict (plan_key) where plan_key is not null do update set
  room_id = excluded.room_id, name = excluded.name, activity_type = excluded.activity_type,
  frequency = excluded.frequency, active = true, sort_order = excluded.sort_order,
  schedule_days = excluded.schedule_days, monthly_day = null, requires_task_id = null,
  work_part_id = null, assignment_mode = 'fixed', rotation_anchor_date = null,
  rotation_interval_weeks = 1, cleaning_cycle_length = excluded.cleaning_cycle_length,
  cleaning_cycle_offset = excluded.cleaning_cycle_offset, period_months = excluded.period_months,
  period_week = excluded.period_week, period_anchor_month = excluded.period_anchor_month;

-- Dependency se skládá pouze uvnitř stejné místnosti a správného typu podlahy.
update public.cleaning_tasks task
set requires_task_id = prerequisite.id
from public._migration_01800_desired_cleaning_plan desired
join public.cleaning_tasks prerequisite
  on prerequisite.plan_key = 'v2026|' || coalesce(desired.floor_name,'school') || '|' || coalesce(desired.room_name,'common') || '|' || desired.requires_code
where desired.requires_code is not null
  and task.plan_key = 'v2026|' || coalesce(desired.floor_name,'school') || '|' || coalesce(desired.room_name,'common') || '|' || desired.task_code;

-- Nové úkoly přes administraci automaticky zdědí rotaci 2./3. patra.
create or replace function public.apply_room_cleaning_cycle()
returns trigger language plpgsql set search_path = public as $$
declare target_floor text;
begin
  if new.room_id is null then
    new.cleaning_cycle_length := null; new.cleaning_cycle_offset := null;
    return new;
  end if;
  select floor.name into target_floor from public.rooms room
  join public.floors floor on floor.id = room.floor_id where room.id = new.room_id;
  if target_floor = '2. patro' then
    new.cleaning_cycle_length := 2; new.cleaning_cycle_offset := 0;
  elsif target_floor = '3. patro' then
    new.cleaning_cycle_length := 2; new.cleaning_cycle_offset := 1;
  else
    new.cleaning_cycle_length := null; new.cleaning_cycle_offset := null;
  end if;
  return new;
end;
$$;
drop trigger if exists apply_room_cleaning_cycle on public.cleaning_tasks;
create trigger apply_room_cleaning_cycle before insert or update of room_id
on public.cleaning_tasks for each row execute function public.apply_room_cleaning_cycle();

-- Počet Po/St/Pá úklidových dnů od stabilního anchoru 31. 8. 2026.
create or replace function public.cleaning_day_sequence_index(target_date date)
returns integer language sql immutable set search_path = public as $$
  select case
    when target_date >= date '2026-08-31' then (
      select count(*)::integer from generate_series(date '2026-08-31', target_date - 1, interval '1 day') day
      where extract(isodow from day) in (1,3,5)
    )
    else -(
      select count(*)::integer from generate_series(target_date, date '2026-08-31' - 1, interval '1 day') day
      where extract(isodow from day) in (1,3,5)
    )
  end;
$$;

create or replace function public.is_cleaning_task_candidate_on(target_task_id uuid, target_date date)
returns boolean language sql security definer set search_path = public stable as $$
  select target_date is not null and exists (
    select 1 from public.cleaning_tasks task
    left join public.rooms room on room.id = task.room_id
    where task.id = target_task_id and task.active and task.activity_type <> 'disinfect'
      and (task.room_id is null or room.active)
      and (
        (task.period_months is null and task.frequency::text = 'monthly')
        or extract(isodow from target_date)::smallint = any(task.schedule_days)
      )
      and (
        task.cleaning_cycle_length is null
        or ((public.cleaning_day_sequence_index(target_date) - task.cleaning_cycle_offset) % task.cleaning_cycle_length + task.cleaning_cycle_length) % task.cleaning_cycle_length = 0
      )
      and (
        task.period_months is null
        or (
          ((extract(year from age(date_trunc('month', target_date), date_trunc('month', task.period_anchor_month)))::integer * 12
             + extract(month from age(date_trunc('month', target_date), date_trunc('month', task.period_anchor_month)))::integer)
            % task.period_months + task.period_months) % task.period_months = 0
          and case task.period_week when 1 then extract(day from target_date) between 1 and 7
            when 2 then extract(day from target_date) between 8 and 14
            when 3 then extract(day from target_date) between 15 and 21
            when 4 then extract(day from target_date) >= 22 else false end
        )
      )
      and (task.period_months is not null or task.frequency::text <> 'monthly' or task.monthly_day = extract(day from target_date)::smallint)
      and task.frequency::text <> 'extraordinary'
  );
$$;

create or replace function public.is_cleaning_task_scheduled_on(target_task_id uuid, target_schedule_date date)
returns boolean language sql security definer set search_path = public stable as $$
  select public.is_cleaning_task_candidate_on(target_task_id, target_schedule_date)
    and not exists (
      select 1 from generate_series(
        case (select period_week from public.cleaning_tasks where id = target_task_id)
          when 1 then date_trunc('month', target_schedule_date)::date
          when 2 then date_trunc('month', target_schedule_date)::date + 7
          when 3 then date_trunc('month', target_schedule_date)::date + 14
          when 4 then date_trunc('month', target_schedule_date)::date + 21
          else target_schedule_date
        end,
        target_schedule_date - 1,
        interval '1 day'
      ) earlier
      where (select period_months from public.cleaning_tasks where id = target_task_id) is not null
        and public.is_cleaning_task_candidate_on(target_task_id, earlier::date)
    );
$$;

revoke all on function public.cleaning_day_sequence_index(date) from public, anon, authenticated;
revoke all on function public.is_cleaning_task_candidate_on(uuid,date) from public, anon, authenticated;
revoke all on function public.is_cleaning_task_scheduled_on(uuid,date) from public, anon, authenticated;

-- Bezpečnostní kontrola výsledku seedu.
do $$
begin
  if (select count(*) from public.rooms room join public.buildings b on b.id=room.building_id where b.name='Škola' and room.active) <> 32 then
    raise exception 'Nový plán nemá přesně 32 aktivních místností.';
  end if;
  if (
    select count(*) from public.cleaning_tasks
    where active and plan_key like 'v2026|%'
  ) <> 217 then
    raise exception 'Kanonický aktivní plán nemá očekávaných 217 úkolů.';
  end if;
  if exists (select 1 from public.cleaning_tasks where active and activity_type='disinfect') then
    raise exception 'V aktivním plánu zůstala dezinfekce.';
  end if;
  if (select count(*) from public.rooms room join public.floors floor on floor.id=room.floor_id where room.active and floor.name='2. patro' and room.name like 'Učebna %') <> 5 then
    raise exception 'Nevzniklo přesně pět samostatných učeben.';
  end if;
  if not exists (select 1 from public.rooms room join public.floors floor on floor.id=room.floor_id where room.active and floor.name='3. patro' and room.name='WC / sprcha') then
    raise exception 'Chybí WC / sprcha.';
  end if;
  if exists (
    select 1 from public.cleaning_tasks task
    join public.rooms room on room.id=task.room_id
    join public.floors floor on floor.id=room.floor_id
    where task.active and task.plan_key like 'v2026|%'
      and (
        (floor.name='2. patro' and (task.cleaning_cycle_length,task.cleaning_cycle_offset) is distinct from (2::smallint,0::smallint))
        or (floor.name='3. patro' and (task.cleaning_cycle_length,task.cleaning_cycle_offset) is distinct from (2::smallint,1::smallint))
      )
  ) then raise exception 'Rotace 2. a 3. patra není nastavena konzistentně.'; end if;
  if exists (
    select 1 from public.cleaning_tasks mop
    where mop.plan_key like 'v2026|%' and mop.active and mop.activity_type='mop'
      and (mop.requires_task_id is null or not exists (
        select 1 from public.cleaning_tasks vacuum where vacuum.id=mop.requires_task_id
          and vacuum.room_id=mop.room_id and vacuum.activity_type='vacuum' and vacuum.active
      ))
  ) then raise exception 'Některé vytírání nemá správnou dependency.'; end if;
end;
$$;

drop table public._migration_01800_desired_cleaning_plan;

commit;
