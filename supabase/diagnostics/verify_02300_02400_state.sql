-- Pouze čtecí diagnostika. Tento soubor nic nevytváří ani nemění.

-- 02300: úspěšný seed Školky má vrátit 1 / 11 / 43 a nuly v chybových sloupcích.
select
  count(distinct building.id) filter (where building.name = 'Školka' and building.active) as active_kindergarten_buildings,
  count(distinct room.id) filter (where building.name = 'Školka' and room.active) as active_kindergarten_rooms,
  count(distinct task.id) filter (where task.active and task.plan_key like 'v2026-kindergarten|%') as active_kindergarten_tasks,
  count(distinct task.id) filter (
    where task.active and task.plan_key like 'v2026-kindergarten|%'
      and (task.schedule_days <> array[2]::smallint[] or task.activity_type = 'disinfect' or task.work_part_id is not null)
  ) as invalid_kindergarten_tasks,
  count(distinct task.id) filter (
    where task.active and task.plan_key like 'v2026-kindergarten|%|mop'
      and not exists (
        select 1 from public.cleaning_tasks prerequisite
        where prerequisite.id = task.requires_task_id
          and prerequisite.room_id = task.room_id
          and prerequisite.activity_type = 'vacuum'
          and prerequisite.active
      )
  ) as invalid_kindergarten_dependencies
from public.buildings building
left join public.rooms room on room.building_id = building.id
left join public.cleaning_tasks task on task.room_id = room.id;

-- 02400: po transakčně neúspěšném běhu mají být všechny výsledky NULL.
-- Po pozdějším úspěšném spuštění 02400 naopak vrátí názvy objektů.
select
  to_regclass('public.worker_contracts') as worker_contracts,
  to_regclass('public.worker_contract_audit') as worker_contract_audit,
  to_regprocedure('public.admin_save_worker_contract(uuid,uuid,text,date,date,text,boolean)') as admin_save_worker_contract,
  to_regprocedure('public.set_dpc_settings(numeric,smallint)') as set_dpc_settings;

-- Stav sloupců, které do app_settings přidává až 02400.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'app_settings'
  and column_name in ('dpc_weekly_hours_reference', 'dpc_reference_period_weeks')
order by column_name;
