-- Spouštět pouze proti lokální/testovací databázi po migraci 04100.
-- Test je read-only a ověřuje efektivní oprávnění včetně dědění přes PUBLIC.
begin;

do $$
declare
  application_tables constant text[] := array[
    'profiles','buildings','floors','rooms','cleaning_tasks','task_assignments',
    'shifts','attendance','stock_items','laundry_records','incidents',
    'cleaning_completions','cleaning_work_parts','work_part_assignments',
    'laundry_schedules','cleaning_day_exceptions','cleaning_day_exception_tasks',
    'app_settings','manual_entries','attendance_audit','worker_contracts',
    'worker_contract_audit','cleaning_bulk_completion_actions',
    'cleaning_bulk_completion_items','worker_work_assignments',
    'worker_schedule_exceptions','planning_workers','cleaning_rotation_definitions',
    'cleaning_rotation_slot_assignments','cleaning_planner_occurrences',
    'cleaning_planner_schedule_audit','cleaning_weekly_worker_responsibilities'
  ];
  table_name text;
  table_oid regclass;
begin
  foreach table_name in array application_tables loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null then
      raise exception 'Test fixture neobsahuje public.%.', table_name;
    end if;
    if has_table_privilege('anon', table_oid, 'SELECT')
       or has_table_privilege('anon', table_oid, 'INSERT')
       or has_table_privilege('anon', table_oid, 'UPDATE')
       or has_table_privilege('anon', table_oid, 'DELETE')
       or has_table_privilege('anon', table_oid, 'TRUNCATE')
       or has_table_privilege('anon', table_oid, 'REFERENCES')
       or has_table_privilege('anon', table_oid, 'TRIGGER') then
      raise exception 'anon má neočekávané oprávnění k %.', table_oid;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.can_view_school_data()', 'EXECUTE') then
    raise exception 'anon nesmí spustit can_view_school_data.';
  end if;
  if not has_function_privilege('authenticated', 'public.can_view_school_data()', 'EXECUTE') then
    raise exception 'authenticated potřebuje can_view_school_data pro RLS.';
  end if;
  if has_function_privilege('anon', 'public.swap_cleaning_work_parts()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.swap_cleaning_work_parts()', 'EXECUTE') then
    raise exception 'Legacy swap_cleaning_work_parts nesmí být klientsky spustitelná.';
  end if;
  if has_function_privilege('authenticated', 'public.set_updated_at()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.enforce_attendance_integrity()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.enforce_mopping_prerequisite()', 'EXECUTE') then
    raise exception 'Trigger-only funkce nesmějí být klientsky spustitelné.';
  end if;
end
$$;

rollback;
