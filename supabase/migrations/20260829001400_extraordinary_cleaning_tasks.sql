-- Konkrétní existující cleaning_tasks lze přidat nebo odebrat pouze pro jeden
-- mimořádný úklid. Pravidelný plán ani historické completions se nemění.

begin;

create table if not exists public.cleaning_day_exception_tasks (
  id uuid primary key default gen_random_uuid(),
  cleaning_day_exception_id uuid not null
    references public.cleaning_day_exceptions(id) on delete restrict,
  task_id uuid not null references public.cleaning_tasks(id) on delete restrict,
  included boolean not null,
  active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cleaning_day_exception_id, task_id)
);

create index if not exists cleaning_day_exception_tasks_active_idx
  on public.cleaning_day_exception_tasks(cleaning_day_exception_id, task_id)
  where active;

drop trigger if exists cleaning_day_exception_tasks_updated_at
  on public.cleaning_day_exception_tasks;
create trigger cleaning_day_exception_tasks_updated_at
before update on public.cleaning_day_exception_tasks
for each row execute procedure public.set_updated_at();

alter table public.cleaning_day_exception_tasks enable row level security;

drop policy if exists "approved users read cleaning day tasks"
  on public.cleaning_day_exception_tasks;
create policy "approved users read cleaning day tasks"
on public.cleaning_day_exception_tasks for select to authenticated
using (public.can_view_school_data());

grant select on public.cleaning_day_exception_tasks to authenticated;
revoke insert, update, delete on public.cleaning_day_exception_tasks from authenticated;

-- Vrací finální členství úkolu v jednom mimořádném dni. Bez aktivního
-- override se použije dosavadní běžný kompletní plán daného dne.
create or replace function public.is_task_in_extraordinary_cleaning_day(
  target_exception_id uuid,
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
    from public.cleaning_day_exceptions exception
    join public.cleaning_tasks task on task.id = target_task_id
    left join public.rooms room on room.id = task.room_id
    left join public.cleaning_day_exception_tasks override
      on override.cleaning_day_exception_id = exception.id
     and override.task_id = task.id
     and override.active
    where exception.id = target_exception_id
      and exception.kind = 'extraordinary'
      and exception.status = 'active'
      and task.active
      and task.activity_type <> 'disinfect'
      and (task.room_id is null or (room.active and room.building_id = exception.building_id))
      and coalesce(
        override.included,
        public.is_cleaning_task_in_standard_full_plan(task.id)
          or public.is_cleaning_task_scheduled_on(task.id, exception.execution_date)
      )
  );
$$;

