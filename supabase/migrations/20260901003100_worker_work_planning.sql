begin;

create table if not exists public.worker_work_assignments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete restrict,
  building_id uuid not null references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  area_label text not null,
  weekdays smallint[] not null,
  valid_from date not null,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  constraint worker_work_assignments_area_valid check (char_length(btrim(area_label)) between 1 and 120),
  constraint worker_work_assignments_weekdays_valid check (
    cardinality(weekdays) between 1 and 7
    and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
  ),
  constraint worker_work_assignments_dates_valid check (valid_to is null or valid_to >= valid_from)
);

create table if not exists public.worker_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete restrict,
  exception_date date not null,
  planned boolean not null,
  building_id uuid references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  area_label text,
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  constraint worker_schedule_exceptions_area_valid check (
    area_label is null or char_length(btrim(area_label)) between 1 and 120
  ),
  constraint worker_schedule_exceptions_planned_scope check (
    not planned or building_id is not null
  )
);

create index if not exists worker_work_assignments_calendar_idx
  on public.worker_work_assignments(active, valid_from, valid_to, worker_id);
create index if not exists worker_schedule_exceptions_calendar_idx
  on public.worker_schedule_exceptions(active, exception_date, worker_id);
create unique index if not exists worker_schedule_exceptions_one_active_day_idx
  on public.worker_schedule_exceptions(worker_id, exception_date)
  where active;

create or replace function public.enforce_worker_work_assignment_unambiguous()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.active then return new; end if;
  -- Serializuje souběžné zápisy stejného pracovníka; samotná trigger kontrola tak nemá race condition.
  perform pg_advisory_xact_lock(hashtextextended(new.worker_id::text, 3100));
  if exists (
    select 1
    from public.worker_work_assignments existing
    where existing.worker_id = new.worker_id
      and existing.active
      and existing.id <> new.id
      and existing.weekdays && new.weekdays
      and daterange(existing.valid_from, coalesce(existing.valid_to, 'infinity'::date), '[]')
          && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Pracovní období se překrývá s existujícím rozdělením.' using errcode = '23505';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_worker_schedule_exception_unambiguous()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.worker_id::text || '|' || new.exception_date::text, 3101));
  if exists (
    select 1
    from public.worker_schedule_exceptions existing
    where existing.worker_id = new.worker_id
      and existing.exception_date = new.exception_date
      and existing.active
      and existing.id <> new.id
  ) then
    raise exception 'Pro pracovníka už je na tento den uložená aktivní výjimka.' using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_worker_work_assignment_unambiguous() from public;
revoke all on function public.enforce_worker_schedule_exception_unambiguous() from public;

drop trigger if exists worker_work_assignments_unambiguous on public.worker_work_assignments;
create trigger worker_work_assignments_unambiguous
  before insert or update of worker_id, weekdays, valid_from, valid_to, active
  on public.worker_work_assignments
  for each row execute function public.enforce_worker_work_assignment_unambiguous();

drop trigger if exists worker_schedule_exceptions_unambiguous on public.worker_schedule_exceptions;
create trigger worker_schedule_exceptions_unambiguous
  before insert or update of worker_id, exception_date, active
  on public.worker_schedule_exceptions
  for each row execute function public.enforce_worker_schedule_exception_unambiguous();

alter table public.worker_work_assignments enable row level security;
alter table public.worker_schedule_exceptions enable row level security;

drop policy if exists "approved users read worker planning" on public.worker_work_assignments;
create policy "approved users read worker planning" on public.worker_work_assignments
  for select to authenticated using (public.can_view_school_data());
drop policy if exists "admins manage worker planning" on public.worker_work_assignments;
create policy "admins manage worker planning" on public.worker_work_assignments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "approved users read worker exceptions" on public.worker_schedule_exceptions;
create policy "approved users read worker exceptions" on public.worker_schedule_exceptions
  for select to authenticated using (public.can_view_school_data());
drop policy if exists "admins manage worker exceptions" on public.worker_schedule_exceptions;
create policy "admins manage worker exceptions" on public.worker_schedule_exceptions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on public.worker_work_assignments, public.worker_schedule_exceptions to authenticated;
revoke insert, update, delete on public.worker_work_assignments, public.worker_schedule_exceptions from anon, authenticated;

create or replace function public.get_worker_work_planning()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.can_view_school_data() then
    raise exception 'Nemáte oprávnění zobrazit pracovní rozdělení.';
  end if;
  return jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'worker_id', assignment.worker_id,
        'worker_name', coalesce(nullif(btrim(profile.full_name), ''), 'Pracovník'),
        'building_id', assignment.building_id,
        'building_name', building.name,
        'floor_id', assignment.floor_id,
        'floor_name', floor.name,
        'area_label', assignment.area_label,
        'weekdays', assignment.weekdays,
        'valid_from', assignment.valid_from,
        'valid_to', assignment.valid_to,
        'active', assignment.active
      ) order by profile.full_name, assignment.valid_from, assignment.area_label)
      from public.worker_work_assignments assignment
      join public.profiles profile on profile.id = assignment.worker_id
      join public.buildings building on building.id = assignment.building_id
      left join public.floors floor on floor.id = assignment.floor_id
    ), '[]'::jsonb),
    'exceptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', exception.id,
        'worker_id', exception.worker_id,
        'worker_name', coalesce(nullif(btrim(profile.full_name), ''), 'Pracovník'),
        'exception_date', exception.exception_date,
        'planned', exception.planned,
        'building_id', exception.building_id,
        'building_name', building.name,
        'floor_id', exception.floor_id,
        'floor_name', floor.name,
        'area_label', exception.area_label,
        'note', exception.note,
        'active', exception.active
      ) order by exception.exception_date, profile.full_name)
      from public.worker_schedule_exceptions exception
      join public.profiles profile on profile.id = exception.worker_id
      left join public.buildings building on building.id = exception.building_id
      left join public.floors floor on floor.id = exception.floor_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_worker_work_planning() from public;
