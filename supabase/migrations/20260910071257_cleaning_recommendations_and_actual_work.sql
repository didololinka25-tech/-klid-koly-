-- Additive evidence-based cleaning workflow. Existing tasks/completions remain intact.
begin;

create table public.worker_cleaning_areas (
  id uuid primary key default gen_random_uuid(),
  planning_worker_id uuid not null references public.planning_workers(id) on delete restrict,
  building_id uuid not null references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  area_code text not null default 'main',
  title text not null,
  recommended_visits_per_week smallint not null default 1 check (recommended_visits_per_week between 1 and 7),
  rotation_mode text not null default 'history' check (rotation_mode in ('none','alternating_ab','history')),
  always_include_wc boolean not null default false,
  active boolean not null default true,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  check (length(btrim(title)) between 1 and 160),
  check (length(btrim(area_code)) between 1 and 80),
  check (valid_to is null or valid_to >= valid_from)
);
create unique index worker_cleaning_areas_active_scope_uq
  on public.worker_cleaning_areas(planning_worker_id,building_id,coalesce(floor_id,'00000000-0000-0000-0000-000000000000'::uuid),area_code)
  where active;
create index worker_cleaning_areas_worker_idx on public.worker_cleaning_areas(planning_worker_id,active,valid_from,valid_to);

create table public.worker_availability_changes (
  id uuid primary key default gen_random_uuid(),
  planning_worker_id uuid not null references public.planning_workers(id) on delete restrict,
  effective_date date not null,
  availability_status text not null check (availability_status in ('planned','absent','rescheduled','time_changed','partial','substitute')),
  alternate_date date,
  starts_at time,
  ends_at time,
  substitutes_for_planning_worker_id uuid references public.planning_workers(id) on delete restrict,
  source_schedule_exception_id uuid references public.worker_schedule_exceptions(id) on delete restrict,
  alternate_schedule_exception_id uuid references public.worker_schedule_exceptions(id) on delete restrict,
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (availability_status <> 'rescheduled' or alternate_date is not null),
  check (availability_status <> 'substitute' or substitutes_for_planning_worker_id is not null),
  check (planning_worker_id is distinct from substitutes_for_planning_worker_id)
);
create unique index worker_availability_one_active_day_uq
  on public.worker_availability_changes(planning_worker_id,effective_date) where active;
create index worker_availability_calendar_idx on public.worker_availability_changes(effective_date,active,planning_worker_id);

create table public.cleaning_actual_records (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  subject_planning_worker_id uuid references public.planning_workers(id) on delete restrict,
  subject_profile_id uuid references public.profiles(id) on delete restrict,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  building_id uuid not null references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  room_id uuid references public.rooms(id) on delete restrict,
  task_id uuid references public.cleaning_tasks(id) on delete restrict,
  category text not null check (category in ('routine','as_needed','detail','frequency')),
  outcome text not null check (outcome in ('completed','skipped')),
  skip_reason text check (skip_reason in ('occupied','no_time','not_needed','problem','unavailable','other')),
  label text not null,
  note text not null default '',
  occurred_at timestamptz not null default now(),
  legacy_completion_id uuid unique references public.cleaning_completions(id) on delete restrict,
  created_at timestamptz not null default now(),
  active boolean not null default true,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete restrict,
  void_reason text,
  check (subject_planning_worker_id is not null or subject_profile_id is not null),
  check (length(btrim(label)) between 1 and 240),
  check ((outcome='skipped' and skip_reason is not null) or (outcome='completed' and skip_reason is null))
);
create index cleaning_actual_room_history_idx on public.cleaning_actual_records(room_id,work_date desc) where active;
create index cleaning_actual_task_history_idx on public.cleaning_actual_records(task_id,work_date desc) where active;
create index cleaning_actual_worker_history_idx on public.cleaning_actual_records(subject_planning_worker_id,work_date desc) where active;
create index cleaning_actual_outcome_idx on public.cleaning_actual_records(outcome,work_date desc) where active;

-- Preserve room-based completion history in the new factual ledger without changing it.
-- Non-room final checks stay in the immutable legacy ledger; they are not cleaning evidence for a room.
insert into public.cleaning_actual_records(
  work_date,subject_planning_worker_id,subject_profile_id,recorded_by,
  building_id,floor_id,room_id,task_id,category,outcome,label,note,occurred_at,legacy_completion_id
)
select completion.completion_date,worker.id,completion.worker_id,completion.worker_id,
       room.building_id,room.floor_id,task.room_id,task.id,
       case when task.frequency in ('weekly','monthly') then 'frequency' else 'routine' end,
       'completed',task.name,'Převedeno z existující historie dokončení.',
       coalesce(completion.completed_at,completion.completion_date::timestamptz),completion.id
