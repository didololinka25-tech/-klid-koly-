-- Plánovací osoby nezávislé na Auth/profile; completion identita zůstává auth.uid().
begin;

-- 03400 je záměrně druhý krok. Nejdříve musí být celá finální dynamická 03300.
do $$ begin
  if to_regclass('public.cleaning_rotation_slot_assignments') is null
     or to_regclass('public.cleaning_planner_occurrences') is null
     or to_regprocedure('public.get_dynamic_school_cleaning_plan(date,date)') is null
     or to_regprocedure('public.school_rotating_floor_for_date(date)') is null then
    raise exception 'Nejprve spusťte celou migraci 03300 dynamického planneru.';
  end if;
  if position(')=2' in regexp_replace(pg_get_functiondef('public.school_rotating_floor_for_date(date)'::regprocedure),'\s+','','g'))=0 then
    raise exception '03300 neobsahuje finální rotaci posouvanou pouze dvoučlennými směnami.';
  end if;
end $$;

create table if not exists public.planning_workers (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  linked_profile_id uuid references public.profiles(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  constraint planning_workers_name_valid check (char_length(btrim(display_name)) between 1 and 120)
);
create unique index if not exists planning_workers_one_active_profile_idx
  on public.planning_workers(linked_profile_id) where active and linked_profile_id is not null;

-- Pro existující profily používáme stejné UUID planning entity. Žádný profil ani assignment se neduplikuje.
insert into public.planning_workers(id,display_name,linked_profile_id,active,created_by,updated_by)
select profile.id,coalesce(nullif(btrim(profile.full_name),''),'Pracovník'),profile.id,true,profile.id,profile.id
from public.profiles profile
where exists(select 1 from public.worker_work_assignments assignment where assignment.worker_id=profile.id)
   or exists(select 1 from public.worker_schedule_exceptions exception where exception.worker_id=profile.id)
   or exists(select 1 from public.cleaning_rotation_slot_assignments slot where slot.worker_id=profile.id)
on conflict(id) do nothing;

alter table public.worker_work_assignments add column if not exists planning_worker_id uuid;
alter table public.worker_schedule_exceptions add column if not exists planning_worker_id uuid;
alter table public.cleaning_rotation_slot_assignments add column if not exists planning_worker_id uuid;
update public.worker_work_assignments set planning_worker_id=worker_id where planning_worker_id is null;
update public.worker_schedule_exceptions set planning_worker_id=worker_id where planning_worker_id is null;
update public.cleaning_rotation_slot_assignments set planning_worker_id=worker_id where planning_worker_id is null and worker_id is not null;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='worker_work_assignments_planning_worker_fk') then
    alter table public.worker_work_assignments add constraint worker_work_assignments_planning_worker_fk foreign key(planning_worker_id) references public.planning_workers(id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conname='worker_schedule_exceptions_planning_worker_fk') then
    alter table public.worker_schedule_exceptions add constraint worker_schedule_exceptions_planning_worker_fk foreign key(planning_worker_id) references public.planning_workers(id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conname='cleaning_rotation_slots_planning_worker_fk') then
    alter table public.cleaning_rotation_slot_assignments add constraint cleaning_rotation_slots_planning_worker_fk foreign key(planning_worker_id) references public.planning_workers(id) on delete restrict;
  end if;
end $$;
alter table public.worker_work_assignments alter column planning_worker_id set not null;
alter table public.worker_schedule_exceptions alter column planning_worker_id set not null;
alter table public.worker_work_assignments alter column worker_id drop not null;
alter table public.worker_schedule_exceptions alter column worker_id drop not null;
create index if not exists worker_assignments_planning_calendar_idx on public.worker_work_assignments(active,valid_from,valid_to,planning_worker_id);
create index if not exists worker_exceptions_planning_calendar_idx on public.worker_schedule_exceptions(active,exception_date,planning_worker_id);
create unique index if not exists worker_exceptions_one_active_planning_day_idx on public.worker_schedule_exceptions(planning_worker_id,exception_date) where active;

