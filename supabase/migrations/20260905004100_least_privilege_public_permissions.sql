-- Least-privilege hardening pro existující aplikační objekty ve schema public.
-- Nemění data, RLS policy ani databázové schéma. Pouze zpřesňuje ACL.
begin;

do $$
declare
  application_table_names constant text[] := array[
    'profiles',
    'buildings',
    'floors',
    'rooms',
    'cleaning_tasks',
    'task_assignments',
    'shifts',
    'attendance',
    'stock_items',
    'laundry_records',
    'incidents',
    'cleaning_completions',
    'cleaning_work_parts',
    'work_part_assignments',
    'laundry_schedules',
    'cleaning_day_exceptions',
    'cleaning_day_exception_tasks',
    'app_settings',
    'manual_entries',
    'attendance_audit',
    'worker_contracts',
    'worker_contract_audit',
    'cleaning_bulk_completion_actions',
    'cleaning_bulk_completion_items',
    'worker_work_assignments',
    'worker_schedule_exceptions',
    'planning_workers',
    'cleaning_rotation_definitions',
    'cleaning_rotation_slot_assignments',
    'cleaning_planner_occurrences',
    'cleaning_planner_schedule_audit',
    'cleaning_weekly_worker_responsibilities'
  ];
  table_name text;
  table_oid regclass;
begin
  foreach table_name in array application_table_names loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null then
      raise exception 'Chybí očekávaná aplikační tabulka public.%.', table_name;
    end if;

    -- PUBLIC nesmí anonymnímu klientovi vrátit oprávnění děděním.
    execute format(
      'revoke all privileges on table %s from public, anon',
      table_oid
    );
  end loop;
end
$$;

do $$
declare
  -- Kompletní soupis názvů aplikačních funkcí vytvořených migracemi 00100–04000.
  -- Výběr podle názvu úmyslně zahrne i historické overloady stejné funkce.
  application_function_names constant text[] := array[
    'admin_save_planning_worker',
    'admin_save_planning_worker_schedule_exception',
    'admin_save_planning_worker_work_assignment',
    'admin_save_worker_contract',
    'admin_save_worker_schedule_exception',
    'admin_save_worker_work_assignment',
    'admin_set_cleaning_rotation_planning_worker_slot',
    'admin_set_cleaning_rotation_slot',
    'admin_set_cleaning_weekly_responsibility',
    'admin_set_planned_shifts_per_week',
    'app_current_date',
    'apply_room_cleaning_cycle',
    'audit_attendance_correction',
    'audit_dynamic_cleaning_schedule_change',
    'best_school_shift_for_week',
    'can_complete_task',
    'can_view_school_data',
    'can_work_in_app',
    'cleaning_day_sequence_index',
    'complete_cleaning_tasks_bulk',
    'current_access_role',
    'enforce_attendance_integrity',
    'enforce_cleaning_rotation_slot_unambiguous',
    'enforce_cleaning_weekly_responsibility_unambiguous',
    'enforce_mopping_prerequisite',
    'enforce_worker_schedule_exception_unambiguous',
    'enforce_worker_work_assignment_unambiguous',
    'get_cleaning_bulk_actions',
    'get_cleaning_completion_status',
    'get_dynamic_school_cleaning_plan',
    'get_worker_work_planning',
    'handle_new_user',
    'invalidate_dynamic_plan_after_planning_worker_change',
    'invalidate_future_dynamic_cleaning_plan',
    'is_active_profile',
    'is_active_worker',
    'is_admin',
    'is_caretaker',
    'is_cleaning_task_candidate_on',
    'is_cleaning_task_in_standard_full_plan',
    'is_cleaning_task_scheduled_on',
    'is_owner',
    'is_planning_worker_scheduled_at_school',
    'is_standard_cleaning_cancelled',
    'is_task_in_extraordinary_cleaning_day',
    'owner_set_user_access',
    'record_attendance_audit',
    'record_worker_contract_audit',
    'refresh_dynamic_school_cleaning_plan',
    'refresh_dynamic_school_cleaning_plan_base_03500',
    'restore_cancelled_standard_cleaning_day',
    'restore_cleaning_room',
    'save_cancelled_standard_cleaning_day',
    'save_extraordinary_cleaning_day',
    'set_cleaning_task_active',
    'set_cleaning_task_completion',
    'set_dpc_settings',
    'set_dpp_annual_limit',
    'set_extraordinary_cleaning_tasks',
    'set_initial_owner',
    'set_own_planned_shifts_per_week',
    'set_updated_at',
    'school_fourth_floor_slot_for_date',
    'school_rotating_floor_for_date',
    'school_worker_count_for_date',
    'soft_delete_cleaning_room',
    'swap_cleaning_work_parts',
    'undo_cleaning_tasks_bulk',
    'update_own_profile_name',
    'validate_cleaning_day_exception'
  ];
  function_oid oid;
