begin;

-- Dynamický školní planner. Historické tasks/completions nemaže a Školku nemění.
update public.cleaning_tasks set active=false
where active and plan_key like 'v2026|%' and activity_type='laundry';
update public.cleaning_tasks task set active=false from public.rooms room
where task.room_id=room.id and task.active and task.plan_key like 'v2026|%'
  and room.name='Jídelna' and task.activity_type='mirror';

-- Periodická práce má období splatnosti; konkrétní směnu vybírá planner.
update public.cleaning_tasks task
set frequency='weekly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
    period_months=null,period_week=null,period_anchor_month=null,
    cleaning_cycle_length=null,cleaning_cycle_offset=null
from public.rooms room join public.floors floor on floor.id=room.floor_id
where task.room_id=room.id and task.active and task.plan_key like 'v2026|%'
  and ((floor.name='Schodiště' and task.activity_type<>'windows') or (floor.name='4. patro' and task.frequency='weekly')
    or task.activity_type='tables' or (task.activity_type='surfaces' and task.frequency='weekly'));

with ranked as (
  select task.id,row_number() over(order by floor.sort_order,room.sort_order,task.sort_order,task.id)-1 pos
  from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type='doors'
) update public.cleaning_tasks task set frequency='monthly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=1,period_week=(1+(ranked.pos%4))::smallint,period_anchor_month=date '2026-09-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
from ranked where task.id=ranked.id;
with ranked as (
  select task.id,row_number() over(order by floor.sort_order,room.sort_order,task.sort_order,task.id)-1 pos
  from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type='windows'
) update public.cleaning_tasks task set frequency='monthly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=3,period_week=(1+(ranked.pos%4))::smallint,period_anchor_month=date '2026-09-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
from ranked where task.id=ranked.id;
update public.cleaning_tasks set frequency='monthly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=1,period_week=3,period_anchor_month=date '2026-09-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
where active and plan_key like 'v2026|%' and activity_type='tiles';
with ranked as (
  select task.id,row_number() over(order by floor.sort_order,room.sort_order,task.sort_order,task.id)-1 pos
  from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type='surfaces' and task.frequency='monthly'
) update public.cleaning_tasks task set schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=1,period_week=(1+(ranked.pos%4))::smallint,period_anchor_month=date '2026-09-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
from ranked where task.id=ranked.id;
with ranked as (
  select task.id,row_number() over(order by floor.sort_order,room.sort_order,task.sort_order,task.id)-1 pos
  from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id
  where task.active and task.plan_key like 'v2026|%' and task.activity_type='deep_clean'
    and room.name in ('Vstup','Šatna / chodba','Společenská místnost','Mediační místnost')
) update public.cleaning_tasks task set frequency='monthly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=3,period_week=(1+(ranked.pos%4))::smallint,period_anchor_month=date '2026-10-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
from ranked where task.id=ranked.id;
update public.cleaning_tasks task set frequency='monthly',schedule_days=array[1,2,3,4,5,6,7]::smallint[],monthly_day=null,
  period_months=2,period_week=4,period_anchor_month=date '2026-09-01',cleaning_cycle_length=null,cleaning_cycle_offset=null
from public.rooms room where task.room_id=room.id and task.active and task.plan_key like 'v2026|%'
  and room.name='Řadírna' and task.activity_type='deep_clean';