grant execute on function public.get_worker_work_planning() to authenticated;

create or replace function public.admin_save_worker_work_assignment(
  target_id uuid,
  target_worker_id uuid,
  target_building_id uuid,
  target_floor_id uuid,
  target_area_label text,
  target_weekdays smallint[],
  target_valid_from date,
  target_valid_to date,
  target_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid := coalesce(target_id, gen_random_uuid());
begin
  if not public.is_admin() then raise exception 'Pracovní rozdělení může měnit pouze správce.'; end if;
  if not exists (select 1 from public.profiles where id = target_worker_id and active and access_role in ('cleaning_team','admin')) then
    raise exception 'Vybraný pracovník není aktivní člen úklidového týmu.';
  end if;
  if not exists (select 1 from public.buildings where id = target_building_id and active) then raise exception 'Pracoviště není aktivní.'; end if;
  if target_floor_id is not null and not exists (select 1 from public.floors where id = target_floor_id and building_id = target_building_id) then
    raise exception 'Vybrané patro nepatří do pracoviště.';
  end if;
  if char_length(btrim(coalesce(target_area_label,''))) not between 1 and 120 then raise exception 'Vyplňte oblast práce.'; end if;
  if cardinality(target_weekdays) not between 1 and 7 or not target_weekdays <@ array[1,2,3,4,5,6,7]::smallint[] then raise exception 'Vyberte platné pracovní dny.'; end if;
  if target_valid_to is not null and target_valid_to < target_valid_from then raise exception 'Konec platnosti nesmí být před začátkem.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_worker_id::text, 3100));
  if target_active and exists (
    select 1 from public.worker_work_assignments existing
    where existing.worker_id = target_worker_id
      and existing.active
      and existing.id <> saved_id
      and existing.weekdays && target_weekdays
      and daterange(existing.valid_from, coalesce(existing.valid_to, 'infinity'::date), '[]')
          && daterange(target_valid_from, coalesce(target_valid_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Pracovní období se překrývá s existujícím rozdělením.' using errcode = '23505';
  end if;
  insert into public.worker_work_assignments(id,worker_id,building_id,floor_id,area_label,weekdays,valid_from,valid_to,active,created_by,updated_by)
  values(saved_id,target_worker_id,target_building_id,target_floor_id,btrim(target_area_label),target_weekdays,target_valid_from,target_valid_to,target_active,auth.uid(),auth.uid())
  on conflict(id) do update set worker_id=excluded.worker_id, building_id=excluded.building_id, floor_id=excluded.floor_id,
    area_label=excluded.area_label, weekdays=excluded.weekdays, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
    active=excluded.active, updated_at=now(), updated_by=auth.uid();
  return saved_id;
end;
$$;

create or replace function public.admin_save_worker_schedule_exception(
  target_id uuid,
  target_worker_id uuid,
  target_exception_date date,
  target_planned boolean,
  target_building_id uuid,
  target_floor_id uuid,
  target_area_label text,
  target_note text,
  target_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid := coalesce(target_id, gen_random_uuid());
begin
  if not public.is_admin() then raise exception 'Výjimky rozvrhu může měnit pouze správce.'; end if;
  if not exists (select 1 from public.profiles where id = target_worker_id and active and access_role in ('cleaning_team','admin')) then raise exception 'Vybraný pracovník není aktivní.'; end if;
  if target_planned and not exists (select 1 from public.buildings where id = target_building_id and active) then raise exception 'Pro mimořádnou směnu vyberte aktivní pracoviště.'; end if;
  if target_floor_id is not null and not exists (select 1 from public.floors where id = target_floor_id and building_id = target_building_id) then raise exception 'Vybrané patro nepatří do pracoviště.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_worker_id::text || '|' || target_exception_date::text, 3101));
  if target_active and exists (
    select 1 from public.worker_schedule_exceptions existing
    where existing.worker_id = target_worker_id
      and existing.exception_date = target_exception_date
      and existing.active
      and existing.id <> saved_id
  ) then
    raise exception 'Pro pracovníka už je na tento den uložená aktivní výjimka.' using errcode = '23505';
  end if;
  insert into public.worker_schedule_exceptions(id,worker_id,exception_date,planned,building_id,floor_id,area_label,note,active,created_by,updated_by)
  values(saved_id,target_worker_id,target_exception_date,target_planned,case when target_planned then target_building_id end,case when target_planned then target_floor_id end,
    case when target_planned then nullif(btrim(coalesce(target_area_label,'')),'') end,btrim(coalesce(target_note,'')),target_active,auth.uid(),auth.uid())
  on conflict(id) do update set worker_id=excluded.worker_id, exception_date=excluded.exception_date, planned=excluded.planned,
    building_id=excluded.building_id, floor_id=excluded.floor_id, area_label=excluded.area_label, note=excluded.note,
    active=excluded.active, updated_at=now(), updated_by=auth.uid();
  return saved_id;
end;
$$;

revoke all on function public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean) from public;
grant execute on function public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean) to authenticated;
revoke all on function public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean) from public;
grant execute on function public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean) to authenticated;

do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.worker_work_assignments'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.worker_schedule_exceptions'::regclass) then
    raise exception 'RLS pracovního rozdělení musí zůstat zapnuté.';
  end if;
  if has_table_privilege('authenticated','public.worker_work_assignments','INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated','public.worker_schedule_exceptions','INSERT,UPDATE,DELETE') then
    raise exception 'Přímý klientský zápis pracovního rozdělení nesmí být povolen.';
  end if;
  if to_regprocedure('public.get_worker_work_planning()') is null
     or to_regprocedure('public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)') is null
     or to_regprocedure('public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)') is null then
    raise exception 'RPC pracovního rozdělení nebyla vytvořena.';
  end if;
  if not exists (
    select 1
    from pg_class index_class
    join pg_index index_definition on index_definition.indexrelid = index_class.oid
    where index_class.oid = to_regclass('public.worker_schedule_exceptions_one_active_day_idx')
      and index_definition.indisunique
      and index_definition.indpred is not null
  ) then
    raise exception 'Chybí DB ochrana jediné aktivní výjimky pracovníka pro den.';
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.worker_work_assignments'::regclass
      and tgname = 'worker_work_assignments_unambiguous' and not tgisinternal and tgenabled <> 'D'
  ) or not exists (
    select 1 from pg_trigger where tgrelid = 'public.worker_schedule_exceptions'::regclass
      and tgname = 'worker_schedule_exceptions_unambiguous' and not tgisinternal and tgenabled <> 'D'
  ) then
    raise exception 'Chybí trigger ochrana proti nejednoznačnému pracovnímu plánu.';
  end if;
  if exists (
    select 1
    from public.worker_work_assignments first_assignment
    join public.worker_work_assignments second_assignment
      on second_assignment.worker_id = first_assignment.worker_id
     and second_assignment.id > first_assignment.id
     and second_assignment.active and first_assignment.active
     and second_assignment.weekdays && first_assignment.weekdays
     and daterange(second_assignment.valid_from, coalesce(second_assignment.valid_to, 'infinity'::date), '[]')
         && daterange(first_assignment.valid_from, coalesce(first_assignment.valid_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Pracovní rozdělení obsahuje překrývající se aktivní období.';
  end if;
  if exists (
    select 1 from public.worker_schedule_exceptions
    where active group by worker_id, exception_date having count(*) > 1
  ) then
    raise exception 'Pracovní rozvrh obsahuje více aktivních výjimek pro stejný den.';
  end if;
end $$;

commit;
