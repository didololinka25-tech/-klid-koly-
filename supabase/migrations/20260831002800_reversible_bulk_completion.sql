-- Auditované a bezpečně vratné hromadné dokončení po jednotlivých místnostech.

begin;

create table if not exists public.cleaning_bulk_completion_actions (
  id uuid primary key default gen_random_uuid(),
  completion_date date not null,
  room_id uuid not null references public.rooms(id) on delete restrict,
  worker_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.profiles(id) on delete restrict,
  constraint cleaning_bulk_action_undo_complete check (
    (undone_at is null and undone_by is null)
    or (undone_at is not null and undone_by is not null)
  )
);

create table if not exists public.cleaning_bulk_completion_items (
  action_id uuid not null references public.cleaning_bulk_completion_actions(id) on delete restrict,
  task_id uuid not null references public.cleaning_tasks(id) on delete restrict,
  completed_at timestamptz not null,
  primary key (action_id, task_id)
);

create index if not exists cleaning_bulk_actions_date_room_idx
  on public.cleaning_bulk_completion_actions(completion_date, room_id, created_at desc);
create index if not exists cleaning_bulk_items_task_idx
  on public.cleaning_bulk_completion_items(task_id);

alter table public.cleaning_bulk_completion_actions enable row level security;
alter table public.cleaning_bulk_completion_items enable row level security;

drop policy if exists "approved users read bulk completion actions" on public.cleaning_bulk_completion_actions;
create policy "approved users read bulk completion actions"
on public.cleaning_bulk_completion_actions for select to authenticated
using (public.can_view_school_data());

drop policy if exists "approved users read bulk completion items" on public.cleaning_bulk_completion_items;
create policy "approved users read bulk completion items"
on public.cleaning_bulk_completion_items for select to authenticated
using (public.can_view_school_data());

revoke all on public.cleaning_bulk_completion_actions from anon, authenticated;
revoke all on public.cleaning_bulk_completion_items from anon, authenticated;
grant select on public.cleaning_bulk_completion_actions to authenticated;
grant select on public.cleaning_bulk_completion_items to authenticated;

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
  actor_id uuid := auth.uid();
  requested_count integer;
  eligible_count integer;
  processed_count integer := 0;
  current_row record;
  current_room_id uuid;
  current_action_id uuid;
  completion_before public.cleaning_completions%rowtype;
  completion_after public.cleaning_completions%rowtype;
begin
  if actor_id is null or not public.can_work_in_app() then
    raise exception 'K dokončování úkolů nemáte oprávnění.';
  end if;
  if target_completion_date is distinct from public.app_current_date() then
    raise exception 'Hromadně lze uložit pouze skutečný dnešní úklid.';
  end if;

  select count(distinct requested.id) into requested_count
  from unnest(coalesce(target_task_ids, array[]::uuid[])) requested(id)
  where requested.id is not null;
  if requested_count = 0 then return; end if;

  select count(*) into eligible_count
  from public.cleaning_tasks task
  join public.rooms room on room.id = task.room_id and room.active
  where task.id in (select distinct requested.id from unnest(target_task_ids) requested(id) where requested.id is not null)
    and task.active and task.bulk_completable
    and task.frequency not in ('monthly', 'extraordinary')
    and task.period_months is null
    and task.activity_type not in ('windows', 'deep_clean', 'laundry', 'disinfect');
  if eligible_count <> requested_count then
    raise exception 'Výběr obsahuje speciální nebo neaktivní úkol. Ten je nutné potvrdit samostatně.';
  end if;

  for current_row in
    with recursive selected as (
      select task.id, task.room_id, task.requires_task_id, task.sort_order
      from public.cleaning_tasks task
      where task.id in (select distinct requested.id from unnest(target_task_ids) requested(id) where requested.id is not null)
    ), ordered as (
      select selected.id, selected.room_id, selected.requires_task_id, selected.sort_order, 0 as depth
      from selected
      where selected.requires_task_id is null
         or not exists (select 1 from selected prerequisite where prerequisite.id = selected.requires_task_id)
      union all
      select child.id, child.room_id, child.requires_task_id, child.sort_order, parent.depth + 1
      from selected child join ordered parent on parent.id = child.requires_task_id
    )
    select ordered.id, ordered.room_id
    from ordered
    order by ordered.room_id, ordered.depth, ordered.sort_order, ordered.id
  loop
    processed_count := processed_count + 1;
    if current_room_id is distinct from current_row.room_id then
      current_room_id := current_row.room_id;
      current_action_id := null;
    end if;

    select completion.* into completion_before
    from public.cleaning_completions completion
    where completion.completion_date = target_completion_date and completion.task_id = current_row.id
    for update;

    if not found or not completion_before.completed then
      if current_action_id is null then
        insert into public.cleaning_bulk_completion_actions(completion_date, room_id, worker_id)
        values (target_completion_date, current_room_id, actor_id)
        returning id into current_action_id;
      end if;

      perform public.set_cleaning_task_completion(current_row.id, target_completion_date, true);
      select completion.* into strict completion_after
      from public.cleaning_completions completion
      where completion.completion_date = target_completion_date and completion.task_id = current_row.id;

      insert into public.cleaning_bulk_completion_items(action_id, task_id, completed_at)
      values (current_action_id, current_row.id, completion_after.completed_at);
    end if;

    completed_task_id := current_row.id;
    return next;
  end loop;

  if processed_count <> requested_count then
    raise exception 'Vybrané úkoly mají neplatnou kruhovou závislost.';
  end if;