from public.cleaning_completions completion
join public.cleaning_tasks task on task.id=completion.task_id
join public.rooms room on room.id=task.room_id
left join public.planning_workers worker on worker.linked_profile_id=completion.worker_id and worker.active
where completion.completed
on conflict(legacy_completion_id) do nothing;

-- Existing current assignments become stable areas. UUID identity, not display names, is used.
insert into public.worker_cleaning_areas(
  planning_worker_id,building_id,floor_id,area_code,title,recommended_visits_per_week,
  rotation_mode,always_include_wc,valid_from,valid_to,created_by,updated_by
)
select assignment.planning_worker_id,assignment.building_id,assignment.floor_id,
       'main',assignment.area_label,cardinality(assignment.weekdays)::smallint,
       case when floor.name='2. patro' then 'alternating_ab' when floor.name in ('3. patro','4. patro') then 'history' else 'none' end,
       floor.name='2. patro',assignment.valid_from,assignment.valid_to,assignment.created_by,assignment.updated_by
from public.worker_work_assignments assignment
left join public.floors floor on floor.id=assignment.floor_id
where assignment.active and assignment.planning_worker_id is not null
on conflict do nothing;

alter table public.worker_cleaning_areas enable row level security;
alter table public.worker_availability_changes enable row level security;
alter table public.cleaning_actual_records enable row level security;

create policy "approved users read cleaning areas" on public.worker_cleaning_areas
  for select to authenticated using (public.can_view_school_data());
create policy "approved users read availability" on public.worker_availability_changes
  for select to authenticated using (public.can_view_school_data());
create policy "approved users read actual cleaning" on public.cleaning_actual_records
  for select to authenticated using (public.can_view_school_data());

revoke all on public.worker_cleaning_areas,public.worker_availability_changes,public.cleaning_actual_records from public,anon,authenticated;
grant select on public.worker_cleaning_areas,public.worker_availability_changes,public.cleaning_actual_records to authenticated;

create function public.admin_save_worker_cleaning_area(
  target_id uuid,target_planning_worker_id uuid,target_building_id uuid,target_floor_id uuid,
  target_area_code text,target_title text,target_visits smallint,target_rotation_mode text,
  target_always_include_wc boolean,target_valid_from date,target_valid_to date,target_active boolean
) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); saved uuid:=coalesce(target_id,gen_random_uuid());
begin
  if actor is null or not public.is_admin() then raise exception 'Stálé oblasti může měnit pouze správce.'; end if;
  if not exists(select 1 from public.planning_workers where id=target_planning_worker_id and active) then raise exception 'Pracovník není aktivní.'; end if;
  if not exists(select 1 from public.buildings where id=target_building_id and active) then raise exception 'Pracoviště není aktivní.'; end if;
  if target_floor_id is not null and not exists(select 1 from public.floors where id=target_floor_id and building_id=target_building_id) then raise exception 'Patro nepatří k pracovišti.'; end if;
  insert into public.worker_cleaning_areas(id,planning_worker_id,building_id,floor_id,area_code,title,recommended_visits_per_week,rotation_mode,always_include_wc,valid_from,valid_to,active,created_by,updated_by)
  values(saved,target_planning_worker_id,target_building_id,target_floor_id,btrim(target_area_code),btrim(target_title),target_visits,target_rotation_mode,target_always_include_wc,target_valid_from,target_valid_to,target_active,actor,actor)
  on conflict(id) do update set planning_worker_id=excluded.planning_worker_id,building_id=excluded.building_id,floor_id=excluded.floor_id,area_code=excluded.area_code,title=excluded.title,recommended_visits_per_week=excluded.recommended_visits_per_week,rotation_mode=excluded.rotation_mode,always_include_wc=excluded.always_include_wc,valid_from=excluded.valid_from,valid_to=excluded.valid_to,active=excluded.active,updated_at=now(),updated_by=actor;
  return saved;
end $$;

create function public.admin_save_worker_availability_change(
  target_id uuid,target_planning_worker_id uuid,target_date date,target_status text,target_alternate_date date,
  target_starts_at time,target_ends_at time,target_substitutes_for uuid,target_note text,target_active boolean
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); saved uuid:=coalesce(target_id,gen_random_uuid()); previous public.worker_availability_changes%rowtype;
  source_exception uuid; alternate_exception uuid; scope_worker uuid:=target_planning_worker_id;
  scope_building uuid; scope_floor uuid; scope_label text;
