-- Bezpečná deaktivace a obnova úkolů a místností bez mazání historie.
-- Všechny funkce používají auth.uid() nepřímo přes public.is_admin().

create or replace function public.set_cleaning_task_active(
  target_task_id uuid,
  target_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_room_id uuid;
  target_room_active boolean;
  dependent_names text;
begin
  if not public.is_admin() then
    raise exception 'Pouze správce může mazat nebo obnovovat úkoly.';
  end if;

  select task.room_id, coalesce(room.active, true)
    into target_room_id, target_room_active
  from public.cleaning_tasks task
  left join public.rooms room on room.id = task.room_id
  where task.id = target_task_id
  for update of task;

  if not found then
    raise exception 'Úkol nebyl nalezen.';
  end if;

  if target_active then
    if target_room_id is not null and not target_room_active then
      raise exception 'Nejdříve obnovte místnost, do které úkol patří.';
    end if;

    if exists (
      select 1
      from public.cleaning_tasks task
      where task.id = target_task_id
        and task.requires_task_id is not null
        and not exists (
          select 1 from public.cleaning_tasks prerequisite
          where prerequisite.id = task.requires_task_id and prerequisite.active
        )
    ) then
      raise exception 'Nejdříve obnovte předchozí nutnou činnost.';
    end if;
  else
    select string_agg(dependent.name, ', ' order by dependent.sort_order, dependent.name)
      into dependent_names
    from public.cleaning_tasks dependent
    where dependent.requires_task_id = target_task_id
      and dependent.active;

    if dependent_names is not null then
      raise exception 'Úkol nelze deaktivovat. Nejprve deaktivujte navazující úkoly: %', dependent_names;
    end if;
  end if;

  update public.cleaning_tasks
  set active = target_active
  where id = target_task_id;
end;
$$;

create or replace function public.soft_delete_cleaning_room(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Pouze správce může mazat místnosti.';
  end if;

  perform 1 from public.rooms where id = target_room_id for update;
  if not found then
    raise exception 'Místnost nebyla nalezena.';
  end if;

  -- Nejprve úkoly, potom místnost. ID, vazby i completions zůstávají zachované.
  update public.cleaning_tasks
  set active = false
  where room_id = target_room_id and active;

  update public.rooms
  set active = false
  where id = target_room_id;
end;
$$;

create or replace function public.restore_cleaning_room(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Pouze správce může obnovovat místnosti.';
  end if;

  update public.rooms
  set active = true
  where id = target_room_id;

  if not found then
    raise exception 'Místnost nebyla nalezena.';
  end if;

  -- Úkoly se záměrně neobnovují automaticky.
end;
$$;

revoke all on function public.set_cleaning_task_active(uuid, boolean) from public, anon, authenticated;
revoke all on function public.soft_delete_cleaning_room(uuid) from public, anon, authenticated;
revoke all on function public.restore_cleaning_room(uuid) from public, anon, authenticated;

grant execute on function public.set_cleaning_task_active(uuid, boolean) to authenticated;
grant execute on function public.soft_delete_cleaning_room(uuid) to authenticated;
grant execute on function public.restore_cleaning_room(uuid) to authenticated;