create table if not exists public.cleaning_rotation_definitions (
  rotation_key text primary key,title text not null,anchor_date date not null,
  weekday smallint check(weekday is null or weekday between 1 and 7),slot_count smallint not null check(slot_count between 2 and 12),
  active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.cleaning_rotation_slot_assignments (
  id uuid primary key default gen_random_uuid(),rotation_key text not null references public.cleaning_rotation_definitions(rotation_key) on delete restrict,
  slot_index smallint not null check(slot_index between 0 and 11),worker_id uuid references public.profiles(id) on delete restrict,
  valid_from date not null,valid_to date,active boolean not null default true,created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete restrict,updated_at timestamptz not null default now(),updated_by uuid references public.profiles(id) on delete restrict,
  check(valid_to is null or valid_to>=valid_from)
);
create index if not exists cleaning_rotation_slot_lookup_idx on public.cleaning_rotation_slot_assignments(rotation_key,slot_index,active,valid_from,valid_to);

create or replace function public.enforce_cleaning_rotation_slot_unambiguous() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if not new.active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.rotation_key||'|'||new.slot_index::text,3300));
  if exists(select 1 from public.cleaning_rotation_slot_assignments old where old.rotation_key=new.rotation_key and old.slot_index=new.slot_index
    and old.active and old.id<>new.id and daterange(old.valid_from,coalesce(old.valid_to,'infinity'::date),'[]') && daterange(new.valid_from,coalesce(new.valid_to,'infinity'::date),'[]'))
  then raise exception 'Platnost rotační pozice se překrývá s existujícím přiřazením.'; end if;
  return new;
end $$;
revoke all on function public.enforce_cleaning_rotation_slot_unambiguous() from public;
drop trigger if exists cleaning_rotation_slot_unambiguous on public.cleaning_rotation_slot_assignments;
create trigger cleaning_rotation_slot_unambiguous before insert or update of rotation_key,slot_index,valid_from,valid_to,active
on public.cleaning_rotation_slot_assignments for each row execute function public.enforce_cleaning_rotation_slot_unambiguous();
insert into public.cleaning_rotation_definitions(rotation_key,title,anchor_date,weekday,slot_count)
values('school-fourth-floor','4. patro',date '2026-09-04',null,3)
on conflict(rotation_key) do update set title=excluded.title,anchor_date=excluded.anchor_date,weekday=null,slot_count=excluded.slot_count,active=true,updated_at=now();
insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,valid_from,active)
select 'school-fourth-floor',slot,null,date '2026-09-04',true from generate_series(0,2) slot
where not exists(select 1 from public.cleaning_rotation_slot_assignments old where old.rotation_key='school-fourth-floor' and old.slot_index=slot and old.active);

-- Auditovatelná occurrence odděluje DUE od SCHEDULED FOR.
create table if not exists public.cleaning_planner_occurrences (
  id uuid primary key default gen_random_uuid(),task_id uuid not null references public.cleaning_tasks(id) on delete restrict,
  due_from date not null,due_to date not null,scheduled_for date,planner_group text not null,
  work_size text not null check(work_size in ('small','large','weekly-special')),
  assigned_worker_id uuid references public.profiles(id) on delete restrict,active boolean not null default true,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(task_id,due_from),check(due_to>=due_from)
);
create index if not exists cleaning_planner_occurrences_schedule_idx on public.cleaning_planner_occurrences(active,scheduled_for,due_from,due_to);
create table if not exists public.cleaning_planner_schedule_audit (
  id bigint generated always as identity primary key,
  occurrence_id uuid not null references public.cleaning_planner_occurrences(id) on delete restrict,
  old_scheduled_for date,new_scheduled_for date,changed_at timestamptz not null default now()
);
create or replace function public.audit_dynamic_cleaning_schedule_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.scheduled_for is distinct from new.scheduled_for then
    insert into public.cleaning_planner_schedule_audit(occurrence_id,old_scheduled_for,new_scheduled_for)
    values(new.id,old.scheduled_for,new.scheduled_for);
  end if;
  return new;
end $$;
revoke all on function public.audit_dynamic_cleaning_schedule_change() from public;
drop trigger if exists audit_dynamic_cleaning_schedule_change on public.cleaning_planner_occurrences;
create trigger audit_dynamic_cleaning_schedule_change after update of scheduled_for on public.cleaning_planner_occurrences
for each row execute function public.audit_dynamic_cleaning_schedule_change();

