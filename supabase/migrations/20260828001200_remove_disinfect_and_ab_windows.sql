-- Odstranění dezinfekce a A/B oken z aktivního produktu bez mazání historie.

begin;

-- Historické úkoly i jejich cleaning_completions zůstávají zachované.
update public.cleaning_tasks
set active = false
where activity_type = 'disinfect'
  and active;

-- Aktivní úkol nesmí zůstat zablokovaný neviditelnou dezinfekcí. Běžné
-- dependency vytírání -> zametení/vysávání se tímto nemění.
update public.cleaning_tasks task
set requires_task_id = null
from public.cleaning_tasks prerequisite
where task.requires_task_id = prerequisite.id
  and task.active
  and prerequisite.activity_type = 'disinfect';

-- Všechny dosavadní varianty oken nejprve bezpečně deaktivujeme. Tím zůstanou
-- zachované původní A/B řádky, jejich ID, assignments i completion historie.
update public.cleaning_tasks
set active = false
where activity_type = 'windows'
  and active;

-- Společný úkol vytvoříme pouze tehdy, pokud ještě neexistuje. Opakované
-- spuštění migrace proto nevytvoří duplicitní aktivní položku.
insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  monthly_day, work_part_id, assignment_mode, rotation_anchor_date,
  rotation_interval_weeks
)
select
  null, 'Mytí oken', 'windows', 'monthly', false, 90, '{}',
  1, null, 'fixed', null, 1
where not exists (
  select 1
  from public.cleaning_tasks
  where room_id is null
    and activity_type = 'windows'
    and name = 'Mytí oken'
);

-- Pokud by přes předchozí ruční pokus existovalo více společných řádků,
-- aktivujeme pouze nejstarší a ostatní ponecháme jako neaktivní historii.
with canonical as (
  select id
  from public.cleaning_tasks
  where room_id is null
    and activity_type = 'windows'
    and name = 'Mytí oken'
  order by created_at, id
  limit 1
)
update public.cleaning_tasks task
set active = (task.id = canonical.id),
    frequency = 'monthly',
    schedule_days = '{}',
    monthly_day = 1,
    work_part_id = null,
    assignment_mode = 'fixed',
    rotation_anchor_date = null,
    rotation_interval_weeks = 1,
    sort_order = 90
from canonical
where task.room_id is null
  and task.activity_type = 'windows'
  and task.name = 'Mytí oken';

-- Společná položka nesmí mít aktivní individuální assignment. Řádky pouze
-- deaktivujeme, aby se ani zde neztratila historická informace.
update public.task_assignments assignment
set active = false
from public.cleaning_tasks task
where assignment.task_id = task.id
  and task.room_id is null
  and task.activity_type = 'windows'
  and task.name = 'Mytí oken'
  and assignment.active;

-- Atomická kontrola výsledku. Při porušení se celá migrace vrátí zpět.
do $$
begin
  if exists (
    select 1 from public.cleaning_tasks
    where active and activity_type = 'disinfect'
  ) then
    raise exception 'Po migraci zůstal aktivní úkol dezinfekce.';
  end if;

  if (
    select count(*) from public.cleaning_tasks
    where active
      and room_id is null
      and activity_type = 'windows'
      and name = 'Mytí oken'
      and frequency = 'monthly'
      and monthly_day = 1
      and work_part_id is null
      and assignment_mode = 'fixed'
      and rotation_anchor_date is null
  ) <> 1 then
    raise exception 'Společný měsíční úkol Mytí oken není právě jeden.';
  end if;

  if exists (
    select 1 from public.cleaning_tasks
    where active
      and activity_type = 'windows'
      and (room_id is not null or name <> 'Mytí oken' or work_part_id is not null)
  ) then
    raise exception 'Po migraci zůstala aktivní historická nebo A/B varianta oken.';
  end if;
end;
$$;

commit;