create or replace function public.enforce_worker_work_assignment_unambiguous() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if not new.active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.planning_worker_id::text,3400));
  if exists(select 1 from public.worker_work_assignments existing
    where existing.planning_worker_id=new.planning_worker_id and existing.active and existing.id<>new.id
      and existing.weekdays&&new.weekdays
      and daterange(existing.valid_from,coalesce(existing.valid_to,'infinity'::date),'[]')&&daterange(new.valid_from,coalesce(new.valid_to,'infinity'::date),'[]'))
  then raise exception 'Pracovní období se překrývá s existujícím rozdělením.' using errcode='23505'; end if;
  return new;
end $$;
create or replace function public.enforce_worker_schedule_exception_unambiguous() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if not new.active then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.planning_worker_id::text||'|'||new.exception_date::text,3401));
  if exists(select 1 from public.worker_schedule_exceptions existing where existing.planning_worker_id=new.planning_worker_id
    and existing.exception_date=new.exception_date and existing.active and existing.id<>new.id)
  then raise exception 'Pro pracovníka už je na tento den uložená aktivní výjimka.' using errcode='23505'; end if;
  return new;
end $$;
drop trigger if exists worker_work_assignments_unambiguous on public.worker_work_assignments;
create trigger worker_work_assignments_unambiguous before insert or update of planning_worker_id,weekdays,valid_from,valid_to,active
on public.worker_work_assignments for each row execute function public.enforce_worker_work_assignment_unambiguous();
drop trigger if exists worker_schedule_exceptions_unambiguous on public.worker_schedule_exceptions;
create trigger worker_schedule_exceptions_unambiguous before insert or update of planning_worker_id,exception_date,active
on public.worker_schedule_exceptions for each row execute function public.enforce_worker_schedule_exception_unambiguous();

alter table public.planning_workers enable row level security;
drop policy if exists "approved users read planning workers" on public.planning_workers;
create policy "approved users read planning workers" on public.planning_workers for select to authenticated using(public.can_view_school_data());
revoke all on public.planning_workers from anon,authenticated;
grant select on public.planning_workers to authenticated;