create or replace function public.invalidate_future_dynamic_cleaning_plan() returns trigger
language plpgsql security definer set search_path=public as $$
declare effective_from date;
begin
  if tg_table_name='worker_schedule_exceptions' then
    effective_from:=(to_jsonb(new)->>'exception_date')::date;
  elsif tg_op='INSERT' then
    effective_from:=(to_jsonb(new)->>'valid_from')::date;
  else
    effective_from:=least((to_jsonb(new)->>'valid_from')::date,(to_jsonb(old)->>'valid_from')::date);
  end if;
  update public.cleaning_planner_occurrences occurrence set scheduled_for=null,assigned_worker_id=null,updated_at=now()
  where occurrence.active and occurrence.scheduled_for>=effective_from
    and not exists(select 1 from public.cleaning_completions completion where completion.task_id=occurrence.task_id
      and completion.completion_date=occurrence.scheduled_for and completion.completed);
  return new;
end $$;
revoke all on function public.invalidate_future_dynamic_cleaning_plan() from public;
drop trigger if exists worker_assignments_invalidate_dynamic_plan on public.worker_work_assignments;
create trigger worker_assignments_invalidate_dynamic_plan after insert or update on public.worker_work_assignments
for each row execute function public.invalidate_future_dynamic_cleaning_plan();
drop trigger if exists worker_exceptions_invalidate_dynamic_plan on public.worker_schedule_exceptions;
create trigger worker_exceptions_invalidate_dynamic_plan after insert or update on public.worker_schedule_exceptions
for each row execute function public.invalidate_future_dynamic_cleaning_plan();

create or replace function public.school_worker_count_for_date(target_date date) returns integer
language sql security definer stable set search_path=public as $$
  with school as (select id from public.buildings where name='Škola' and active order by id limit 1),
  overridden as (select distinct worker_id from public.worker_schedule_exceptions where active and exception_date=target_date),
  planned as (
    select a.worker_id from public.worker_work_assignments a,school where a.active and a.building_id=school.id
      and target_date between a.valid_from and coalesce(a.valid_to,'infinity'::date) and extract(isodow from target_date)::smallint=any(a.weekdays)
      and not exists(select 1 from overridden where worker_id=a.worker_id)
    union select e.worker_id from public.worker_schedule_exceptions e,school where e.active and e.exception_date=target_date and e.planned and e.building_id=school.id
  ) select count(distinct worker_id)::integer from planned;
$$;
create or replace function public.best_school_shift_for_week(target_date date) returns date
language sql security definer stable set search_path=public as $$
  select day::date from generate_series(date_trunc('week',target_date)::date,date_trunc('week',target_date)::date+6,interval '1 day') day
  where public.school_worker_count_for_date(day::date)>=2 order by public.school_worker_count_for_date(day::date) desc,day::date limit 1;
$$;
create or replace function public.school_rotating_floor_for_date(target_date date) returns text
language sql security definer stable set search_path=public as $$
  select case when ((select count(*) from generate_series(date '2026-08-31',target_date,interval '1 day') day
    where public.school_worker_count_for_date(day::date)>=2)-1)%2=0 then '2. patro' else '3. patro' end;
$$;
create or replace function public.school_fourth_floor_slot_for_date(target_date date) returns smallint
language sql security definer stable set search_path=public as $$
  select mod(greatest(0,(select count(*) from generate_series(date_trunc('week',date '2026-09-04')::date,
    date_trunc('week',target_date)::date,interval '7 days') week
    where public.best_school_shift_for_week(week::date) is not null)-1),
    (select slot_count from public.cleaning_rotation_definitions where rotation_key='school-fourth-floor' and active))::smallint;
$$;

create or replace function public.refresh_dynamic_school_cleaning_plan(target_from date,target_to date) returns void
language plpgsql security definer set search_path=public as $$
declare month_cursor date; week_cursor date; group_row record; candidate date;
  weekly_count integer; small_count integer; large_count integer; load_units integer;