end;
$$;

create or replace function public.get_cleaning_bulk_actions(target_date date)
returns table(
  action_id uuid,
  room_id uuid,
  worker_id uuid,
  worker_name text,
  created_at timestamptz,
  task_ids uuid[],
  can_undo boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select action.id,
         action.room_id,
         action.worker_id,
         profile.full_name,
         action.created_at,
         array_agg(item.task_id order by item.task_id),
         (action.worker_id = auth.uid() or public.is_admin())
  from public.cleaning_bulk_completion_actions action
  join public.cleaning_bulk_completion_items item on item.action_id = action.id
  join public.cleaning_completions completion
    on completion.completion_date = action.completion_date
   and completion.task_id = item.task_id
   and completion.completed
   and completion.worker_id = action.worker_id
   and completion.completed_at = item.completed_at
  join public.profiles profile on profile.id = action.worker_id
  where auth.uid() is not null
    and public.can_view_school_data()
    and action.completion_date = target_date
    and action.undone_at is null
    and not exists (
      select 1
      from public.cleaning_bulk_completion_items expected
      left join public.cleaning_completions actual
        on actual.completion_date = action.completion_date
       and actual.task_id = expected.task_id
       and actual.completed
       and actual.worker_id = action.worker_id
       and actual.completed_at = expected.completed_at
      where expected.action_id = action.id and actual.id is null
    )
  group by action.id, action.room_id, action.worker_id, profile.full_name, action.created_at;
$$;

create or replace function public.undo_cleaning_tasks_bulk(target_action_id uuid)
returns table(reverted_task_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  target_action public.cleaning_bulk_completion_actions%rowtype;
  current_item record;
  current_completion public.cleaning_completions%rowtype;
begin
  if actor_id is null or not public.can_work_in_app() then
    raise exception 'K vrácení dokončení nemáte oprávnění.';
  end if;

  select action.* into target_action
  from public.cleaning_bulk_completion_actions action
  where action.id = target_action_id
  for update;
  if not found then raise exception 'Hromadné dokončení nebylo nalezeno.'; end if;
  if target_action.undone_at is not null then return; end if;
  if target_action.completion_date <> public.app_current_date() then
    raise exception 'Běžně lze vrátit pouze dnešní hromadné dokončení.';
  end if;
  if target_action.worker_id <> actor_id and not public.is_admin() then
    raise exception 'Cizí hromadné dokončení může vrátit pouze administrátor.';
  end if;

  for current_item in
    with recursive action_tasks as (
      select task.id, task.requires_task_id, item.completed_at
      from public.cleaning_bulk_completion_items item
      join public.cleaning_tasks task on task.id = item.task_id
      where item.action_id = target_action.id
    ), ranked as (
      select action_tasks.id, action_tasks.requires_task_id, action_tasks.completed_at, 0 as depth
      from action_tasks
      where action_tasks.requires_task_id is null
         or not exists (select 1 from action_tasks prerequisite where prerequisite.id = action_tasks.requires_task_id)
      union all
      select child.id, child.requires_task_id, child.completed_at, parent.depth + 1
      from action_tasks child join ranked parent on parent.id = child.requires_task_id
    )
    select ranked.id, ranked.completed_at from ranked order by ranked.depth desc, ranked.id
  loop
    select completion.* into current_completion
    from public.cleaning_completions completion
    where completion.completion_date = target_action.completion_date
      and completion.task_id = current_item.id
    for update;
    if not found
       or not current_completion.completed
       or current_completion.worker_id <> target_action.worker_id
       or current_completion.completed_at is distinct from current_item.completed_at then
      raise exception 'Dokončení se mezitím změnilo. Obnovte obrazovku a zkontrolujte jednotlivé úkoly.';
    end if;

    perform public.set_cleaning_task_completion(current_item.id, target_action.completion_date, false);
    reverted_task_id := current_item.id;
    return next;
  end loop;

  update public.cleaning_bulk_completion_actions
  set undone_at = now(), undone_by = actor_id
  where id = target_action.id;
end;
$$;

-- Běžný pracovník může jednotlivě vrátit pouze vlastní dokončení; admin může opravit kohokoliv.
create or replace function public.set_cleaning_task_completion(
  target_task_id uuid,
  target_completion_date date,
  target_completed boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  current_completion public.cleaning_completions%rowtype;
  inserted_id uuid;
begin
  if actor_id is null or not public.can_work_in_app() then raise exception 'K dokončování úkolů nemáte oprávnění.'; end if;
  if target_task_id is null or target_completion_date is null or target_completed is null then raise exception 'Úkol, datum a stav dokončení jsou povinné.'; end if;
  if target_completion_date <> public.app_current_date() then raise exception 'Úkol lze běžně změnit pouze pro dnešní datum.'; end if;
  if not public.can_complete_task(target_task_id, target_completion_date) then raise exception 'Úkol není pro zvolené datum splatný nebo k němu nemáte oprávnění.'; end if;

  select completion.* into current_completion from public.cleaning_completions completion
  where completion.completion_date = target_completion_date and completion.task_id = target_task_id for update;
  if not found then
    if not target_completed then return; end if;
    insert into public.cleaning_completions(completion_date, task_id, worker_id, completed)
    values(target_completion_date, target_task_id, actor_id, true)
    on conflict(completion_date, task_id) do nothing returning id into inserted_id;
    if inserted_id is not null then return; end if;
    select completion.* into current_completion from public.cleaning_completions completion
    where completion.completion_date = target_completion_date and completion.task_id = target_task_id for update;
  end if;
  if target_completed then
    if current_completion.completed then return; end if;
    update public.cleaning_completions set completed=true, worker_id=actor_id, completed_at=null where id=current_completion.id;
    return;
  end if;
  if not current_completion.completed then return; end if;
  if current_completion.worker_id <> actor_id and not public.is_admin() then
    raise exception 'Cizí dokončení může vrátit pouze administrátor.';
  end if;
  if exists (
    select 1 from public.cleaning_tasks dependent_task
    join public.cleaning_completions dependent_completion on dependent_completion.task_id=dependent_task.id
      and dependent_completion.completion_date=target_completion_date and dependent_completion.completed
    where dependent_task.requires_task_id=target_task_id and dependent_task.active
  ) then raise exception 'Nejdříve vraťte na nehotovo navazující činnost.'; end if;
  update public.cleaning_completions set completed=false, completed_at=null where id=current_completion.id;
end;
$$;

revoke all on function public.get_cleaning_bulk_actions(date) from public, anon;
grant execute on function public.get_cleaning_bulk_actions(date) to authenticated;
revoke all on function public.undo_cleaning_tasks_bulk(uuid) from public, anon;
grant execute on function public.undo_cleaning_tasks_bulk(uuid) to authenticated;
revoke all on function public.complete_cleaning_tasks_bulk(uuid[], date) from public, anon;
grant execute on function public.complete_cleaning_tasks_bulk(uuid[], date) to authenticated;
revoke all on function public.set_cleaning_task_completion(uuid, date, boolean) from public, anon;
grant execute on function public.set_cleaning_task_completion(uuid, date, boolean) to authenticated;

do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.cleaning_bulk_completion_actions'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.cleaning_bulk_completion_items'::regclass) then
    raise exception 'RLS pro audit hromadného dokončení musí zůstat zapnuté.';
  end if;
  if has_table_privilege('authenticated', 'public.cleaning_bulk_completion_actions', 'INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.cleaning_bulk_completion_items', 'INSERT,UPDATE,DELETE') then
    raise exception 'Auditní tabulky nesmí být přímo zapisovatelné z klienta.';
  end if;
end $$;

commit;