begin
  for function_oid in
    select routine.oid
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname = any(application_function_names)
  loop
    -- Funkce mají v PostgreSQL implicitně PUBLIC EXECUTE. Odebrání PUBLIC je
    -- nezbytné, jinak by anon zákaz zděděním obešel.
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      function_oid::regprocedure
    );
  end loop;
end
$$;

do $$
declare
  -- A: přímo volaná RPC z frontend repository.
  frontend_rpc_signatures constant text[] := array[
    'public.update_own_profile_name(text)',
    'public.owner_set_user_access(uuid,text,boolean)',
    'public.get_dynamic_school_cleaning_plan(date,date)',
    'public.get_cleaning_completion_status(date)',
    'public.get_cleaning_bulk_actions(date)',
    'public.set_dpp_annual_limit(numeric)',
    'public.soft_delete_cleaning_room(uuid)',
    'public.restore_cleaning_room(uuid)',
    'public.set_cleaning_task_active(uuid,boolean)',
    'public.set_cleaning_task_completion(uuid,date,boolean)',
    'public.complete_cleaning_tasks_bulk(uuid[],date)',
    'public.save_cancelled_standard_cleaning_day(uuid,uuid,date,text)',
    'public.save_extraordinary_cleaning_day(uuid,uuid,date,text,text,uuid[])',
    'public.get_worker_work_planning()',
    'public.admin_save_planning_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)',
    'public.admin_save_planning_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)',
    'public.admin_set_cleaning_rotation_planning_worker_slot(text,smallint,uuid,date)',
    'public.restore_cancelled_standard_cleaning_day(uuid)',
    'public.admin_set_cleaning_weekly_responsibility(text,uuid,date)',
    'public.admin_save_planning_worker(uuid,text,uuid,boolean)',
    'public.undo_cleaning_tasks_bulk(uuid)',
    'public.set_dpc_settings(numeric,smallint,numeric)',
    'public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)',
    'public.set_own_planned_shifts_per_week(smallint)',
    'public.admin_set_planned_shifts_per_week(uuid,smallint)',

    -- Kompatibilní fallbacky, které repository stále umí zavolat při přechodu
    -- ze starého profiles-only modelu na planning_workers.
    'public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)',
    'public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)',
    'public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date)'
  ];

  -- B: helpery volané přímo v RLS nebo používané jako veřejný autorizační
  -- kontrakt aplikace. Neprovádějí mutaci dat.
  rls_helper_signatures constant text[] := array[
    'public.current_access_role()',
    'public.is_active_profile()',
    'public.can_view_school_data()',
    'public.can_work_in_app()',
    'public.is_admin()',
    'public.is_owner()',
    'public.is_caretaker()',
    'public.is_active_worker()',
    'public.can_complete_task(uuid)',
    'public.can_complete_task(uuid,date)'
  ];
  signature text;
  function_oid oid;
begin
  foreach signature in array frontend_rpc_signatures || rls_helper_signatures loop
    function_oid := to_regprocedure(signature);
    if function_oid is null then
      raise exception 'Chybí RPC/RLS helper vyžadovaný aplikací: %.', signature;
    end if;
    execute format('grant execute on function %s to authenticated', function_oid::regprocedure);
  end loop;
end
$$;

-- C: trigger-only a interní helpery zůstávají bez klientského EXECUTE.
-- PostgreSQL při spuštění triggeru nekontroluje EXECUTE právo role, která mění
-- řádek; trigger proto zůstane funkční. Totéž platí pro interní volání uvnitř
-- SECURITY DEFINER RPC, která běží pod vlastníkem funkce.

-- D: historická funkce se nemaže, ale nesmí být klientským API.
revoke execute on function public.swap_cleaning_work_parts()
  from public, anon, authenticated;