begin
  if not public.can_view_school_data() then raise exception 'Nemáte oprávnění zobrazit plán.'; end if;
  if target_from is null or target_to is null or target_to<target_from or target_to-target_from>100 then raise exception 'Neplatný interval planneru.'; end if;
  perform pg_advisory_xact_lock(3300,1);
  for week_cursor in select generate_series(date_trunc('week',target_from)::date,date_trunc('week',target_to)::date,interval '7 days')::date loop
    insert into public.cleaning_planner_occurrences(task_id,due_from,due_to,planner_group,work_size)
    select task.id,week_cursor,week_cursor+6,case when floor.name='Schodiště' then 'stairs|'||week_cursor when floor.name='4. patro' then 'fourth|'||week_cursor else 'small|'||task.activity_type||'|'||floor.id||'|'||week_cursor end,
      case when floor.name in ('Schodiště','4. patro') then 'weekly-special' else 'small' end
    from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id join public.buildings building on building.id=room.building_id
    where building.name='Škola' and task.active and room.active and task.plan_key like 'v2026|%' and task.frequency='weekly'
      and (floor.name in ('Schodiště','4. patro') or task.activity_type in ('tables','surfaces')) on conflict(task_id,due_from) do nothing;
  end loop;
  for month_cursor in select generate_series(date_trunc('month',target_from-interval '5 months')::date,date_trunc('month',target_to)::date,interval '1 month')::date loop
    insert into public.cleaning_planner_occurrences(task_id,due_from,due_to,planner_group,work_size)
    select task.id,month_cursor,(month_cursor+interval '1 month'-interval '1 day')::date,
      (case when task.activity_type in ('windows','deep_clean') then 'large|' else 'small|' end)||task.activity_type||'|'||floor.id||'|'||coalesce(task.period_week,0)||'|'||month_cursor,
      case when task.activity_type in ('windows','deep_clean') then 'large' else 'small' end
    from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id join public.buildings building on building.id=room.building_id
    where building.name='Škola' and task.active and room.active and task.plan_key like 'v2026|%' and task.period_months is not null
      and task.activity_type in ('windows','deep_clean','doors','tiles','surfaces')
      and month_cursor>=date_trunc('month',task.period_anchor_month)::date
      and mod((extract(year from month_cursor)::int-extract(year from task.period_anchor_month)::int)*12+extract(month from month_cursor)::int-extract(month from task.period_anchor_month)::int,task.period_months)=0
    on conflict(task_id,due_from) do nothing;
  end loop;
  update public.cleaning_planner_occurrences o set scheduled_for=null,updated_at=now()
  where o.active and o.scheduled_for<target_from and not exists(select 1 from public.cleaning_completions c where c.task_id=o.task_id and c.completed and c.completion_date between o.due_from and greatest(o.due_to,o.scheduled_for));
  for group_row in select planner_group,due_from,min(due_to) due_to,work_size,min(id) stable_id from public.cleaning_planner_occurrences o
    where o.active and o.scheduled_for is null and o.due_from<=target_to
      and not exists(select 1 from public.cleaning_completions c where c.task_id=o.task_id and c.completed and c.completion_date between o.due_from and greatest(o.due_to,target_from-1))
    group by planner_group,due_from,work_size
    order by (min(due_to)<target_from)::integer desc,due_from,case work_size when 'weekly-special' then 0 when 'large' then 1 else 2 end,stable_id
  loop
    candidate:=null;
    for candidate in
      select shift.day from (
        select day::date day,public.school_worker_count_for_date(day::date) worker_count,
          coalesce((select sum(case scheduled.work_size when 'large' then 2 else 1 end)
            from (select distinct used.planner_group,used.work_size from public.cleaning_planner_occurrences used
              where used.active and used.scheduled_for=day::date) scheduled),0)::integer load_units
        from generate_series(greatest(group_row.due_from,target_from),least(target_from+100,greatest(target_to,group_row.due_to)),interval '1 day') day
      ) shift
      where shift.worker_count>=case when group_row.work_size='large' then 3 else 2 end
      order by case when group_row.work_size='weekly-special' then (shift.load_units+1>least(shift.worker_count,3))::integer else 0 end,
        shift.worker_count desc,shift.load_units,shift.day
    loop
      select count(*) filter(where scheduled.work_size='weekly-special'),count(*) filter(where scheduled.work_size='small'),
        count(*) filter(where scheduled.work_size='large'),coalesce(sum(case scheduled.work_size when 'large' then 2 else 1 end),0)
      into weekly_count,small_count,large_count,load_units
      from (select distinct used.planner_group,used.work_size from public.cleaning_planner_occurrences used
        where used.active and used.scheduled_for=candidate) scheduled;
      if group_row.work_size='weekly-special'
        or (group_row.work_size='large' and large_count=0 and small_count=0
          and load_units+2<=least(public.school_worker_count_for_date(candidate),3))
        or (group_row.work_size='small' and large_count=0
          and small_count<case when public.school_worker_count_for_date(candidate)>=3 then 2 else 1 end
          and load_units+1<=least(public.school_worker_count_for_date(candidate),3)) then exit; end if;
      candidate:=null;
    end loop;
    if candidate is not null then update public.cleaning_planner_occurrences set scheduled_for=candidate,updated_at=now()
      where active and planner_group=group_row.planner_group and due_from=group_row.due_from; end if;
  end loop;
  update public.cleaning_planner_occurrences occurrence set assigned_worker_id=(
    select slot.worker_id from public.cleaning_rotation_slot_assignments slot
    where slot.rotation_key='school-fourth-floor' and slot.slot_index=public.school_fourth_floor_slot_for_date(occurrence.scheduled_for)
      and slot.active and slot.valid_from<=occurrence.scheduled_for and (slot.valid_to is null or slot.valid_to>=occurrence.scheduled_for)
    order by slot.valid_from desc limit 1),updated_at=now()
  where occurrence.active and occurrence.planner_group like 'fourth|%' and occurrence.scheduled_for between target_from and target_to;
