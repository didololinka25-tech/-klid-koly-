-- Oprava rozložení týdenních povinností napříč skutečnými směnami pracovníka.
-- Navazuje na aplikovanou 03600; completion historii ani základní kapacitní planner nemění.

begin;

create or replace function public.refresh_dynamic_school_cleaning_plan(target_from date,target_to date)
returns void language plpgsql security definer set search_path=public as $$
declare
  duty record;
  candidate_date date;
begin
  if not public.can_view_school_data() then
    raise exception 'Nemate opravneni zobrazit plan.';
  end if;
  perform public.refresh_dynamic_school_cleaning_plan_base_03500(target_from, target_to);

  -- Přepočítáváme pouze odvozené přiřazení nedokončených týdenních povinností.
  -- Již uložené completions a jejich autoři zůstávají beze změny.
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

  -- Bez osobní týdenní povinnosti zůstává záložní A/B/C rotace z 03300/03500.
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
end $$;

revoke all on function public.refresh_dynamic_school_cleaning_plan(date,date) from public, anon, authenticated;

do $$
declare
  function_source text;
begin
  select pg_get_functiondef('public.refresh_dynamic_school_cleaning_plan(date,date)'::regprocedure)
  into function_source;
  if function_source not like '%order by generated_day.worker_responsibility_count,%'
     or function_source not like '%generated_day.load_units, generated_day.worker_count desc, generated_day.plan_date%' then
    raise exception 'Planner nema schvalene poradi vyberu smeny.';
  end if;
  if function_source like '%used.due_from = duty.due_from%' then
    raise exception 'Rozlozeni povinnosti je stale chybne omezene shodou due_from.';
  end if;
  if function_source like '%delete from public.cleaning_completions%'
     or function_source like '%update public.cleaning_completions%' then
    raise exception 'Rozklad tydennich povinnosti nesmi menit completion historii.';
  end if;
end $$;

commit;