begin
  if actor is null or not public.is_admin() then raise exception 'Dostupnost pracovníků může měnit pouze správce.'; end if;
  if not exists(select 1 from public.planning_workers where id=target_planning_worker_id and active) then raise exception 'Pracovník není aktivní.'; end if;
  select * into previous from public.worker_availability_changes where id=saved for update;
  if found then
    if previous.source_schedule_exception_id is not null then
      perform public.admin_save_planning_worker_schedule_exception(
        previous.source_schedule_exception_id,
        case when previous.availability_status='substitute' then previous.substitutes_for_planning_worker_id else previous.planning_worker_id end,
        previous.effective_date,false,null,null,null,previous.note,false
      );
    end if;
    if previous.alternate_schedule_exception_id is not null then
      perform public.admin_save_planning_worker_schedule_exception(previous.alternate_schedule_exception_id,previous.planning_worker_id,coalesce(previous.alternate_date,previous.effective_date),true,
        (select building_id from public.worker_schedule_exceptions where id=previous.alternate_schedule_exception_id),
        (select floor_id from public.worker_schedule_exceptions where id=previous.alternate_schedule_exception_id),
        (select area_label from public.worker_schedule_exceptions where id=previous.alternate_schedule_exception_id),previous.note,false);
    end if;
  end if;

  if target_active and target_status in ('absent','rescheduled','substitute') then
    if target_status='substitute' then scope_worker:=target_substitutes_for; end if;
    select assignment.building_id,assignment.floor_id,assignment.area_label
      into scope_building,scope_floor,scope_label
    from public.worker_work_assignments assignment
    where assignment.planning_worker_id=scope_worker and assignment.active
      and target_date between assignment.valid_from and coalesce(assignment.valid_to,'infinity'::date)
      and extract(isodow from target_date)::smallint=any(assignment.weekdays)
    order by assignment.valid_from desc limit 1;
    if target_status='substitute' and scope_building is null then raise exception 'Zastupovaný pracovník nemá pro tento den pracovní oblast.'; end if;
    source_exception:=public.admin_save_planning_worker_schedule_exception(
      null,scope_worker,target_date,false,null,null,null,btrim(coalesce(target_note,'')),true);
  end if;
  if target_active and target_status in ('rescheduled','substitute') then
    if target_status='rescheduled' then
      select assignment.building_id,assignment.floor_id,assignment.area_label
        into scope_building,scope_floor,scope_label
      from public.worker_work_assignments assignment
      where assignment.planning_worker_id=target_planning_worker_id and assignment.active
        and target_date between assignment.valid_from and coalesce(assignment.valid_to,'infinity'::date)
      order by assignment.valid_from desc limit 1;
    end if;
    if scope_building is null then raise exception 'Pro přesunutou nebo náhradní směnu chybí pracovní oblast.'; end if;
    alternate_exception:=public.admin_save_planning_worker_schedule_exception(
      null,target_planning_worker_id,case when target_status='rescheduled' then target_alternate_date else target_date end,
      true,scope_building,scope_floor,scope_label,btrim(coalesce(target_note,'')),true);
  end if;

  insert into public.worker_availability_changes(id,planning_worker_id,effective_date,availability_status,alternate_date,starts_at,ends_at,substitutes_for_planning_worker_id,source_schedule_exception_id,alternate_schedule_exception_id,note,active,created_by,updated_by,cancelled_at,cancelled_by)
  values(saved,target_planning_worker_id,target_date,target_status,target_alternate_date,target_starts_at,target_ends_at,target_substitutes_for,source_exception,alternate_exception,btrim(coalesce(target_note,'')),target_active,actor,actor,case when target_active then null else now() end,case when target_active then null else actor end)
  on conflict(id) do update set planning_worker_id=excluded.planning_worker_id,effective_date=excluded.effective_date,availability_status=excluded.availability_status,alternate_date=excluded.alternate_date,starts_at=excluded.starts_at,ends_at=excluded.ends_at,substitutes_for_planning_worker_id=excluded.substitutes_for_planning_worker_id,source_schedule_exception_id=excluded.source_schedule_exception_id,alternate_schedule_exception_id=excluded.alternate_schedule_exception_id,note=excluded.note,active=excluded.active,updated_at=now(),updated_by=actor,cancelled_at=excluded.cancelled_at,cancelled_by=excluded.cancelled_by;
  return saved;
end $$;