end $$;

create or replace function public.get_dynamic_school_cleaning_plan(target_from date,target_to date)
returns table(task_id uuid,scheduled_date date,plan_reason text,due_from date,due_to date,assigned_worker_id uuid,planner_priority integer)
language plpgsql security definer set search_path=public as $$
begin
  perform public.refresh_dynamic_school_cleaning_plan(target_from,target_to);
  return query with dates as (select day::date plan_date,public.school_worker_count_for_date(day::date) worker_count from generate_series(target_from,target_to,interval '1 day') day),
  school_tasks as (select task.*,room.name room_name,room.sort_order room_sort,floor.name floor_name,floor.sort_order floor_sort from public.cleaning_tasks task join public.rooms room on room.id=task.room_id join public.floors floor on floor.id=room.floor_id join public.buildings building on building.id=room.building_id where task.active and room.active and task.plan_key like 'v2026|%' and building.name='Škola'),
  routine as (select task.id,dates.plan_date,case when dates.worker_count=1 and task.room_name like 'WC %' then 'wc-queue' else 'routine' end reason,
    case when dates.worker_count=1 and task.room_name like 'WC %' then task.floor_sort*10000+task.room_sort*100+task.sort_order else null end priority
    from dates join school_tasks task on dates.worker_count>0 and ((task.floor_name='1. patro' and task.activity_type in ('vacuum','mop')) or (task.room_name like 'WC %' and task.activity_type not in ('windows','doors','tiles','tables','surfaces','deep_clean','laundry')) or (dates.worker_count=2 and task.floor_name=public.school_rotating_floor_for_date(dates.plan_date) and task.activity_type in ('vacuum','mop')) or (dates.worker_count>=3 and task.floor_name in ('2. patro','3. patro') and task.activity_type in ('vacuum','mop')))),
  planned as (select o.task_id,o.scheduled_for,case when o.due_to<o.scheduled_for then 'overdue' else o.work_size end,o.due_from,o.due_to,o.assigned_worker_id,null::integer from public.cleaning_planner_occurrences o where o.active and o.scheduled_for between target_from and target_to)
  select routine.id,routine.plan_date,routine.reason,routine.plan_date,routine.plan_date,null::uuid,routine.priority from routine union all select * from planned;
