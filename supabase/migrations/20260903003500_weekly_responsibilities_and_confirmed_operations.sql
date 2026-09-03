-- Potvrzene provozni upravy po dynamickem planneru:
-- obecne tydenni povinnosti pracovniku, vytah, spolecna mistnost 2F a zavada vylevky.

begin;

-- Tydenni povinnost ma stabilni identitu planovaciho pracovnika a historickou platnost.
create table if not exists public.cleaning_weekly_worker_responsibilities (
  id uuid primary key default gen_random_uuid(),
  responsibility_key text not null,
  planning_worker_id uuid references public.planning_workers(id) on delete restrict,
  valid_from date not null,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  constraint cleaning_weekly_responsibility_key_valid check (
    responsibility_key in ('school-fourth-floor', 'school-stairs')
  ),
  constraint cleaning_weekly_responsibility_dates_valid check (
    valid_to is null or valid_to >= valid_from
  ),
  constraint cleaning_weekly_responsibility_starts_monday check (
    extract(isodow from valid_from) = 1
  )
);

create index if not exists cleaning_weekly_responsibility_lookup_idx
  on public.cleaning_weekly_worker_responsibilities(responsibility_key, active, valid_from, valid_to);

create or replace function public.enforce_cleaning_weekly_responsibility_unambiguous()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.responsibility_key, 3500));
  if new.active and exists (
    select 1
    from public.cleaning_weekly_worker_responsibilities existing_assignment
    where existing_assignment.responsibility_key = new.responsibility_key
      and existing_assignment.active
      and existing_assignment.id <> new.id
      and daterange(existing_assignment.valid_from, coalesce(existing_assignment.valid_to, 'infinity'::date), '[]')
          && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Tato tydenni povinnost uz ma v danem obdobi prirazeneho pracovnika.';
  end if;
  return new;
end $$;

revoke all on function public.enforce_cleaning_weekly_responsibility_unambiguous() from public, anon, authenticated;
drop trigger if exists cleaning_weekly_responsibility_unambiguous on public.cleaning_weekly_worker_responsibilities;
create trigger cleaning_weekly_responsibility_unambiguous
before insert or update of responsibility_key, valid_from, valid_to, active
on public.cleaning_weekly_worker_responsibilities
for each row execute function public.enforce_cleaning_weekly_responsibility_unambiguous();

alter table public.cleaning_weekly_worker_responsibilities enable row level security;
drop policy if exists "approved users read weekly responsibilities" on public.cleaning_weekly_worker_responsibilities;
create policy "approved users read weekly responsibilities"
on public.cleaning_weekly_worker_responsibilities for select to authenticated
using (public.can_view_school_data());

revoke all on public.cleaning_weekly_worker_responsibilities from anon, authenticated;
grant select on public.cleaning_weekly_worker_responsibilities to authenticated;

alter table public.cleaning_planner_occurrences
  add column if not exists assigned_planning_worker_id uuid
    references public.planning_workers(id) on delete restrict;

create or replace function public.admin_set_cleaning_weekly_responsibility(
  target_responsibility_key text,
  target_planning_worker_id uuid,
  target_effective_from date
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  current_assignment public.cleaning_weekly_worker_responsibilities%rowtype;
  next_from date;
  saved_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Tydenni povinnosti muze menit pouze spravce.';
  end if;
  if target_responsibility_key not in ('school-fourth-floor', 'school-stairs') then
    raise exception 'Neplatna tydenni povinnost.';
  end if;
  if target_effective_from is null or extract(isodow from target_effective_from) <> 1 then
    raise exception 'Platnost tydenni povinnosti musi zacinat v pondeli.';
  end if;
  if target_planning_worker_id is not null and not exists (
    select 1 from public.planning_workers worker
    where worker.id = target_planning_worker_id and worker.active
  ) then
    raise exception 'Vybrany pracovnik neni aktivni.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_responsibility_key, 3500));
  select * into current_assignment
  from public.cleaning_weekly_worker_responsibilities assignment
  where assignment.responsibility_key = target_responsibility_key
    and assignment.active
    and assignment.valid_from <= target_effective_from
    and (assignment.valid_to is null or assignment.valid_to >= target_effective_from)
  order by assignment.valid_from desc
  limit 1 for update;

  if found and current_assignment.valid_from = target_effective_from then
    update public.cleaning_weekly_worker_responsibilities
    set planning_worker_id = target_planning_worker_id,
        updated_at = now(), updated_by = auth.uid()
    where id = current_assignment.id
    returning id into saved_id;
  else
    if found then
      update public.cleaning_weekly_worker_responsibilities
      set valid_to = target_effective_from - 1,
          updated_at = now(), updated_by = auth.uid()
      where id = current_assignment.id;
    end if;
    select min(assignment.valid_from) into next_from
    from public.cleaning_weekly_worker_responsibilities assignment
    where assignment.responsibility_key = target_responsibility_key
      and assignment.active and assignment.valid_from > target_effective_from;
    insert into public.cleaning_weekly_worker_responsibilities(
      responsibility_key, planning_worker_id, valid_from, valid_to, active, created_by, updated_by
    ) values (
      target_responsibility_key, target_planning_worker_id, target_effective_from,
      case when next_from is null then null else next_from - 1 end,
      true, auth.uid(), auth.uid()
    ) returning id into saved_id;
  end if;

  update public.cleaning_planner_occurrences occurrence
  set scheduled_for = null, assigned_worker_id = null,
      assigned_planning_worker_id = null, updated_at = now()
  where occurrence.active
    and occurrence.due_to >= target_effective_from
    and occurrence.planner_group like case target_responsibility_key
      when 'school-fourth-floor' then 'fourth|%'
      else 'stairs|%'
    end
    and not exists (
      select 1 from public.cleaning_completions completion
      where completion.task_id = occurrence.task_id and completion.completed
        and completion.completion_date between occurrence.due_from and occurrence.due_to
    );
  return saved_id;
end $$;

revoke all on function public.admin_set_cleaning_weekly_responsibility(text,uuid,date) from public, anon;
grant execute on function public.admin_set_cleaning_weekly_responsibility(text,uuid,date) to authenticated;

-- Planner umi poznat smenu planovaci osoby i bez Auth uctu.
create or replace function public.is_planning_worker_scheduled_at_school(
  target_planning_worker_id uuid,
  target_date date
) returns boolean language sql security definer stable set search_path=public as $$
  with school as (
    select id from public.buildings where name = 'Škola' and active order by id limit 1
  ), day_exception as (
    select exception.* from public.worker_schedule_exceptions exception
    where exception.active and exception.planning_worker_id = target_planning_worker_id
      and exception.exception_date = target_date
    limit 1
  )
  select exists (
    select 1 from day_exception exception, school
    where exception.planned and exception.building_id = school.id
    union all
    select 1 from public.worker_work_assignments assignment
      join public.planning_workers worker on worker.id = assignment.planning_worker_id and worker.active,
      school
    where assignment.active and assignment.planning_worker_id = target_planning_worker_id
      and assignment.building_id = school.id
      and target_date between assignment.valid_from and coalesce(assignment.valid_to, 'infinity'::date)
      and extract(isodow from target_date)::smallint = any(assignment.weekdays)
      and not exists(select 1 from day_exception)
  );
$$;

revoke all on function public.is_planning_worker_scheduled_at_school(uuid,date) from public, anon, authenticated;

-- Zachovame schvaleny planner jako nedotceny zaklad a doplnime pouze volbu smeny
-- osoby odpovedne za 4F / schodiste.
do $$
begin
  if to_regprocedure('public.refresh_dynamic_school_cleaning_plan_base_03500(date,date)') is null then
    alter function public.refresh_dynamic_school_cleaning_plan(date,date)
      rename to refresh_dynamic_school_cleaning_plan_base_03500;
  end if;
end $$;

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
    order by generated_day.load_units, generated_day.worker_count desc, generated_day.plan_date
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

  -- Bez explicitni tydenni povinnosti zustava zpetne kompatibilni rotace 4F.
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
revoke all on function public.refresh_dynamic_school_cleaning_plan_base_03500(date,date) from public, anon, authenticated;

create or replace function public.get_dynamic_school_cleaning_plan(target_from date,target_to date)
returns table(task_id uuid,scheduled_date date,plan_reason text,due_from date,due_to date,assigned_worker_id uuid,planner_priority integer)
language plpgsql security definer set search_path=public as $$
begin
  perform public.refresh_dynamic_school_cleaning_plan(target_from,target_to);
  return query with dates as (
    select generated_day.plan_timestamp::date as plan_date,
      public.school_worker_count_for_date(generated_day.plan_timestamp::date) as worker_count
    from generate_series(target_from,target_to,interval '1 day') as generated_day(plan_timestamp)
  ),
  school_tasks as (
    select task.*,room.name room_name,room.sort_order room_sort,floor.name floor_name,floor.sort_order floor_sort
    from public.cleaning_tasks task join public.rooms room on room.id=task.room_id
      join public.floors floor on floor.id=room.floor_id
      join public.buildings building on building.id=room.building_id
    where task.active and room.active and task.plan_key like 'v2026|%' and building.name='Škola'
  ),
  routine as (
    select task.id,dates.plan_date,
      case when dates.worker_count=1 and task.room_name like 'WC %' then 'wc-queue' else 'routine' end reason,
      case when dates.worker_count=1 and task.room_name like 'WC %' then task.floor_sort*10000+task.room_sort*100+task.sort_order else null end priority
    from dates join school_tasks task on dates.worker_count>0 and (
      (task.floor_name='1. patro' and task.activity_type in ('vacuum','mop'))
      or (task.room_name like 'WC %' and task.activity_type not in ('windows','doors','tiles','tables','surfaces','deep_clean','laundry'))
      or (dates.worker_count=2 and task.floor_name=public.school_rotating_floor_for_date(dates.plan_date) and task.activity_type in ('vacuum','mop'))
      or (dates.worker_count>=3 and task.floor_name in ('2. patro','3. patro') and task.activity_type in ('vacuum','mop'))
    )
  ),
  planned as (
    select occurrence.task_id, occurrence.scheduled_for,
      case when occurrence.due_to < occurrence.scheduled_for then 'overdue' else occurrence.work_size end,
      occurrence.due_from, occurrence.due_to,
      coalesce(occurrence.assigned_planning_worker_id, occurrence.assigned_worker_id), null::integer
    from public.cleaning_planner_occurrences occurrence
    where occurrence.active and occurrence.scheduled_for between target_from and target_to
  )
  select routine.id,routine.plan_date,routine.reason,routine.plan_date,routine.plan_date,null::uuid,routine.priority from routine
  union all select * from planned;
end $$;

revoke all on function public.get_dynamic_school_cleaning_plan(date,date) from public, anon;
grant execute on function public.get_dynamic_school_cleaning_plan(date,date) to authenticated;

-- Rozsireni existujiciho cteciho RPC o tydenni povinnosti.
create or replace function public.get_worker_work_planning() returns jsonb
language plpgsql security definer stable set search_path=public as $$
begin
  if not public.can_view_school_data() then raise exception 'Nemate opravneni zobrazit pracovni rozdeleni.'; end if;
  return jsonb_build_object(
    'planning_workers',coalesce((select jsonb_agg(jsonb_build_object('id',worker.id,'display_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'active',worker.active) order by worker.active desc,worker.display_name) from public.planning_workers worker),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',assignment.id,'worker_id',assignment.planning_worker_id,'worker_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'building_id',assignment.building_id,'building_name',building.name,'floor_id',assignment.floor_id,'floor_name',floor.name,'area_label',assignment.area_label,'weekdays',assignment.weekdays,'valid_from',assignment.valid_from,'valid_to',assignment.valid_to,'active',assignment.active) order by worker.display_name,assignment.valid_from) from public.worker_work_assignments assignment join public.planning_workers worker on worker.id=assignment.planning_worker_id join public.buildings building on building.id=assignment.building_id left join public.floors floor on floor.id=assignment.floor_id),'[]'::jsonb),
    'exceptions',coalesce((select jsonb_agg(jsonb_build_object('id',exception.id,'worker_id',exception.planning_worker_id,'worker_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'exception_date',exception.exception_date,'planned',exception.planned,'building_id',exception.building_id,'building_name',building.name,'floor_id',exception.floor_id,'floor_name',floor.name,'area_label',exception.area_label,'note',exception.note,'active',exception.active) order by exception.exception_date,worker.display_name) from public.worker_schedule_exceptions exception join public.planning_workers worker on worker.id=exception.planning_worker_id left join public.buildings building on building.id=exception.building_id left join public.floors floor on floor.id=exception.floor_id),'[]'::jsonb),
    'rotation_definitions',coalesce((select jsonb_agg(jsonb_build_object('rotation_key',definition.rotation_key,'title',definition.title,'anchor_date',definition.anchor_date,'weekday',definition.weekday,'slot_count',definition.slot_count,'active',definition.active)) from public.cleaning_rotation_definitions definition),'[]'::jsonb),
    'rotation_slots',coalesce((select jsonb_agg(jsonb_build_object('id',slot.id,'rotation_key',slot.rotation_key,'slot_index',slot.slot_index,'worker_id',slot.planning_worker_id,'worker_name',worker.display_name,'valid_from',slot.valid_from,'valid_to',slot.valid_to,'active',slot.active) order by slot.slot_index,slot.valid_from) from public.cleaning_rotation_slot_assignments slot left join public.planning_workers worker on worker.id=slot.planning_worker_id),'[]'::jsonb),
    'weekly_responsibilities',coalesce((select jsonb_agg(jsonb_build_object('id',responsibility.id,'responsibility_key',responsibility.responsibility_key,'worker_id',responsibility.planning_worker_id,'worker_name',worker.display_name,'valid_from',responsibility.valid_from,'valid_to',responsibility.valid_to,'active',responsibility.active) order by responsibility.responsibility_key,responsibility.valid_from) from public.cleaning_weekly_worker_responsibilities responsibility left join public.planning_workers worker on worker.id=responsibility.planning_worker_id),'[]'::jsonb)
  );
end $$;

revoke all on function public.get_worker_work_planning() from public, anon;
grant execute on function public.get_worker_work_planning() to authenticated;

-- Vytah: jeden obecny tydenni ukol bez pevneho dne. Planner jej zaradi jako small.
do $$
declare
  school_id uuid;
  elevator_floor_id uuid;
  elevator_room_id uuid;
begin
  select id into school_id from public.buildings where name='Škola' and active order by id limit 1;
  if school_id is null then raise exception 'Chybi aktivni pracoviste Skola.'; end if;

  select room.id into elevator_room_id from public.rooms room
  where room.building_id=school_id and lower(btrim(room.name))=lower('Výtah') order by room.active desc limit 1;
  if elevator_room_id is null then
    insert into public.floors(building_id,name,sort_order)
    values(school_id,'Výtah',60)
    on conflict(building_id,name) do update set sort_order=excluded.sort_order
    returning id into elevator_floor_id;
    insert into public.rooms(building_id,floor_id,name,active,sort_order)
    values(school_id,elevator_floor_id,'Výtah',true,10)
    returning id into elevator_room_id;
  else
    update public.rooms set active=true where id=elevator_room_id;
  end if;

  update public.cleaning_tasks task set
    plan_key='v2026|school|elevator|weekly', frequency='weekly', activity_type='surfaces',
    schedule_days=array[1,2,3,4,5,6,7]::smallint[], monthly_day=null,
    period_months=null, period_week=null, period_anchor_month=null, active=true, updated_at=now()
  where task.id=(select existing.id from public.cleaning_tasks existing
    where existing.room_id=elevator_room_id and lower(btrim(existing.name)) in (lower('Uklidit výtah'),lower('Úklid výtahu'))
    order by existing.active desc,existing.created_at limit 1)
    and not exists(select 1 from public.cleaning_tasks keyed where keyed.plan_key='v2026|school|elevator|weekly');

  insert into public.cleaning_tasks(plan_key,room_id,name,activity_type,frequency,active,sort_order,schedule_days)
  values('v2026|school|elevator|weekly',elevator_room_id,'Uklidit výtah','surfaces','weekly',true,10,array[1,2,3,4,5,6,7]::smallint[])
  on conflict(plan_key) where plan_key is not null do update set
    room_id=excluded.room_id,name=excluded.name,activity_type=excluded.activity_type,
    frequency=excluded.frequency,active=true,sort_order=excluded.sort_order,
    schedule_days=excluded.schedule_days,monthly_day=null,period_months=null,
    period_week=null,period_anchor_month=null,updated_at=now();
end $$;

-- Pata puvodni "ucebna" je potvrzena jako spolecna mistnost pred ucebnami.
do $$
declare
  school_id uuid;
  floor_2_id uuid;
  shared_room_id uuid;
begin
  select id into school_id from public.buildings where name='Škola' and active order by id limit 1;
  select id into floor_2_id from public.floors where building_id=school_id and name='2. patro';
  select room.id into shared_room_id from public.rooms room
  where room.building_id=school_id and room.floor_id=floor_2_id and room.name='Společná místnost před učebnami'
  order by room.active desc limit 1;
  if shared_room_id is null then
    select room.id into shared_room_id from public.rooms room
    where room.building_id=school_id and room.floor_id=floor_2_id and room.name='Učebna 5'
    order by room.active desc limit 1;
    if shared_room_id is null then raise exception 'Nelze bezpečně najít původní pátý prostor 2. patra.'; end if;
    update public.rooms set name='Společná místnost před učebnami',active=true where id=shared_room_id;
  elsif exists(select 1 from public.rooms room where room.building_id=school_id and room.floor_id=floor_2_id and room.name='Učebna 5' and room.id<>shared_room_id and room.active) then
    raise exception '2. patro obsahuje současně Učebnu 5 i společnou místnost; je nutná ruční kontrola.';
  end if;

  insert into public.cleaning_tasks(plan_key,room_id,name,activity_type,frequency,active,sort_order,schedule_days)
  values
    ('v2026|school|2f-common-before-classrooms|carpet-vacuum',shared_room_id,'Vysát koberec','vacuum','cleaning_day',true,15,array[1,2,3,4,5,6,7]::smallint[]),
    ('v2026|school|2f-common-before-classrooms|carpet-deep',shared_room_id,'Hloubkově vyčistit koberec vodním vysavačem','deep_clean','monthly',true,65,array[1,2,3,4,5,6,7]::smallint[])
  on conflict(plan_key) where plan_key is not null do update set
    room_id=excluded.room_id,name=excluded.name,activity_type=excluded.activity_type,
    frequency=excluded.frequency,active=true,sort_order=excluded.sort_order,
    schedule_days=excluded.schedule_days,
    period_months=case when excluded.activity_type='deep_clean' then 3::smallint else null end,
    period_week=case when excluded.activity_type='deep_clean' then 2::smallint else null end,
    period_anchor_month=case when excluded.activity_type='deep_clean' then date '2026-09-01' else null end,
    updated_at=now();

  update public.cleaning_tasks set period_months=3,period_week=2,period_anchor_month=date '2026-09-01'
  where plan_key='v2026|school|2f-common-before-classrooms|carpet-deep';
end $$;

-- Potvrzena zavada; nevytvari se cleaning_task a existujici podobny zaznam se neduplikuje.
do $$
declare
  school_id uuid;
  utility_room_id uuid;
  owner_id uuid;
begin
  select id into school_id from public.buildings where name='Škola' and active order by id limit 1;
  select room.id into utility_room_id
  from public.rooms room join public.floors floor on floor.id=room.floor_id
  where room.building_id=school_id and room.active and floor.name='3. patro' and room.name='Úklidová místnost'
  order by room.id limit 1;
  if not exists (
    select 1 from public.incidents incident
    where incident.building_id=school_id
      and lower(coalesce(incident.title,'')||' '||coalesce(incident.description,'')||' '||coalesce(incident.note,'')) like '%výlev%'
      and lower(coalesce(incident.title,'')||' '||coalesce(incident.description,'')||' '||coalesce(incident.note,'')) like '%splach%'
  ) then
    select profile.id into owner_id from public.profiles profile
    where profile.active and profile.is_owner order by profile.id limit 1;
    if owner_id is null then raise exception 'Závadu nelze auditně založit bez aktivního owner profilu.'; end if;
    insert into public.incidents(incident_date,worker_id,building_id,room_id,description,title,note,status,active)
    values(public.app_current_date(),owner_id,school_id,utility_room_id,
      '3. patro – výlevka – nefunguje splachovadlo',
      'Nefunguje splachovadlo výlevky',
      '3. patro · Úklidová místnost','reported',true);
  end if;
end $$;

-- Zaverne bezpecnostni kontroly.
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.cleaning_weekly_worker_responsibilities'::regclass) then
    raise exception 'RLS tydennich povinnosti musi byt zapnute.';
  end if;
  if has_table_privilege('authenticated','public.cleaning_weekly_worker_responsibilities','INSERT,UPDATE,DELETE') then
    raise exception 'Primy zapis tydennich povinnosti nesmi byt povolen.';
  end if;
  if to_regprocedure('public.admin_set_cleaning_weekly_responsibility(text,uuid,date)') is null then
    raise exception 'Chybi admin RPC tydennich povinnosti.';
  end if;
  if not exists (
    select 1 from public.cleaning_tasks task join public.rooms room on room.id=task.room_id
      join public.buildings building on building.id=room.building_id
    where building.name='Škola' and room.name='Výtah' and room.active and task.active
      and task.plan_key='v2026|school|elevator|weekly' and task.frequency='weekly'
      and task.schedule_days=array[1,2,3,4,5,6,7]::smallint[]
  ) then raise exception 'Vytah nema aktivni tydenni ukol bez pevneho dne.'; end if;
  if (select count(*) from public.rooms room join public.floors floor on floor.id=room.floor_id
      join public.buildings building on building.id=room.building_id
      where building.name='Škola' and floor.name='2. patro' and room.active
        and room.name in ('Učebna 1','Učebna 2','Učebna 3','Učebna 4')) <> 4
    or exists(select 1 from public.rooms room join public.floors floor on floor.id=room.floor_id
      join public.buildings building on building.id=room.building_id
      where building.name='Škola' and floor.name='2. patro' and room.active and room.name='Učebna 5') then
    raise exception '2. patro nema ctyri ucebny a samostatnou spolecnou mistnost.';
  end if;
  if not exists (
    select 1 from public.cleaning_tasks task join public.rooms room on room.id=task.room_id
    where room.name='Společná místnost před učebnami' and room.active and task.active
      and task.activity_type='deep_clean' and task.period_months=3
  ) then raise exception 'Hloubkove cisteni koberce neni u spravne mistnosti 2. patra.'; end if;
  if exists (
    select 1 from public.cleaning_tasks task where task.active
      and lower(task.name) like '%splachovadlo%' and lower(task.name) like '%výlevka%'
  ) then raise exception 'Zavada vylevky nesmi byt cleaning_task.'; end if;
  if not exists (
    select 1 from public.incidents incident join public.buildings building on building.id=incident.building_id
    where building.name='Škola'
      and lower(coalesce(incident.title,'')||' '||coalesce(incident.description,'')||' '||coalesce(incident.note,'')) like '%výlev%'
      and lower(coalesce(incident.title,'')||' '||coalesce(incident.description,'')||' '||coalesce(incident.note,'')) like '%splach%'
  ) then raise exception 'Potvrzena zavada vylevky nebyla zachovana ani zalozena.'; end if;
end $$;

commit;