create or replace function public.admin_save_planning_worker(target_id uuid,target_display_name text,target_linked_profile_id uuid,target_active boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare saved uuid:=coalesce(target_id,gen_random_uuid());
begin
  if not public.is_admin() then raise exception 'Pracovníky plánování může měnit pouze správce.'; end if;
  if char_length(btrim(coalesce(target_display_name,''))) not between 1 and 120 then raise exception 'Vyplňte jméno pracovníka.'; end if;
  if target_linked_profile_id is not null and not exists(select 1 from public.profiles where id=target_linked_profile_id and active and access_role in ('cleaning_team','admin','visitor')) then raise exception 'Vybraný uživatel aplikace není aktivní.'; end if;
  if target_active and target_linked_profile_id is not null and exists(select 1 from public.planning_workers where active and linked_profile_id=target_linked_profile_id and id<>saved) then raise exception 'Tento uživatel aplikace už je propojen s jiným pracovníkem.'; end if;
  insert into public.planning_workers(id,display_name,linked_profile_id,active,created_by,updated_by)
  values(saved,btrim(target_display_name),target_linked_profile_id,target_active,auth.uid(),auth.uid())
  on conflict(id) do update set display_name=excluded.display_name,linked_profile_id=excluded.linked_profile_id,active=excluded.active,updated_at=now(),updated_by=auth.uid();
  return saved;
end $$;

create or replace function public.admin_save_planning_worker_work_assignment(target_id uuid,target_planning_worker_id uuid,target_building_id uuid,target_floor_id uuid,target_area_label text,target_weekdays smallint[],target_valid_from date,target_valid_to date,target_active boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare saved uuid:=coalesce(target_id,gen_random_uuid()); linked uuid;
begin
  if not public.is_admin() then raise exception 'Pracovní rozdělení může měnit pouze správce.'; end if;
  select linked_profile_id into linked from public.planning_workers where id=target_planning_worker_id and active;
  if not found then raise exception 'Vybraný pracovník není aktivní.'; end if;
  if not exists(select 1 from public.buildings where id=target_building_id and active) then raise exception 'Pracoviště není aktivní.'; end if;
  if target_floor_id is not null and not exists(select 1 from public.floors where id=target_floor_id and building_id=target_building_id) then raise exception 'Vybrané patro nepatří do pracoviště.'; end if;
  if char_length(btrim(coalesce(target_area_label,''))) not between 1 and 120 then raise exception 'Vyplňte oblast práce.'; end if;
  if cardinality(target_weekdays) not between 1 and 7 or not target_weekdays<@array[1,2,3,4,5,6,7]::smallint[] then raise exception 'Vyberte platné pracovní dny.'; end if;
  if target_valid_to is not null and target_valid_to<target_valid_from then raise exception 'Konec platnosti nesmí být před začátkem.'; end if;
  insert into public.worker_work_assignments(id,worker_id,planning_worker_id,building_id,floor_id,area_label,weekdays,valid_from,valid_to,active,created_by,updated_by)
  values(saved,linked,target_planning_worker_id,target_building_id,target_floor_id,btrim(target_area_label),target_weekdays,target_valid_from,target_valid_to,target_active,auth.uid(),auth.uid())
  on conflict(id) do update set worker_id=excluded.worker_id,planning_worker_id=excluded.planning_worker_id,building_id=excluded.building_id,floor_id=excluded.floor_id,area_label=excluded.area_label,weekdays=excluded.weekdays,valid_from=excluded.valid_from,valid_to=excluded.valid_to,active=excluded.active,updated_at=now(),updated_by=auth.uid();
  return saved;
end $$;

create or replace function public.admin_save_planning_worker_schedule_exception(target_id uuid,target_planning_worker_id uuid,target_exception_date date,target_planned boolean,target_building_id uuid,target_floor_id uuid,target_area_label text,target_note text,target_active boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare saved uuid:=coalesce(target_id,gen_random_uuid()); linked uuid;
begin
  if not public.is_admin() then raise exception 'Výjimky rozvrhu může měnit pouze správce.'; end if;
  select linked_profile_id into linked from public.planning_workers where id=target_planning_worker_id and active;
  if not found then raise exception 'Vybraný pracovník není aktivní.'; end if;
  if target_planned and not exists(select 1 from public.buildings where id=target_building_id and active) then raise exception 'Pro mimořádnou směnu vyberte aktivní pracoviště.'; end if;
  if target_floor_id is not null and not exists(select 1 from public.floors where id=target_floor_id and building_id=target_building_id) then raise exception 'Vybrané patro nepatří do pracoviště.'; end if;
  insert into public.worker_schedule_exceptions(id,worker_id,planning_worker_id,exception_date,planned,building_id,floor_id,area_label,note,active,created_by,updated_by)
  values(saved,linked,target_planning_worker_id,target_exception_date,target_planned,case when target_planned then target_building_id end,case when target_planned then target_floor_id end,case when target_planned then nullif(btrim(coalesce(target_area_label,'')),'') end,btrim(coalesce(target_note,'')),target_active,auth.uid(),auth.uid())
  on conflict(id) do update set worker_id=excluded.worker_id,planning_worker_id=excluded.planning_worker_id,exception_date=excluded.exception_date,planned=excluded.planned,building_id=excluded.building_id,floor_id=excluded.floor_id,area_label=excluded.area_label,note=excluded.note,active=excluded.active,updated_at=now(),updated_by=auth.uid();
  return saved;
end $$;

create or replace function public.admin_set_cleaning_rotation_planning_worker_slot(target_rotation_key text,target_slot_index smallint,target_planning_worker_id uuid,target_effective_from date)
returns uuid language plpgsql security definer set search_path=public as $$
declare definition public.cleaning_rotation_definitions%rowtype; current_slot public.cleaning_rotation_slot_assignments%rowtype; next_from date; saved uuid; linked uuid;
begin
  if not public.is_admin() then raise exception 'Rotaci může měnit pouze správce.'; end if;
  select * into definition from public.cleaning_rotation_definitions where rotation_key=target_rotation_key and active;
  if not found or target_slot_index<0 or target_slot_index>=definition.slot_count then raise exception 'Neplatná rotační pozice.'; end if;
  if target_planning_worker_id is not null then select linked_profile_id into linked from public.planning_workers where id=target_planning_worker_id and active; if not found then raise exception 'Vybraný pracovník není aktivní.'; end if; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_rotation_key||'|'||target_slot_index::text,3300));
  select * into current_slot from public.cleaning_rotation_slot_assignments where rotation_key=target_rotation_key and slot_index=target_slot_index and active and valid_from<=target_effective_from and (valid_to is null or valid_to>=target_effective_from) order by valid_from desc limit 1 for update;
  if found and current_slot.valid_from=target_effective_from then update public.cleaning_rotation_slot_assignments set worker_id=linked,planning_worker_id=target_planning_worker_id,updated_at=now(),updated_by=auth.uid() where id=current_slot.id returning id into saved; return saved; end if;
  if found then update public.cleaning_rotation_slot_assignments set valid_to=target_effective_from-1,updated_at=now(),updated_by=auth.uid() where id=current_slot.id; end if;
  select min(valid_from) into next_from from public.cleaning_rotation_slot_assignments where rotation_key=target_rotation_key and slot_index=target_slot_index and active and valid_from>target_effective_from;
  insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,planning_worker_id,valid_from,valid_to,active,created_by,updated_by)
  values(target_rotation_key,target_slot_index,linked,target_planning_worker_id,target_effective_from,case when next_from is null then null else next_from-1 end,true,auth.uid(),auth.uid()) returning id into saved;
  return saved;