end $$;

-- Completion autorizace používá stejný serverový planner. testCleaningDay zůstává
-- čistě frontendové preview a tuto kontrolu nikdy neobchází.
create or replace function public.can_complete_task(target_task_id uuid,target_date date)
returns boolean language sql security definer set search_path=public volatile as $$
  select target_date is not null and public.can_work_in_app()
    and not exists(
      select 1 from public.cleaning_tasks dependent where dependent.id=target_task_id and dependent.requires_task_id is not null
        and not exists(select 1 from public.cleaning_completions prerequisite where prerequisite.task_id=dependent.requires_task_id
          and prerequisite.completion_date=target_date and prerequisite.completed)
    )
    and (
      exists(
        select 1 from public.cleaning_day_exceptions exception join public.cleaning_tasks task on task.id=target_task_id
        left join public.rooms room on room.id=task.room_id
        where exception.execution_date=target_date and exception.status='active' and exception.scope_type='whole_school'
          and task.active and task.activity_type<>'disinfect' and (task.room_id is null or room.active)
          and (task.room_id is null or room.building_id=exception.building_id)
          and ((exception.kind='extraordinary' and public.is_task_in_extraordinary_cleaning_day(exception.id,target_task_id))
            or (exception.kind='rescheduled' and (
              public.is_cleaning_task_scheduled_on(target_task_id,exception.source_date)
              or exists(select 1 from public.get_dynamic_school_cleaning_plan(exception.source_date,exception.source_date) plan where plan.task_id=target_task_id)
            )))
      )
      or (
        exists(select 1 from public.get_dynamic_school_cleaning_plan(target_date,target_date) plan where plan.task_id=target_task_id)
        and not exists(select 1 from public.cleaning_day_exceptions moved join public.cleaning_tasks task on task.id=target_task_id
          left join public.rooms room on room.id=task.room_id where moved.kind='rescheduled' and moved.status='active'
          and moved.source_date=target_date and moved.building_id=coalesce(room.building_id,moved.building_id))
      )
      or (
        public.is_cleaning_task_scheduled_on(target_task_id,target_date)
        and not exists(select 1 from public.cleaning_tasks task join public.rooms room on room.id=task.room_id
          join public.buildings building on building.id=room.building_id where task.id=target_task_id and building.name='Škola')
      )
    );
$$;

