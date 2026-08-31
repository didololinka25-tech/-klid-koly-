-- Rychlé a atomické dokončení běžného úklidu místnosti.
-- Speciální a periodické práce se vždy potvrzují samostatně.

begin;

alter table public.cleaning_tasks
  add column if not exists bulk_completable boolean;

update public.cleaning_tasks
set bulk_completable = (
  room_id is not null
  and frequency in ('cleaning_day', 'weekly', 'once_or_twice_weekly')
  and period_months is null
  and activity_type not in ('windows', 'deep_clean', 'laundry', 'disinfect')
)
where bulk_completable is null;

alter table public.cleaning_tasks
  alter column bulk_completable set default false,
  alter column bulk_completable set not null;

comment on column public.cleaning_tasks.bulk_completable is
  'Běžný úkol, který lze zahrnout do rychlého dokončení místnosti. Měsíční, mimořádné, hloubkové, okenní a prací úkoly musí zůstat false.';

create or replace function public.get_cleaning_completion_status(target_date date)
returns table(
  task_id uuid,
  completed boolean,
  completed_at timestamptz,
  worker_id uuid,
  worker_name text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if auth.uid() is null or not public.can_view_school_data() then
    raise exception 'K dokončeným úkolům nemáte oprávnění.';
  end if;

  return query
  select completion.task_id,
         completion.completed,
         completion.completed_at,
         completion.worker_id,
         profile.full_name
  from public.cleaning_completions completion
  join public.profiles profile on profile.id = completion.worker_id
  where completion.completion_date = target_date;
end;
$$;

create or replace function public.complete_cleaning_tasks_bulk(
  target_task_ids uuid[],
  target_completion_date date
)
returns table(completed_task_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_count integer;
  eligible_count integer;
  processed_count integer := 0;
  current_task_id uuid;
begin
  if auth.uid() is null or not public.can_work_in_app() then
    raise exception 'K dokončování úkolů nemáte oprávnění.';
  end if;
  if target_completion_date is distinct from public.app_current_date() then
    raise exception 'Hromadně lze uložit pouze skutečný dnešní úklid.';
  end if;

  select count(distinct requested.id)
  into requested_count
  from unnest(coalesce(target_task_ids, array[]::uuid[])) requested(id)
  where requested.id is not null;

  if requested_count = 0 then
    return;
  end if;

  select count(*)
  into eligible_count
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id and room.active
  where task.id in (
    select distinct requested.id
    from unnest(target_task_ids) requested(id)
    where requested.id is not null
  )
    and task.active
    and task.bulk_completable
    and task.frequency not in ('monthly', 'extraordinary')
    and task.period_months is null
    and task.activity_type not in ('windows', 'deep_clean', 'laundry', 'disinfect');

  if eligible_count <> requested_count then
    raise exception 'Výběr obsahuje speciální nebo neaktivní úkol. Ten je nutné potvrdit samostatně.';
  end if;

  for current_task_id in
    with recursive selected as (
      select task.id, task.requires_task_id, task.sort_order
      from public.cleaning_tasks task
      where task.id in (
        select distinct requested.id
        from unnest(target_task_ids) requested(id)
        where requested.id is not null
      )
    ), ordered as (
      select selected.id, selected.requires_task_id, selected.sort_order, 0 as depth
      from selected
      where selected.requires_task_id is null
         or not exists (select 1 from selected prerequisite where prerequisite.id = selected.requires_task_id)
      union all
      select child.id, child.requires_task_id, child.sort_order, parent.depth + 1
      from selected child
      join ordered parent on parent.id = child.requires_task_id
    )
    select ordered.id
    from ordered
    order by ordered.depth, ordered.sort_order, ordered.id
  loop
    perform public.set_cleaning_task_completion(current_task_id, target_completion_date, true);
    processed_count := processed_count + 1;
    completed_task_id := current_task_id;
    return next;
  end loop;

  if processed_count <> requested_count then
    raise exception 'Vybrané úkoly mají neplatnou kruhovou závislost.';
  end if;
end;
$$;

revoke all on function public.get_cleaning_completion_status(date) from public, anon;
grant execute on function public.get_cleaning_completion_status(date) to authenticated;
revoke all on function public.complete_cleaning_tasks_bulk(uuid[], date) from public, anon;
grant execute on function public.complete_cleaning_tasks_bulk(uuid[], date) to authenticated;

do $$
begin
  if exists (
    select 1 from public.cleaning_tasks task
    where task.bulk_completable
      and (
        task.room_id is null
        or task.frequency in ('monthly', 'extraordinary')
        or task.period_months is not null
        or task.activity_type in ('windows', 'deep_clean', 'laundry', 'disinfect')
      )
  ) then
    raise exception 'Speciální úkol byl omylem povolen pro rychlé dokončení.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.cleaning_completions'::regclass) then
    raise exception 'RLS na cleaning_completions musí zůstat zapnuté.';
  end if;
end $$;

commit;