-- Admin posílá úplný finální seznam vybraných task ID. Databáze uloží pouze
-- rozdíly proti běžnému kompletnímu plánu. Staré override řádky se nemažou,
-- pouze deaktivují. Již dokončený úkol nelze z výběru odstranit.
create or replace function public.set_extraordinary_cleaning_tasks(
  target_exception_id uuid,
  selected_task_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  target_exception public.cleaning_day_exceptions%rowtype;
begin
  if actor_id is null or not public.is_admin() then
    raise exception 'Mimořádný úklid může upravovat pouze správce.';
  end if;

  if target_exception_id is null or selected_task_ids is null then
    raise exception 'Úklidový den a výběr úkolů jsou povinné.';
  end if;

  select exception.*
  into target_exception
  from public.cleaning_day_exceptions exception
  where exception.id = target_exception_id
  for update;

  if not found or target_exception.kind <> 'extraordinary' then
    raise exception 'Mimořádný úklid nebyl nalezen.';
  end if;

  if target_exception.status <> 'active' then
    raise exception 'Zrušený mimořádný úklid nelze upravovat.';
  end if;

  if target_exception.execution_date < public.app_current_date() then
    raise exception 'Proběhlý mimořádný úklid nelze upravovat.';
  end if;

  if exists (
    select 1
    from unnest(selected_task_ids) selected(task_id)
    where not exists (
      select 1
      from public.cleaning_tasks task
      left join public.rooms room on room.id = task.room_id
      where task.id = selected.task_id
        and task.active
        and task.activity_type <> 'disinfect'
        and (
          task.room_id is null
          or (room.active and room.building_id = target_exception.building_id)
        )
    )
  ) then
    raise exception 'Výběr obsahuje neaktivní nebo nepovolený úkol.';
  end if;

  if exists (
    select 1
    from public.cleaning_completions completion
    join public.cleaning_tasks completed_task on completed_task.id = completion.task_id
    left join public.rooms completed_room on completed_room.id = completed_task.room_id
    where completion.completion_date = target_exception.execution_date
      and completion.completed
      and (
        completed_task.room_id is null
        or completed_room.building_id = target_exception.building_id
      )
      and not (completion.task_id = any(selected_task_ids))
  ) then
    raise exception 'Již dokončený úkol nelze z mimořádného úklidu odebrat.';
  end if;

  if exists (
    select 1
    from public.cleaning_tasks task
    where task.id = any(selected_task_ids)
      and task.requires_task_id is not null
      and not (task.requires_task_id = any(selected_task_ids))
  ) then
    raise exception 'Vybraný úkol postrádá povinnou předchozí činnost.';
  end if;

  update public.cleaning_day_exception_tasks override
  set active = false,
      updated_by = actor_id
  where override.cleaning_day_exception_id = target_exception.id
    and override.active;

  insert into public.cleaning_day_exception_tasks (
    cleaning_day_exception_id,
    task_id,
    included,
    active,
    created_by,
    updated_by
  )
  select
    target_exception.id,
    task.id,
    task.id = any(selected_task_ids),
    true,
    actor_id,
    actor_id
  from public.cleaning_tasks task
  left join public.rooms room on room.id = task.room_id
  where task.active
    and task.activity_type <> 'disinfect'
    and (
      task.room_id is null
      or (room.active and room.building_id = target_exception.building_id)
    )
    and (
      task.id = any(selected_task_ids)
    ) is distinct from (
      public.is_cleaning_task_in_standard_full_plan(task.id)
      or public.is_cleaning_task_scheduled_on(task.id, target_exception.execution_date)
    )
  on conflict (cleaning_day_exception_id, task_id) do update
  set included = excluded.included,
      active = true,
      updated_by = actor_id;
end;
$$;

-- Metadata i výběr tasků se uloží v jedné databázové transakci. Nevznikne
-- stav, kdy se změní datum/název, ale nový výběr se kvůli chybě neuloží.
create or replace function public.save_extraordinary_cleaning_day(
  target_exception_id uuid,
  target_building_id uuid,
  target_execution_date date,
  target_title text,
  target_note text,
  selected_task_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  saved_id uuid;
begin
  if actor_id is null or not public.is_admin() then
    raise exception 'Mimořádný úklid může upravovat pouze správce.';
  end if;

  if target_exception_id is null then
    insert into public.cleaning_day_exceptions (
      building_id,
      kind,
      execution_date,
      source_date,
      title,
      note,
      scope_type,
      status,
      created_by,
      updated_by
    ) values (
      target_building_id,
      'extraordinary',
      target_execution_date,
      null,
      target_title,
      nullif(btrim(target_note), ''),
      'whole_school',
      'active',
      actor_id,
      actor_id
    )
    returning id into saved_id;
  else
    update public.cleaning_day_exceptions exception
    set building_id = target_building_id,
        kind = 'extraordinary',
        execution_date = target_execution_date,
        source_date = null,
        title = target_title,
        note = nullif(btrim(target_note), ''),
        scope_type = 'whole_school',
        status = 'active'
    where exception.id = target_exception_id
      and exception.kind = 'extraordinary'
    returning exception.id into saved_id;

    if saved_id is null then
      raise exception 'Mimořádný úklid nebyl nalezen.';
    end if;
  end if;

  perform public.set_extraordinary_cleaning_tasks(saved_id, selected_task_ids);
  return saved_id;
end;
$$;

-- Rozšíření jediného serverového rozhodnutí o splatnosti. Explicitní include
-- nebo exclude se u mimořádného dne vyhodnotí zde, nikoli pouze ve frontendu.
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
    and not exists (
      select 1
      from public.cleaning_tasks dependent
      where dependent.id = target_task_id
        and dependent.requires_task_id is not null
        and not exists (
          select 1
          from public.cleaning_completions prerequisite_completion
          where prerequisite_completion.task_id = dependent.requires_task_id
            and prerequisite_completion.completion_date = target_date
            and prerequisite_completion.completed
        )
    )
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
              and public.is_task_in_extraordinary_cleaning_day(exception.id, target_task_id))
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
          from public.cleaning_day_exceptions extraordinary
          join public.cleaning_tasks task on task.id = target_task_id
          left join public.rooms room on room.id = task.room_id
          where extraordinary.kind = 'extraordinary'
            and extraordinary.status = 'active'
            and extraordinary.execution_date = target_date
            and extraordinary.building_id = coalesce(
              room.building_id,
              extraordinary.building_id
            )
            and not public.is_task_in_extraordinary_cleaning_day(
              extraordinary.id,
              target_task_id
            )
        )
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

revoke all on function public.is_task_in_extraordinary_cleaning_day(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.set_extraordinary_cleaning_tasks(uuid, uuid[])
  from public, anon;
grant execute on function public.set_extraordinary_cleaning_tasks(uuid, uuid[])
  to authenticated;
revoke all on function public.save_extraordinary_cleaning_day(
  uuid, uuid, date, text, text, uuid[]
) from public, anon;
grant execute on function public.save_extraordinary_cleaning_day(
  uuid, uuid, date, text, text, uuid[]
) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'cleaning_day_exception_tasks'
     ) then
    execute 'alter publication supabase_realtime add table public.cleaning_day_exception_tasks';
  end if;
end;
$$;

commit;