create or replace function public.admin_set_cleaning_rotation_slot(target_rotation_key text,target_slot_index smallint,target_worker_id uuid,target_effective_from date)
returns uuid language plpgsql security definer set search_path=public as $$
declare d public.cleaning_rotation_definitions%rowtype; current_slot public.cleaning_rotation_slot_assignments%rowtype; next_from date; saved uuid;
begin
  if not public.is_admin() then raise exception 'Rotaci může měnit pouze správce.'; end if;
  select * into d from public.cleaning_rotation_definitions where rotation_key=target_rotation_key and active;
  if not found or target_slot_index<0 or target_slot_index>=d.slot_count then raise exception 'Neplatná rotační pozice.'; end if;
  if target_worker_id is not null and not exists(select 1 from public.profiles where id=target_worker_id and active and access_role in ('cleaning_team','admin')) then raise exception 'Vybraný pracovník není aktivní člen úklidového týmu.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_rotation_key||'|'||target_slot_index::text,3300));
  select * into current_slot from public.cleaning_rotation_slot_assignments where rotation_key=target_rotation_key and slot_index=target_slot_index and active and valid_from<=target_effective_from and (valid_to is null or valid_to>=target_effective_from) order by valid_from desc limit 1 for update;
  if found and current_slot.valid_from=target_effective_from then update public.cleaning_rotation_slot_assignments set worker_id=target_worker_id,updated_at=now(),updated_by=auth.uid() where id=current_slot.id returning id into saved; return saved; end if;
  if found then update public.cleaning_rotation_slot_assignments set valid_to=target_effective_from-1,updated_at=now(),updated_by=auth.uid() where id=current_slot.id; end if;
  select min(valid_from) into next_from from public.cleaning_rotation_slot_assignments where rotation_key=target_rotation_key and slot_index=target_slot_index and active and valid_from>target_effective_from;
  insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,valid_from,valid_to,active,created_by,updated_by)
  values(target_rotation_key,target_slot_index,target_worker_id,target_effective_from,case when next_from is null then null else next_from-1 end,true,auth.uid(),auth.uid()) returning id into saved; return saved;
end $$;

-- Rozšíření stávajícího čtecího RPC bez změny assignments/exceptions.
create or replace function public.get_worker_work_planning() returns jsonb language plpgsql security definer stable set search_path=public as $$
begin
  if not public.can_view_school_data() then raise exception 'Nemáte oprávnění zobrazit pracovní rozdělení.'; end if;
  return jsonb_build_object(
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'worker_name',coalesce(nullif(btrim(p.full_name),''),'Pracovník'),'building_id',a.building_id,'building_name',b.name,'floor_id',a.floor_id,'floor_name',f.name,'area_label',a.area_label,'weekdays',a.weekdays,'valid_from',a.valid_from,'valid_to',a.valid_to,'active',a.active) order by p.full_name,a.valid_from) from public.worker_work_assignments a join public.profiles p on p.id=a.worker_id join public.buildings b on b.id=a.building_id left join public.floors f on f.id=a.floor_id),'[]'::jsonb),
    'exceptions',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'worker_id',e.worker_id,'worker_name',coalesce(nullif(btrim(p.full_name),''),'Pracovník'),'exception_date',e.exception_date,'planned',e.planned,'building_id',e.building_id,'building_name',b.name,'floor_id',e.floor_id,'floor_name',f.name,'area_label',e.area_label,'note',e.note,'active',e.active) order by e.exception_date,p.full_name) from public.worker_schedule_exceptions e join public.profiles p on p.id=e.worker_id left join public.buildings b on b.id=e.building_id left join public.floors f on f.id=e.floor_id),'[]'::jsonb),
    'rotation_definitions',coalesce((select jsonb_agg(jsonb_build_object('rotation_key',d.rotation_key,'title',d.title,'anchor_date',d.anchor_date,'weekday',d.weekday,'slot_count',d.slot_count,'active',d.active)) from public.cleaning_rotation_definitions d),'[]'::jsonb),
    'rotation_slots',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'rotation_key',s.rotation_key,'slot_index',s.slot_index,'worker_id',s.worker_id,'worker_name',case when s.worker_id is null then null else coalesce(nullif(btrim(p.full_name),''),'Pracovník') end,'valid_from',s.valid_from,'valid_to',s.valid_to,'active',s.active) order by s.slot_index,s.valid_from) from public.cleaning_rotation_slot_assignments s left join public.profiles p on p.id=s.worker_id),'[]'::jsonb));
end $$;

