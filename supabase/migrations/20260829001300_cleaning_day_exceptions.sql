-- Reálné mimořádné a přesunuté úklidové dny, bezpečná serverová splatnost
-- a jeden společný páteční úkol praní. Historická data se nemažou.

begin;

create table if not exists public.cleaning_day_exceptions (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id),
  kind text not null check (kind in ('extraordinary', 'rescheduled')),
  execution_date date not null,
  source_date date,
  title text not null,
  note text,
  scope_type text not null default 'whole_school'
    check (scope_type in ('whole_school')),
  status text not null default 'active'
    check (status in ('active', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cleaning_day_exception_dates_valid check (
    (kind = 'extraordinary' and source_date is null)
    or
    (kind = 'rescheduled' and source_date is not null and source_date <> execution_date)
  )
);

create unique index if not exists cleaning_day_one_active_execution_idx
  on public.cleaning_day_exceptions(building_id, execution_date)
  where status = 'active';

create unique index if not exists cleaning_day_one_active_source_idx
  on public.cleaning_day_exceptions(building_id, source_date)
  where status = 'active' and kind = 'rescheduled';

create index if not exists cleaning_day_exception_dates_idx
  on public.cleaning_day_exceptions(execution_date, source_date);

drop trigger if exists cleaning_day_exceptions_updated_at on public.cleaning_day_exceptions;
create trigger cleaning_day_exceptions_updated_at
before update on public.cleaning_day_exceptions
for each row execute procedure public.set_updated_at();

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
  select target_schedule_date is not null and exists (
    select 1
    from public.cleaning_tasks task
    left join public.rooms room on room.id = task.room_id
    where task.id = target_task_id
      and task.active
      and task.activity_type <> 'disinfect'
      and (task.room_id is null or room.active)
      and case task.frequency::text
        when 'cleaning_day' then extract(isodow from target_schedule_date)::smallint = any(task.schedule_days)
        when 'weekly' then extract(isodow from target_schedule_date)::smallint = any(task.schedule_days)
        when 'once_or_twice_weekly' then extract(isodow from target_schedule_date)::smallint = any(task.schedule_days)
        when 'monthly' then task.monthly_day = extract(day from target_schedule_date)::smallint
        when 'extraordinary' then false
        else false
      end
  );
$$;

create or replace function public.is_cleaning_task_in_standard_full_plan(
  target_task_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.cleaning_tasks task
    left join public.rooms room on room.id = task.room_id
    where task.id = target_task_id
      and task.active
      and task.activity_type <> 'disinfect'
      and task.frequency = 'cleaning_day'
      and (task.room_id is null or room.active)
  );
$$;

-- Jediné serverové rozhodnutí o splatnosti. Přesun používá source_date pro
-- výběr plánu, ale RPC dál zapisuje completion k execution_date.
create or replace function public.can_complete_task(
  target_task_id uuid,
  target_date date
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_date is not null
    and public.can_work_in_app()
    and (
      exists (
        select 1
        from public.cleaning_day_exceptions exception
        join public.cleaning_tasks task on task.id = target_task_id
        left join public.rooms room on room.id = task.room_id
        where exception.execution_date = target_date
          and exception.status = 'active'
          and exception.scope_type = 'whole_school'
          and task.active
          and task.activity_type <> 'disinfect'
          and (task.room_id is null or room.active)
          and (task.room_id is null or room.building_id = exception.building_id)
          and (
            (exception.kind = 'extraordinary'
              and public.is_cleaning_task_in_standard_full_plan(target_task_id))
            or
            (exception.kind = 'rescheduled'
              and public.is_cleaning_task_scheduled_on(target_task_id, exception.source_date))
          )
      )
      or
      (
        public.is_cleaning_task_scheduled_on(target_task_id, target_date)
        and not exists (
          select 1
          from public.cleaning_day_exceptions moved
          join public.cleaning_tasks task on task.id = target_task_id
          left join public.rooms room on room.id = task.room_id
          where moved.kind = 'rescheduled'
            and moved.status = 'active'
            and moved.source_date = target_date
            and moved.building_id = coalesce(room.building_id, moved.building_id)
        )
      )
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

  new.title := btrim(new.title);
  if new.title = '' then
    raise exception 'Název úklidového dne je povinný.';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    if old.execution_date < public.app_current_date()
       or exists (
         select 1 from public.cleaning_completions completion
         where completion.completion_date = old.execution_date
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

  return new;
end;
$$;

drop trigger if exists validate_cleaning_day_exception on public.cleaning_day_exceptions;
create trigger validate_cleaning_day_exception
before insert or update on public.cleaning_day_exceptions
for each row execute procedure public.validate_cleaning_day_exception();

alter table public.cleaning_day_exceptions enable row level security;

drop policy if exists "approved users read cleaning days" on public.cleaning_day_exceptions;
drop policy if exists "admins manage cleaning days" on public.cleaning_day_exceptions;
drop policy if exists "admins update cleaning days" on public.cleaning_day_exceptions;
create policy "approved users read cleaning days"
on public.cleaning_day_exceptions for select to authenticated
using (public.can_view_school_data());
create policy "admins manage cleaning days"
on public.cleaning_day_exceptions for insert to authenticated
with check (public.is_admin());
create policy "admins update cleaning days"
on public.cleaning_day_exceptions for update to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.cleaning_day_exceptions to authenticated;
revoke delete on public.cleaning_day_exceptions from authenticated;

revoke all on function public.is_cleaning_task_scheduled_on(uuid, date) from public, anon;
revoke all on function public.is_cleaning_task_in_standard_full_plan(uuid) from public, anon;
revoke all on function public.validate_cleaning_day_exception() from public, anon, authenticated;

-- Praní je jeden společný páteční cleaning_task. Legacy laundry_records se
-- nemění a zůstává historickou tabulkou.
update public.cleaning_tasks
set active = false
where activity_type = 'laundry'
  and active;

insert into public.cleaning_tasks (
  room_id, name, activity_type, frequency, active, sort_order, schedule_days,
  monthly_day, work_part_id, assignment_mode, rotation_anchor_date,
  rotation_interval_weeks
)
select
  null, 'Praní hadrů a utěrek', 'laundry', 'weekly', false, 80,
  array[5]::smallint[], null, null, 'fixed', null, 1
where not exists (
  select 1 from public.cleaning_tasks
  where room_id is null
    and activity_type = 'laundry'
    and name = 'Praní hadrů a utěrek'
);

with canonical as (
  select id
  from public.cleaning_tasks
  where room_id is null
    and activity_type = 'laundry'
    and name = 'Praní hadrů a utěrek'
  order by created_at, id
  limit 1
)
update public.cleaning_tasks task
set active = (task.id = canonical.id),
    frequency = 'weekly',
    schedule_days = array[5]::smallint[],
    monthly_day = null,
    work_part_id = null,
    assignment_mode = 'fixed',
    rotation_anchor_date = null,
    rotation_interval_weeks = 1,
    sort_order = 80,
    requires_task_id = null
from canonical
where task.room_id is null
  and task.activity_type = 'laundry'
  and task.name = 'Praní hadrů a utěrek';

update public.task_assignments assignment
set active = false
from public.cleaning_tasks task
where assignment.task_id = task.id
  and task.activity_type = 'laundry'
  and assignment.active;

do $$
begin
  if (
    select count(*) from public.cleaning_tasks
    where active
      and room_id is null
      and activity_type = 'laundry'
      and name = 'Praní hadrů a utěrek'
      and frequency = 'weekly'
      and schedule_days = array[5]::smallint[]
      and work_part_id is null
  ) <> 1 then
    raise exception 'Společný páteční úkol praní není právě jeden.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'cleaning_day_exceptions'
     ) then
    execute 'alter publication supabase_realtime add table public.cleaning_day_exceptions';
  end if;
end;
$$;

commit;