end $$;

-- Staré signatury zůstávají funkční pro klienta otevřeného během deploye. Profil se pouze přeloží
-- na jedinou aktivní plánovací osobu; nové záznamy již pracují s planning_worker_id.
create or replace function public.admin_save_worker_work_assignment(target_id uuid,target_worker_id uuid,target_building_id uuid,target_floor_id uuid,target_area_label text,target_weekdays smallint[],target_valid_from date,target_valid_to date,target_active boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare planning_id uuid;
begin
  select id into planning_id from public.planning_workers where linked_profile_id=target_worker_id and active order by id limit 1;
  if planning_id is null then raise exception 'Uživatel aplikace není propojen s plánovacím pracovníkem.'; end if;
  return public.admin_save_planning_worker_work_assignment(target_id,planning_id,target_building_id,target_floor_id,target_area_label,target_weekdays,target_valid_from,target_valid_to,target_active);
end $$;
create or replace function public.admin_save_worker_schedule_exception(target_id uuid,target_worker_id uuid,target_exception_date date,target_planned boolean,target_building_id uuid,target_floor_id uuid,target_area_label text,target_note text,target_active boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare planning_id uuid;
begin
  select id into planning_id from public.planning_workers where linked_profile_id=target_worker_id and active order by id limit 1;
  if planning_id is null then raise exception 'Uživatel aplikace není propojen s plánovacím pracovníkem.'; end if;
  return public.admin_save_planning_worker_schedule_exception(target_id,planning_id,target_exception_date,target_planned,target_building_id,target_floor_id,target_area_label,target_note,target_active);
end $$;
create or replace function public.admin_set_cleaning_rotation_slot(target_rotation_key text,target_slot_index smallint,target_worker_id uuid,target_effective_from date)
returns uuid language plpgsql security definer set search_path=public as $$
declare planning_id uuid;
begin
  if target_worker_id is not null then
    select id into planning_id from public.planning_workers where linked_profile_id=target_worker_id and active order by id limit 1;
    if planning_id is null then raise exception 'Uživatel aplikace není propojen s plánovacím pracovníkem.'; end if;
  end if;
  return public.admin_set_cleaning_rotation_planning_worker_slot(target_rotation_key,target_slot_index,planning_id,target_effective_from);
end $$;

-- Aktivace/deaktivace plánovací osoby mění počet lidí. Budoucí nedokončený plán proto musí být
-- přepočten stejně jako po změně období nebo výjimky; historie completion se nemění.
create or replace function public.invalidate_dynamic_plan_after_planning_worker_change() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.active is distinct from new.active then
    update public.cleaning_planner_occurrences occurrence
    set scheduled_for=null,assigned_worker_id=null,updated_at=now()
    where occurrence.active and occurrence.scheduled_for>=public.app_current_date()
      and not exists(select 1 from public.cleaning_completions completion where completion.task_id=occurrence.task_id
        and completion.completion_date=occurrence.scheduled_for and completion.completed);
  end if;
  return new;
end $$;
revoke all on function public.invalidate_dynamic_plan_after_planning_worker_change() from public,anon,authenticated;
drop trigger if exists planning_workers_invalidate_dynamic_plan on public.planning_workers;
create trigger planning_workers_invalidate_dynamic_plan after update of active on public.planning_workers
for each row execute function public.invalidate_dynamic_plan_after_planning_worker_change();

create or replace function public.school_worker_count_for_date(target_date date) returns integer
language sql security definer stable set search_path=public as $$
  with school as(select id from public.buildings where name='Škola' and active order by id limit 1),
  overridden as(select distinct planning_worker_id from public.worker_schedule_exceptions where active and exception_date=target_date),
  planned as(
    select assignment.planning_worker_id from public.worker_work_assignments assignment join public.planning_workers worker on worker.id=assignment.planning_worker_id and worker.active,school
    where assignment.active and assignment.building_id=school.id and target_date between assignment.valid_from and coalesce(assignment.valid_to,'infinity'::date)
      and extract(isodow from target_date)::smallint=any(assignment.weekdays) and not exists(select 1 from overridden where planning_worker_id=assignment.planning_worker_id)
    union select exception.planning_worker_id from public.worker_schedule_exceptions exception join public.planning_workers worker on worker.id=exception.planning_worker_id and worker.active,school
    where exception.active and exception.exception_date=target_date and exception.planned and exception.building_id=school.id)
  select count(distinct planning_worker_id)::integer from planned;
$$;

create or replace function public.school_rotating_floor_for_date(target_date date) returns text
language sql security definer stable set search_path=public as $$
  select case when ((select count(*) from generate_series(date '2026-08-31',target_date,interval '1 day') as generated_day(plan_timestamp)
    where public.school_worker_count_for_date(generated_day.plan_timestamp::date)=2)-1)%2=0 then '2. patro' else '3. patro' end;
$$;

create or replace function public.get_worker_work_planning() returns jsonb language plpgsql security definer stable set search_path=public as $$
begin
  if not public.can_view_school_data() then raise exception 'Nemáte oprávnění zobrazit pracovní rozdělení.'; end if;
  return jsonb_build_object(
    'planning_workers',coalesce((select jsonb_agg(jsonb_build_object('id',worker.id,'display_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'active',worker.active) order by worker.active desc,worker.display_name) from public.planning_workers worker),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',assignment.id,'worker_id',assignment.planning_worker_id,'worker_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'building_id',assignment.building_id,'building_name',building.name,'floor_id',assignment.floor_id,'floor_name',floor.name,'area_label',assignment.area_label,'weekdays',assignment.weekdays,'valid_from',assignment.valid_from,'valid_to',assignment.valid_to,'active',assignment.active) order by worker.display_name,assignment.valid_from) from public.worker_work_assignments assignment join public.planning_workers worker on worker.id=assignment.planning_worker_id join public.buildings building on building.id=assignment.building_id left join public.floors floor on floor.id=assignment.floor_id),'[]'::jsonb),
    'exceptions',coalesce((select jsonb_agg(jsonb_build_object('id',exception.id,'worker_id',exception.planning_worker_id,'worker_name',worker.display_name,'linked_profile_id',worker.linked_profile_id,'exception_date',exception.exception_date,'planned',exception.planned,'building_id',exception.building_id,'building_name',building.name,'floor_id',exception.floor_id,'floor_name',floor.name,'area_label',exception.area_label,'note',exception.note,'active',exception.active) order by exception.exception_date,worker.display_name) from public.worker_schedule_exceptions exception join public.planning_workers worker on worker.id=exception.planning_worker_id left join public.buildings building on building.id=exception.building_id left join public.floors floor on floor.id=exception.floor_id),'[]'::jsonb),
    'rotation_definitions',coalesce((select jsonb_agg(jsonb_build_object('rotation_key',definition.rotation_key,'title',definition.title,'anchor_date',definition.anchor_date,'weekday',definition.weekday,'slot_count',definition.slot_count,'active',definition.active)) from public.cleaning_rotation_definitions definition),'[]'::jsonb),
    'rotation_slots',coalesce((select jsonb_agg(jsonb_build_object('id',slot.id,'rotation_key',slot.rotation_key,'slot_index',slot.slot_index,'worker_id',slot.planning_worker_id,'worker_name',worker.display_name,'valid_from',slot.valid_from,'valid_to',slot.valid_to,'active',slot.active) order by slot.slot_index,slot.valid_from) from public.cleaning_rotation_slot_assignments slot left join public.planning_workers worker on worker.id=slot.planning_worker_id),'[]'::jsonb));
end $$;

revoke all on function public.admin_save_planning_worker(uuid,text,uuid,boolean),public.admin_save_planning_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean),public.admin_save_planning_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean),public.admin_set_cleaning_rotation_planning_worker_slot(text,smallint,uuid,date) from public,anon;
grant execute on function public.admin_save_planning_worker(uuid,text,uuid,boolean),public.admin_save_planning_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean),public.admin_save_planning_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean),public.admin_set_cleaning_rotation_planning_worker_slot(text,smallint,uuid,date) to authenticated;
revoke all on function public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean),public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean),public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) from public,anon;
grant execute on function public.admin_save_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean),public.admin_save_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean),public.admin_set_cleaning_rotation_slot(text,smallint,uuid,date) to authenticated;
revoke all on function public.school_worker_count_for_date(date),public.school_rotating_floor_for_date(date) from public,anon,authenticated;