alter table public.cleaning_rotation_definitions enable row level security;
alter table public.cleaning_rotation_slot_assignments enable row level security;
alter table public.cleaning_planner_occurrences enable row level security;
alter table public.cleaning_planner_schedule_audit enable row level security;
drop policy if exists "approved users read cleaning rotations" on public.cleaning_rotation_definitions;
create policy "approved users read cleaning rotations" on public.cleaning_rotation_definitions for select to authenticated using(public.can_view_school_data());
drop policy if exists "approved users read cleaning rotation slots" on public.cleaning_rotation_slot_assignments;
create policy "approved users read cleaning rotation slots" on public.cleaning_rotation_slot_assignments for select to authenticated using(public.can_view_school_data());
drop policy if exists "approved users read cleaning planner" on public.cleaning_planner_occurrences;
create policy "approved users read cleaning planner" on public.cleaning_planner_occurrences for select to authenticated using(public.can_view_school_data());
drop policy if exists "approved users read cleaning planner audit" on public.cleaning_planner_schedule_audit;
create policy "approved users read cleaning planner audit" on public.cleaning_planner_schedule_audit for select to authenticated using(public.can_view_school_data());
grant select on public.cleaning_rotation_definitions,public.cleaning_rotation_slot_assignments,public.cleaning_planner_occurrences,public.cleaning_planner_schedule_audit to authenticated;
revoke insert,update,delete on public.cleaning_rotation_definitions,public.cleaning_rotation_slot_assignments,public.cleaning_planner_occurrences,public.cleaning_planner_schedule_audit from anon,authenticated;
revoke all on function public.school_worker_count_for_date(date),public.best_school_shift_for_week(date),public.school_rotating_floor_for_date(date),public.school_fourth_floor_slot_for_date(date),public.refresh_dynamic_school_cleaning_plan(date,date) from public,anon,authenticated;
revoke all on function public.get_dynamic_school_cleaning_plan(date,date),public.get_worker_work_planning(),public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) from public,anon;
grant execute on function public.get_dynamic_school_cleaning_plan(date,date),public.get_worker_work_planning(),public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) to authenticated;
revoke all on function public.can_complete_task(uuid,date) from public,anon;
grant execute on function public.can_complete_task(uuid,date) to authenticated;

do $$ begin
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type='laundry') then raise exception 'Praní nesmí být aktivní kalendářní práce.'; end if;
  if exists(select 1 from public.cleaning_tasks task join public.rooms room on room.id=task.room_id where task.active and task.plan_key like 'v2026|%' and room.name='Jídelna' and task.activity_type='mirror') then raise exception 'Zrcadlo Jídelny nesmí být aktivní.'; end if;
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type='windows' and period_months is distinct from 3::smallint) then raise exception 'Okna musí být čtvrtletní.'; end if;
  if exists(select 1 from public.cleaning_tasks where active and plan_key like 'v2026|%' and activity_type in ('tables','doors','tiles','surfaces','windows','deep_clean') and schedule_days is distinct from array[1,2,3,4,5,6,7]::smallint[]) then raise exception 'Periodické práce nesmí mít pevný den.'; end if;
  if (select weekday from public.cleaning_rotation_definitions where rotation_key='school-fourth-floor') is not null then raise exception 'Rotace 4. patra nesmí mít pevný den.'; end if;
  if not (select relrowsecurity from pg_class where oid='public.cleaning_planner_occurrences'::regclass) then raise exception 'RLS planneru musí být zapnuté.'; end if;
  if not (select relrowsecurity from pg_class where oid='public.cleaning_planner_schedule_audit'::regclass) then raise exception 'RLS auditu planneru musí být zapnuté.'; end if;
  if has_table_privilege('authenticated','public.cleaning_planner_occurrences','INSERT,UPDATE,DELETE') then raise exception 'Přímý zápis planneru nesmí být povolen.'; end if;
  if has_table_privilege('authenticated','public.cleaning_planner_schedule_audit','INSERT,UPDATE,DELETE') then raise exception 'Přímý zápis auditu planneru nesmí být povolen.'; end if;
  if to_regprocedure('public.get_dynamic_school_cleaning_plan(date,date)') is null then raise exception 'Chybí RPC dynamického planneru.'; end if;
end $$;

commit;