do $$
declare
  application_table_names constant text[] := array[
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
  application_function_names constant text[] := array[
    'admin_save_planning_worker','admin_save_planning_worker_schedule_exception',
    'admin_save_planning_worker_work_assignment','admin_save_worker_contract',
    'admin_save_worker_schedule_exception','admin_save_worker_work_assignment',
    'admin_set_cleaning_rotation_planning_worker_slot','admin_set_cleaning_rotation_slot',
    'admin_set_cleaning_weekly_responsibility','admin_set_planned_shifts_per_week',
    'app_current_date','apply_room_cleaning_cycle','audit_attendance_correction',
    'audit_dynamic_cleaning_schedule_change','best_school_shift_for_week',
    'can_complete_task','can_view_school_data','can_work_in_app',
    'cleaning_day_sequence_index','complete_cleaning_tasks_bulk','current_access_role',
    'enforce_attendance_integrity','enforce_cleaning_rotation_slot_unambiguous',
    'enforce_cleaning_weekly_responsibility_unambiguous','enforce_mopping_prerequisite',
    'enforce_worker_schedule_exception_unambiguous','enforce_worker_work_assignment_unambiguous',
    'get_cleaning_bulk_actions','get_cleaning_completion_status',
    'get_dynamic_school_cleaning_plan','get_worker_work_planning','handle_new_user',
    'invalidate_dynamic_plan_after_planning_worker_change','invalidate_future_dynamic_cleaning_plan',
    'is_active_profile','is_active_worker','is_admin','is_caretaker',
    'is_cleaning_task_candidate_on','is_cleaning_task_in_standard_full_plan',
    'is_cleaning_task_scheduled_on','is_owner','is_planning_worker_scheduled_at_school',
    'is_standard_cleaning_cancelled','is_task_in_extraordinary_cleaning_day',
    'owner_set_user_access','record_attendance_audit','record_worker_contract_audit',
    'refresh_dynamic_school_cleaning_plan','refresh_dynamic_school_cleaning_plan_base_03500',
    'restore_cancelled_standard_cleaning_day',
    'restore_cleaning_room','save_cancelled_standard_cleaning_day',
    'save_extraordinary_cleaning_day','set_cleaning_task_active',
    'set_cleaning_task_completion','set_dpc_settings','set_dpp_annual_limit',
    'set_extraordinary_cleaning_tasks','set_initial_owner','set_own_planned_shifts_per_week',
    'set_updated_at','school_fourth_floor_slot_for_date','school_rotating_floor_for_date',
    'school_worker_count_for_date','soft_delete_cleaning_room','swap_cleaning_work_parts',
    'undo_cleaning_tasks_bulk','update_own_profile_name','validate_cleaning_day_exception'
  ];
  authenticated_signatures constant text[] := array[
    'public.update_own_profile_name(text)',
    'public.owner_set_user_access(uuid,text,boolean)',
    'public.get_dynamic_school_cleaning_plan(date,date)',
    'public.get_cleaning_completion_status(date)',
    'public.get_cleaning_bulk_actions(date)',
    'public.set_dpp_annual_limit(numeric)',
    'public.soft_delete_cleaning_room(uuid)',
    'public.restore_cleaning_room(uuid)',
    'public.set_cleaning_task_active(uuid,boolean)',
    'public.set_cleaning_task_completion(uuid,date,boolean)',
    'public.complete_cleaning_tasks_bulk(uuid[],date)',
    'public.save_cancelled_standard_cleaning_day(uuid,uuid,date,text)',
    'public.save_extraordinary_cleaning_day(uuid,uuid,date,text,text,uuid[])',
    'public.get_worker_work_planning()',
    'public.admin_save_planning_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)',
    'public.admin_save_planning_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)',
    'public.admin_set_cleaning_rotation_planning_worker_slot(text,smallint,uuid,date)',
    'public.restore_cancelled_standard_cleaning_day(uuid)',
    'public.admin_set_cleaning_weekly_responsibility(text,uuid,date)',
    'public.admin_save_planning_worker(uuid,text,uuid,boolean)',
    'public.undo_cleaning_tasks_bulk(uuid)',
    'public.set_dpc_settings(numeric,smallint,numeric)',
    'public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)',
    'public.set_own_planned_shifts_per_week(smallint)',
    'public.admin_set_planned_shifts_per_week(uuid,smallint)',
    'public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)',
    'public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)',
    'public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date)',
    'public.current_access_role()','public.is_active_profile()',
    'public.can_view_school_data()','public.can_work_in_app()',
    'public.is_admin()','public.is_owner()','public.is_caretaker()',
    'public.is_active_worker()','public.can_complete_task(uuid)',
    'public.can_complete_task(uuid,date)'
  ];
  mutating_security_definer_names constant text[] := array[
    'admin_save_planning_worker','admin_save_planning_worker_schedule_exception',
    'admin_save_planning_worker_work_assignment','admin_save_worker_contract',
    'admin_save_worker_schedule_exception','admin_save_worker_work_assignment',
    'admin_set_cleaning_rotation_planning_worker_slot','admin_set_cleaning_rotation_slot',
    'admin_set_cleaning_weekly_responsibility','admin_set_planned_shifts_per_week',
    'complete_cleaning_tasks_bulk','owner_set_user_access',
    'refresh_dynamic_school_cleaning_plan','refresh_dynamic_school_cleaning_plan_base_03500',
    'restore_cancelled_standard_cleaning_day',
    'restore_cleaning_room','save_cancelled_standard_cleaning_day',
    'save_extraordinary_cleaning_day','set_cleaning_task_active',
    'set_cleaning_task_completion','set_dpc_settings','set_dpp_annual_limit',
    'set_extraordinary_cleaning_tasks','set_initial_owner',
    'set_own_planned_shifts_per_week','soft_delete_cleaning_room',
    'swap_cleaning_work_parts','undo_cleaning_tasks_bulk','update_own_profile_name'
  ];
  table_name text;
  table_oid regclass;
  function_record record;
  signature text;
  allowed_oids oid[] := array[]::oid[];
begin
  -- 1 + 6: anon nemá přístup k aplikačním tabulkám a RLS zůstává zapnuté.
  foreach table_name in array application_table_names loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null then
      raise exception 'Self-check: chybí aplikační tabulka public.%.', table_name;
    end if;
    if has_table_privilege('anon', table_oid, 'SELECT')
       or has_table_privilege('anon', table_oid, 'INSERT')
       or has_table_privilege('anon', table_oid, 'UPDATE')
       or has_table_privilege('anon', table_oid, 'DELETE')
       or has_table_privilege('anon', table_oid, 'TRUNCATE')
       or has_table_privilege('anon', table_oid, 'REFERENCES')
       or has_table_privilege('anon', table_oid, 'TRIGGER') then
      raise exception 'Self-check: anon má stále oprávnění k tabulce %.', table_oid;
    end if;
    if not (select relation.relrowsecurity from pg_class relation where relation.oid = table_oid) then
      raise exception 'Self-check: RLS není zapnuté na tabulce %.', table_oid;
    end if;
  end loop;

  foreach signature in array authenticated_signatures loop
    if to_regprocedure(signature) is null then
      raise exception 'Self-check: chybí vyžadovaná funkce %.', signature;
    end if;
    allowed_oids := array_append(allowed_oids, to_regprocedure(signature));
    if not has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE') then
      raise exception 'Self-check: authenticated nemůže spustit vyžadovanou funkci %.', signature;
    end if;
  end loop;

  for function_record in
    select routine.oid, routine.proname, routine.prosecdef
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname = any(application_function_names)
  loop
    -- 2: anon nesmí spustit žádnou naši aplikační funkci ani přes PUBLIC.
    if has_function_privilege('anon', function_record.oid, 'EXECUTE') then
      raise exception 'Self-check: anon může spustit funkci %.', function_record.oid::regprocedure;
    end if;

    -- PUBLIC je kontrolováno přímo přes ACL, nejen nepřímo rolí anon.
    if exists (
      select 1
      from aclexplode(coalesce(
        (select routine.proacl from pg_proc routine where routine.oid = function_record.oid),
        acldefault('f', (select routine.proowner from pg_proc routine where routine.oid = function_record.oid))
      )) acl
      where acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    ) then
      raise exception 'Self-check: PUBLIC má EXECUTE na funkci %.', function_record.oid::regprocedure;
    end if;

    -- C: authenticated smí pouze explicitní frontendová RPC a RLS helpery.
    if has_function_privilege('authenticated', function_record.oid, 'EXECUTE')
       and not (function_record.oid = any(allowed_oids)) then
      raise exception 'Self-check: authenticated má nečekané EXECUTE na interní funkci %.', function_record.oid::regprocedure;
    end if;

    -- 3: mutační SECURITY DEFINER funkce nesmějí být veřejně spustitelné.
    if function_record.prosecdef
       and function_record.proname = any(mutating_security_definer_names)
       and has_function_privilege('anon', function_record.oid, 'EXECUTE') then
      raise exception 'Self-check: mutační SECURITY DEFINER funkce je veřejná: %.', function_record.oid::regprocedure;
    end if;
  end loop;

  -- 4: explicitní ochrana historického RPC.
  if has_function_privilege('anon', 'public.swap_cleaning_work_parts()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.swap_cleaning_work_parts()', 'EXECUTE') then
    raise exception 'Self-check: swap_cleaning_work_parts nesmí být klientsky spustitelná.';
  end if;
end
$$;

commit;
