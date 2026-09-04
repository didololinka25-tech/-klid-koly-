-- Zrušení jednoho běžného úklidového dne pro konkrétní pracoviště.
-- Rozvrh lidí, docházka ani completion historie se nemění.

begin;

alter table public.cleaning_day_exceptions
  drop constraint if exists cleaning_day_exceptions_kind_check;
alter table public.cleaning_day_exceptions
  add constraint cleaning_day_exceptions_kind_check
  check (kind in ('extraordinary', 'rescheduled', 'cancelled_standard'));

alter table public.cleaning_day_exceptions
  drop constraint if exists cleaning_day_exception_dates_valid;
alter table public.cleaning_day_exceptions
  add constraint cleaning_day_exception_dates_valid check (
    (kind in ('extraordinary', 'cancelled_standard') and source_date is null)
    or
    (kind = 'rescheduled' and source_date is not null and source_date <> execution_date)
  );

create or replace function public.is_standard_cleaning_cancelled(
  target_building_id uuid,
  target_date date
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_building_id is not null and target_date is not null and exists (
    select 1
    from public.cleaning_day_exceptions exception
    where exception.building_id = target_building_id
      and exception.execution_date = target_date
      and exception.kind = 'cancelled_standard'
      and exception.status = 'active'
  );
$$;

-- Zachovává celý obecný scheduling z 01800 a pouze před něj přidává
-- building-scoped zrušení standardního dne.
create or replace function public.is_cleaning_task_scheduled_on(
  target_task_id uuid,
  target_schedule_date date
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_cleaning_task_candidate_on(target_task_id, target_schedule_date)
    and not exists (
      select 1
      from public.cleaning_tasks task
      left join public.rooms room on room.id = task.room_id
      where task.id = target_task_id
        and public.is_standard_cleaning_cancelled(
          coalesce(
            room.building_id,
            (select building.id from public.buildings building where building.name = 'Škola' order by building.id limit 1)
          ),
          target_schedule_date
        )
    )
    and not exists (
      select 1
      from generate_series(
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

create or replace function public.validate_cleaning_day_exception()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Úklidové dny může spravovat pouze správce.';
  end if;

  new.title := btrim(coalesce(new.title, ''));
  if new.title = '' then
    raise exception 'Název úklidového dne je povinný.';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    if old.execution_date < public.app_current_date()
       or (
         old.kind <> 'cancelled_standard'
         and exists (
           select 1 from public.cleaning_completions completion
           where completion.completion_date = old.execution_date
         )
       )
       or (
         old.kind = 'cancelled_standard'
         and exists (
           select 1
           from public.cleaning_completions completion
           join public.cleaning_tasks task on task.id = completion.task_id
           left join public.rooms room on room.id = task.room_id
           where completion.completion_date = old.execution_date
             and completion.completed
             and coalesce(
               room.building_id,
               (select building.id from public.buildings building where building.name = 'Škola' order by building.id limit 1)
             ) = old.building_id
         )
       ) then
      if row(new.kind, new.execution_date, new.source_date, new.status, new.scope_type)
         is distinct from
         row(old.kind, old.execution_date, old.source_date, old.status, old.scope_type) then
        raise exception 'Proběhlý úklid s historií nelze měnit ani rušit.';
      end if;
    end if;
  end if;

  new.updated_by := auth.uid();

  if new.execution_date < public.app_current_date() then
    raise exception 'Nový termín úklidu nesmí být v minulosti.';
  end if;

  if new.kind = 'rescheduled' and new.source_date < public.app_current_date() then
    raise exception 'Původní termín přesouvaného úklidu nesmí být v minulosti.';
  end if;

  if new.kind = 'rescheduled' and not exists (
    select 1 from public.cleaning_tasks task
    where public.is_cleaning_task_scheduled_on(task.id, new.source_date)
  ) then
    raise exception 'Původní datum neobsahuje žádný pravidelný úklidový úkol.';
  end if;

  if new.kind = 'cancelled_standard' then
    if exists (
      select 1
      from public.cleaning_day_exceptions moved
      where moved.building_id = new.building_id
        and moved.kind = 'rescheduled'
        and moved.status = 'active'
        and moved.source_date = new.execution_date
        and (tg_op = 'INSERT' or moved.id <> new.id)
    ) then
      raise exception 'Tento běžný úklid už je přesunutý na jiný termín.';
    end if;

    if not exists (
      select 1
      from public.cleaning_tasks task
      join public.rooms room on room.id = task.room_id
      where room.building_id = new.building_id
        and room.active and task.active
        and task.frequency::text = 'cleaning_day'
        and extract(isodow from new.execution_date)::smallint = any(task.schedule_days)
    ) then
      raise exception 'Vybraný den není běžným úklidovým dnem tohoto pracoviště.';
    end if;

    if exists (
      select 1
      from public.cleaning_completions completion
      join public.cleaning_tasks task on task.id = completion.task_id
      left join public.rooms room on room.id = task.room_id
      where completion.completion_date = new.execution_date
        and completion.completed
        and coalesce(
          room.building_id,
          (select building.id from public.buildings building where building.name = 'Škola' order by building.id limit 1)
        ) = new.building_id
    ) then
      raise exception 'Úklid už obsahuje dokončenou práci a nelze jej zpětně označit jako zrušený.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.save_cancelled_standard_cleaning_day(
  target_exception_id uuid,
  target_building_id uuid,
  target_execution_date date,
  target_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Běžný úklid může zrušit pouze správce.';
  end if;
  if target_building_id is null or not exists (
    select 1 from public.buildings building where building.id = target_building_id and building.active
  ) then
    raise exception 'Vyberte aktivní pracoviště.';
  end if;
  if target_execution_date is null then
    raise exception 'Vyberte datum zrušeného úklidu.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_building_id::text || '|' || target_execution_date::text, 3900));

  if target_exception_id is not null then
    select exception.id into saved_id
    from public.cleaning_day_exceptions exception
    where exception.id = target_exception_id and exception.kind = 'cancelled_standard'
    for update;
    if saved_id is null then
      raise exception 'Zrušení úklidu nebylo nalezeno.';
    end if;
  else
    select exception.id into saved_id
    from public.cleaning_day_exceptions exception
    where exception.building_id = target_building_id
      and exception.execution_date = target_execution_date
      and exception.kind = 'cancelled_standard'
      and exception.status = 'active'
    order by exception.created_at desc
    limit 1
    for update;
  end if;

  if saved_id is null and exists (
    select 1 from public.cleaning_day_exceptions exception
    where exception.building_id = target_building_id
      and exception.execution_date = target_execution_date
      and exception.status = 'active'
  ) then
    raise exception 'Pro toto pracoviště už je na vybraný den uložená jiná výjimka.';
  end if;

  if saved_id is null then
    insert into public.cleaning_day_exceptions(
      building_id, kind, execution_date, source_date, title, note,
      scope_type, status, created_by, updated_by
    ) values (
      target_building_id, 'cancelled_standard', target_execution_date, null,
      'Úklid zrušen', nullif(btrim(coalesce(target_note, '')), ''),
      'whole_school', 'active', auth.uid(), auth.uid()
    ) returning id into saved_id;
  else
    update public.cleaning_day_exceptions exception
    set building_id = target_building_id,
        execution_date = target_execution_date,
        source_date = null,
        title = 'Úklid zrušen',
        note = nullif(btrim(coalesce(target_note, '')), ''),
        scope_type = 'whole_school',
        status = 'active',
        updated_at = now(),
        updated_by = auth.uid()
    where exception.id = saved_id;
  end if;

  return saved_id;
end;
$$;

create or replace function public.restore_cancelled_standard_cleaning_day(
  target_exception_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Běžný úklid může obnovit pouze správce.';
  end if;

  update public.cleaning_day_exceptions exception
  set status = 'cancelled', updated_at = now(), updated_by = auth.uid()
  where exception.id = target_exception_id
    and exception.kind = 'cancelled_standard'
    and exception.status = 'active';

  if not found then
    raise exception 'Aktivní zrušení úklidu nebylo nalezeno.';
  end if;
end;
$$;

-- Pro školní dynamický planner znamená aktivní zrušení nulovou použitelnou
-- kapacitu. Samotná pracovní období a výjimky pracovníků zůstávají nedotčené.
create or replace function public.school_worker_count_for_date(target_date date)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  with school as (
    select id from public.buildings where name = 'Škola' and active order by id limit 1
  ), overridden as (
    select distinct planning_worker_id
    from public.worker_schedule_exceptions
    where active and exception_date = target_date
  ), planned as (
    select assignment.planning_worker_id
    from public.worker_work_assignments assignment
    join public.planning_workers worker on worker.id = assignment.planning_worker_id and worker.active,
      school
    where assignment.active and assignment.building_id = school.id
      and target_date between assignment.valid_from and coalesce(assignment.valid_to, 'infinity'::date)
      and extract(isodow from target_date)::smallint = any(assignment.weekdays)
      and not exists (select 1 from overridden where planning_worker_id = assignment.planning_worker_id)
    union
    select exception.planning_worker_id
    from public.worker_schedule_exceptions exception
    join public.planning_workers worker on worker.id = exception.planning_worker_id and worker.active,
      school
    where exception.active and exception.exception_date = target_date
      and exception.planned and exception.building_id = school.id
  )
  select case
    when exists (
      select 1 from school
      where public.is_standard_cleaning_cancelled(school.id, target_date)
    ) then 0
    else (select count(distinct planning_worker_id)::integer from planned)
  end;
$$;

-- Navazuje na bezpečný základ 03500 a zachovává rozložení osobních týdenních
-- povinností z 03700. Jedinou změnou je vyřazení zrušených školních dnů.
create or replace function public.refresh_dynamic_school_cleaning_plan(target_from date, target_to date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  duty record;
  candidate_date date;
begin
  if not public.can_view_school_data() then
    raise exception 'Nemáte oprávnění zobrazit plán.';
  end if;

  update public.cleaning_planner_occurrences occurrence
  set scheduled_for = null,
      assigned_worker_id = null,
      assigned_planning_worker_id = null,
      updated_at = now()
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.buildings building on building.id = room.building_id
  where occurrence.task_id = task.id
    and occurrence.active
    and building.name = 'Škola'
    and occurrence.scheduled_for is not null
    and public.is_standard_cleaning_cancelled(building.id, occurrence.scheduled_for)
    and not exists (
      select 1 from public.cleaning_completions completion
      where completion.task_id = occurrence.task_id
        and completion.completion_date = occurrence.scheduled_for
        and completion.completed
    );

  perform public.refresh_dynamic_school_cleaning_plan_base_03500(target_from, target_to);

  -- Obranná kontrola i po základním přepočtu: zrušený den nesmí zůstat
  -- scheduled_for. Základ jej díky nulové kapacitě vybere znovu jinam.
  update public.cleaning_planner_occurrences occurrence
  set scheduled_for = null,
      assigned_worker_id = null,
      assigned_planning_worker_id = null,
      updated_at = now()
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id
  join public.buildings building on building.id = room.building_id
  where occurrence.task_id = task.id
    and occurrence.active
    and building.name = 'Škola'
    and occurrence.scheduled_for is not null
    and public.is_standard_cleaning_cancelled(building.id, occurrence.scheduled_for)
    and not exists (
      select 1 from public.cleaning_completions completion
      where completion.task_id = occurrence.task_id
        and completion.completion_date = occurrence.scheduled_for
        and completion.completed
    );

  update public.cleaning_planner_occurrences occurrence
  set assigned_planning_worker_id = null, updated_at = now()
  where occurrence.active
    and (occurrence.planner_group like 'fourth|%' or occurrence.planner_group like 'stairs|%')
    and occurrence.due_from <= target_to + 7
    and occurrence.due_to >= target_from - 7
    and exists (
      select 1
      from public.cleaning_weekly_worker_responsibilities responsibility
      where responsibility.active
        and responsibility.responsibility_key = case
          when occurrence.planner_group like 'fourth|%' then 'school-fourth-floor'
          else 'school-stairs'
        end
        and responsibility.valid_from <= occurrence.due_from
        and (responsibility.valid_to is null or responsibility.valid_to >= occurrence.due_from)
        and responsibility.planning_worker_id is not null
    )
    and not exists (
      select 1 from public.cleaning_completions completion
      where completion.task_id = occurrence.task_id and completion.completed
        and completion.completion_date between occurrence.due_from and occurrence.due_to
    );

  for duty in
    select occurrence.planner_group, occurrence.due_from, min(occurrence.due_to) as due_to,
      responsibility.planning_worker_id
    from public.cleaning_planner_occurrences occurrence
    join public.cleaning_weekly_worker_responsibilities responsibility
      on responsibility.responsibility_key = case
        when occurrence.planner_group like 'fourth|%' then 'school-fourth-floor'
        when occurrence.planner_group like 'stairs|%' then 'school-stairs'
      end
      and responsibility.active
      and responsibility.valid_from <= occurrence.due_from
      and (responsibility.valid_to is null or responsibility.valid_to >= occurrence.due_from)
    where occurrence.active
      and (occurrence.planner_group like 'fourth|%' or occurrence.planner_group like 'stairs|%')
      and occurrence.due_from <= target_to + 7
      and occurrence.due_to >= target_from - 7
      and responsibility.planning_worker_id is not null
      and not exists (
        select 1 from public.cleaning_completions completion
        where completion.task_id = occurrence.task_id and completion.completed
          and completion.completion_date between occurrence.due_from and occurrence.due_to
      )
    group by occurrence.planner_group, occurrence.due_from, responsibility.planning_worker_id
    order by occurrence.due_from, occurrence.planner_group
  loop
    select generated_day.plan_date into candidate_date
    from (
      select series.day_value::date as plan_date,
        public.school_worker_count_for_date(series.day_value::date) as worker_count,
        coalesce((
          select count(distinct used.planner_group)
          from public.cleaning_planner_occurrences used
          where used.active
            and used.scheduled_for = series.day_value::date
            and used.assigned_planning_worker_id = duty.planning_worker_id
            and used.planner_group <> duty.planner_group
            and (used.planner_group like 'fourth|%' or used.planner_group like 'stairs|%')
        ), 0)::integer as worker_responsibility_count,
        coalesce((
          select sum(case scheduled.work_size when 'large' then 2 else 1 end)
          from (
            select distinct used.planner_group, used.work_size
            from public.cleaning_planner_occurrences used
            where used.active and used.scheduled_for = series.day_value::date
              and used.planner_group <> duty.planner_group
          ) scheduled
        ), 0)::integer as load_units
      from generate_series(duty.due_from, duty.due_to, interval '1 day') series(day_value)
      where public.is_planning_worker_scheduled_at_school(duty.planning_worker_id, series.day_value::date)
        and public.school_worker_count_for_date(series.day_value::date) > 0
    ) generated_day
    order by generated_day.worker_responsibility_count,
      generated_day.load_units, generated_day.worker_count desc, generated_day.plan_date
    limit 1;

    if candidate_date is not null then
      update public.cleaning_planner_occurrences occurrence
      set scheduled_for = candidate_date,
          assigned_planning_worker_id = duty.planning_worker_id,
          updated_at = now()
      where occurrence.active and occurrence.planner_group = duty.planner_group
        and occurrence.due_from = duty.due_from;
    end if;
  end loop;

  update public.cleaning_planner_occurrences occurrence
  set assigned_planning_worker_id = (
    select slot.planning_worker_id
    from public.cleaning_rotation_slot_assignments slot
    where slot.rotation_key = 'school-fourth-floor'
      and slot.slot_index = public.school_fourth_floor_slot_for_date(occurrence.scheduled_for)
      and slot.active and slot.valid_from <= occurrence.scheduled_for
      and (slot.valid_to is null or slot.valid_to >= occurrence.scheduled_for)
    order by slot.valid_from desc limit 1
  ), updated_at = now()
  where occurrence.active and occurrence.planner_group like 'fourth|%'
    and occurrence.scheduled_for between target_from and target_to
    and not exists (
      select 1 from public.cleaning_weekly_worker_responsibilities responsibility
      where responsibility.responsibility_key = 'school-fourth-floor' and responsibility.active
        and responsibility.valid_from <= occurrence.due_from
        and (responsibility.valid_to is null or responsibility.valid_to >= occurrence.due_from)
        and responsibility.planning_worker_id is not null
    );
end;
$$;

revoke all on function public.is_standard_cleaning_cancelled(uuid, date) from public, anon, authenticated;
revoke all on function public.is_cleaning_task_scheduled_on(uuid, date) from public, anon, authenticated;
revoke all on function public.validate_cleaning_day_exception() from public, anon, authenticated;
revoke all on function public.school_worker_count_for_date(date) from public, anon, authenticated;
revoke all on function public.refresh_dynamic_school_cleaning_plan(date, date) from public, anon, authenticated;
revoke all on function public.save_cancelled_standard_cleaning_day(uuid, uuid, date, text) from public, anon;
revoke all on function public.restore_cancelled_standard_cleaning_day(uuid) from public, anon;
grant execute on function public.save_cancelled_standard_cleaning_day(uuid, uuid, date, text) to authenticated;
grant execute on function public.restore_cancelled_standard_cleaning_day(uuid) to authenticated;

do $$
declare
  kind_constraint text;
  count_function text;
  refresh_function text;
begin
  select pg_get_constraintdef(oid) into kind_constraint
  from pg_constraint
  where conrelid = 'public.cleaning_day_exceptions'::regclass
    and conname = 'cleaning_day_exceptions_kind_check';
  if kind_constraint not like '%cancelled_standard%' then
    raise exception 'Nový stav zrušeného běžného úklidu není povolený.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.cleaning_day_exceptions'::regclass) then
    raise exception 'RLS výjimek úklidových dnů musí zůstat zapnuté.';
  end if;
  if has_table_privilege('authenticated', 'public.cleaning_day_exceptions', 'DELETE') then
    raise exception 'Historii výjimek nesmí authenticated role mazat.';
  end if;
  if to_regprocedure('public.save_cancelled_standard_cleaning_day(uuid,uuid,date,text)') is null
     or to_regprocedure('public.restore_cancelled_standard_cleaning_day(uuid)') is null then
    raise exception 'Chybí RPC pro zrušení nebo obnovení běžného úklidu.';
  end if;
  if exists (
    select 1 from public.cleaning_day_exceptions exception
    where exception.kind = 'cancelled_standard' and exception.source_date is not null
  ) then
    raise exception 'Zrušený běžný den nesmí mít zdrojové datum.';
  end if;
  select pg_get_functiondef('public.school_worker_count_for_date(date)'::regprocedure) into count_function;
  if count_function not like '%is_standard_cleaning_cancelled%' then
    raise exception 'Kapacitní planner nerespektuje zrušený školní den.';
  end if;
  select pg_get_functiondef('public.refresh_dynamic_school_cleaning_plan(date,date)'::regprocedure) into refresh_function;
  if refresh_function not like '%school_worker_count_for_date(series.day_value::date) > 0%'
     or refresh_function not like '%is_standard_cleaning_cancelled%' then
    raise exception 'Periodický planner nevyřazuje zrušené školní dny.';
  end if;
  if refresh_function like '%delete from public.cleaning_completions%'
     or refresh_function like '%update public.cleaning_completions%' then
    raise exception 'Zrušení dne nesmí měnit completion historii.';
  end if;
end;
$$;

commit;