do $$ begin
  if exists(select 1 from public.worker_work_assignments where planning_worker_id is null) or exists(select 1 from public.worker_schedule_exceptions where planning_worker_id is null) then raise exception 'Backfill plánovacích pracovníků není úplný.'; end if;
  if exists(select 1 from public.planning_workers where active and linked_profile_id is not null group by linked_profile_id having count(*)>1) then raise exception 'Profil je propojen s více aktivními plánovacími pracovníky.'; end if;
  if not (select relrowsecurity from pg_class where oid='public.planning_workers'::regclass) then raise exception 'RLS planning_workers musí být zapnuté.'; end if;
  if has_table_privilege('authenticated','public.planning_workers','INSERT,UPDATE,DELETE') then raise exception 'Přímý zápis planning_workers nesmí být povolen.'; end if;
  if to_regprocedure('public.admin_save_planning_worker(uuid,text,uuid,boolean)') is null or to_regprocedure('public.admin_save_planning_worker_work_assignment(uuid,uuid,uuid,uuid,text,smallint[],date,date,boolean)') is null or to_regprocedure('public.admin_save_planning_worker_schedule_exception(uuid,uuid,date,boolean,uuid,uuid,text,text,boolean)') is null or to_regprocedure('public.admin_set_cleaning_rotation_planning_worker_slot(text,smallint,uuid,date)') is null then raise exception 'Chybí RPC plánovacích pracovníků.'; end if;
end $$;

commit;