create function public.save_cleaning_actual_batch(target_planning_worker_id uuid,target_work_date date,target_items jsonb)
returns uuid[] language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); linked uuid; item jsonb; saved_ids uuid[]:='{}'; saved uuid; b uuid; f uuid; r uuid; t uuid; cat text; result text; reason text; item_label text;
begin
  if actor is null or not public.can_work_in_app() then raise exception 'Nemáte oprávnění zapisovat úklid.'; end if;
  select linked_profile_id into linked from public.planning_workers where id=target_planning_worker_id and active;
  if not found then raise exception 'Pracovník není aktivní.'; end if;
  if not public.is_admin() and linked is distinct from actor then raise exception 'Můžete zapisovat pouze svoji práci.'; end if;
  if jsonb_typeof(target_items)<>'array' or jsonb_array_length(target_items) not between 1 and 100 then raise exception 'Vyberte 1 až 100 záznamů.'; end if;
  for item in select value from jsonb_array_elements(target_items) loop
    b:=nullif(item->>'building_id','')::uuid; f:=nullif(item->>'floor_id','')::uuid; r:=nullif(item->>'room_id','')::uuid; t:=nullif(item->>'task_id','')::uuid;
    cat:=item->>'category'; result:=item->>'outcome'; reason:=nullif(item->>'skip_reason',''); item_label:=btrim(coalesce(item->>'label',''));
    if b is null or not exists(select 1 from public.buildings where id=b) then raise exception 'Neplatné pracoviště.'; end if;
    if f is not null and not exists(select 1 from public.floors where id=f and building_id=b) then raise exception 'Neplatné patro.'; end if;
    if r is not null and not exists(select 1 from public.rooms where id=r and building_id=b and (f is null or floor_id=f)) then raise exception 'Neplatná místnost.'; end if;
    if t is not null and not exists(select 1 from public.cleaning_tasks where id=t and (r is null or room_id=r)) then raise exception 'Neplatný úkon.'; end if;
    if cat not in ('routine','as_needed','detail','frequency') or result not in ('completed','skipped') or length(item_label) not between 1 and 240 then raise exception 'Neplatný záznam úklidu.'; end if;
    if (result='skipped')<>(reason is not null) then raise exception 'U vynechané práce vyberte důvod.'; end if;
    saved:=gen_random_uuid();
    insert into public.cleaning_actual_records(id,work_date,subject_planning_worker_id,subject_profile_id,recorded_by,building_id,floor_id,room_id,task_id,category,outcome,skip_reason,label,note,occurred_at)
    values(saved,target_work_date,target_planning_worker_id,linked,actor,b,f,r,t,cat,result,reason,item_label,btrim(coalesce(item->>'note','')),coalesce(nullif(item->>'occurred_at','')::timestamptz,now()));
    saved_ids:=array_append(saved_ids,saved);
  end loop;
  return saved_ids;
end $$;

create function public.admin_void_cleaning_actual_record(target_id uuid,target_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Opravu historie může provést pouze správce.'; end if;
  update public.cleaning_actual_records set active=false,voided_at=now(),voided_by=auth.uid(),void_reason=btrim(target_reason)
  where id=target_id and active;
  if not found then raise exception 'Záznam nebyl nalezen nebo už byl opraven.'; end if;
end $$;

revoke all on function public.admin_save_worker_cleaning_area(uuid,uuid,uuid,uuid,text,text,smallint,text,boolean,date,date,boolean) from public,anon;
revoke all on function public.admin_save_worker_availability_change(uuid,uuid,date,text,date,time,time,uuid,text,boolean) from public,anon;
revoke all on function public.save_cleaning_actual_batch(uuid,date,jsonb) from public,anon;
revoke all on function public.admin_void_cleaning_actual_record(uuid,text) from public,anon;
grant execute on function public.admin_save_worker_cleaning_area(uuid,uuid,uuid,uuid,text,text,smallint,text,boolean,date,date,boolean) to authenticated;
grant execute on function public.admin_save_worker_availability_change(uuid,uuid,date,text,date,time,time,uuid,text,boolean) to authenticated;
grant execute on function public.save_cleaning_actual_batch(uuid,date,jsonb) to authenticated;
grant execute on function public.admin_void_cleaning_actual_record(uuid,text) to authenticated;

do $$ begin
  if exists(select 1 from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname in ('worker_cleaning_areas','worker_availability_changes','cleaning_actual_records') and not relrowsecurity) then raise exception 'RLS nového cleaning modelu musí být zapnuté.'; end if;
  if has_table_privilege('anon','public.cleaning_actual_records','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','public.cleaning_actual_records','INSERT,UPDATE,DELETE') then raise exception 'Skutečný úklid se smí zapisovat pouze auditovaným RPC.'; end if;
  if exists(
    select 1
    from public.cleaning_completions completion
    join public.cleaning_tasks task on task.id=completion.task_id and task.room_id is not null
    where completion.completed
      and not exists(select 1 from public.cleaning_actual_records actual where actual.legacy_completion_id=completion.id)
  ) then raise exception 'Historie dokončení místností nebyla úplně namapována.'; end if;
  if has_function_privilege('anon','public.save_cleaning_actual_batch(uuid,date,jsonb)','EXECUTE') then raise exception 'Anon nesmí zapisovat úklid.'; end if;
end $$;

commit;
