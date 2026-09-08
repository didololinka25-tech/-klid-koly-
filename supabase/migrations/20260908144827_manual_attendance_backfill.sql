-- Bezpečné zpětné doplnění uzavřené směny bez přepisování existující docházky.
begin;

alter table public.attendance
  add column if not exists entry_source text not null default 'clock',
  add column if not exists entry_created_by uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.attendance'::regclass
      and conname = 'attendance_entry_source_valid'
  ) then
    alter table public.attendance
      add constraint attendance_entry_source_valid
      check (entry_source in ('clock', 'manual_backfill'));
  end if;
end
$$;

comment on column public.attendance.entry_source is
  'clock = běžný příchod/odchod; manual_backfill = uzavřená směna doplněná zpětně.';
comment on column public.attendance.entry_created_by is
  'Skutečný přihlášený uživatel, který vytvořil ručně doplněnou směnu.';

-- Metadata původu záznamu jsou po vytvoření neměnná.
create or replace function public.protect_attendance_entry_origin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.entry_source is distinct from old.entry_source
     or new.entry_created_by is distinct from old.entry_created_by then
    raise exception using
      errcode = '42501',
      message = 'Původ záznamu docházky nelze změnit.';
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_attendance_entry_origin()
  from public, anon, authenticated;

drop trigger if exists protect_attendance_entry_origin on public.attendance;
create trigger protect_attendance_entry_origin
before update of entry_source, entry_created_by
on public.attendance
for each row execute procedure public.protect_attendance_entry_origin();

-- Stávající audit rozšíříme o vznik ručně doplněné směny. Historické řádky
-- zůstávají beze změny; pouze původní hodnoty nejsou pro creation event povinné.
alter table public.attendance_audit
  alter column old_attendance_date drop not null,
  alter column old_started_at drop not null;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.attendance_audit'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%change_kind%';

  if constraint_name is not null then
    execute format('alter table public.attendance_audit drop constraint %I', constraint_name);
  end if;

  alter table public.attendance_audit
    add constraint attendance_audit_change_kind_valid
    check (change_kind in ('manual_creation', 'clock_out', 'correction'));
end
$$;

create or replace function public.record_manual_attendance_creation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_name text;
begin
  if new.entry_source <> 'manual_backfill' then
    return new;
  end if;

  select profile.full_name
    into actor_name
  from public.profiles profile
  where profile.id = new.entry_created_by;

  insert into public.attendance_audit (
    attendance_id,
    old_attendance_date, old_started_at, old_ended_at,
    new_attendance_date, new_started_at, new_ended_at,
    changed_by, changed_by_name, changed_at, change_kind
  ) values (
    new.id,
    null, null, null,
    new.attendance_date, new.started_at, new.ended_at,
    new.entry_created_by, coalesce(actor_name, 'Neznámý uživatel'), now(), 'manual_creation'
  );

  return new;
end;
$$;

revoke execute on function public.record_manual_attendance_creation()
  from public, anon, authenticated;

drop trigger if exists record_manual_attendance_creation on public.attendance;
create trigger record_manual_attendance_creation
after insert on public.attendance
for each row execute procedure public.record_manual_attendance_creation();

-- Identita pracovníka se nepřebírá z formuláře bez kontroly: běžný uživatel
-- smí doplnit jen sebe, správce může vybrat jiného aktivního pracovníka.
create or replace function public.create_manual_attendance(
  target_worker_id uuid,
  target_building_id uuid,
  target_date date,
  target_started_time time without time zone,
  target_ended_time time without time zone,
  target_note text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  started_timestamp timestamptz;
  ended_timestamp timestamptz;
  normalized_note text := nullif(btrim(coalesce(target_note, '')), '');
  saved public.attendance;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Nejdřív se přihlaste.';
  end if;
  if not public.can_work_in_app() then
    raise exception using errcode = '42501', message = 'Nemáte oprávnění zapisovat docházku.';
  end if;
  if target_worker_id is null or (target_worker_id <> actor_id and not public.is_admin()) then
    raise exception using errcode = '42501', message = 'Můžete doplnit pouze svoji docházku.';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = target_worker_id
      and profile.active
      and profile.access_role in ('cleaning_team', 'admin')
  ) then
    raise exception using errcode = '22023', message = 'Vybraný pracovník není aktivní.';
  end if;
  if not exists (
    select 1 from public.buildings building
    where building.id = target_building_id and building.active
  ) then
    raise exception using errcode = '22023', message = 'Vyberte platné pracoviště.';
  end if;
  if target_date is null or target_date > (now() at time zone 'Europe/Prague')::date then
    raise exception using errcode = '22023', message = 'Zpětnou docházku nelze zadat do budoucna.';
  end if;
  if target_started_time is null or target_ended_time is null
     or target_ended_time <= target_started_time then
    raise exception using errcode = '22007', message = 'Odchod musí být po příchodu.';
  end if;
  if length(coalesce(normalized_note, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Poznámka může mít nejvýše 1000 znaků.';
  end if;

  started_timestamp := (target_date + target_started_time) at time zone 'Europe/Prague';
  ended_timestamp := (target_date + target_ended_time) at time zone 'Europe/Prague';

  insert into public.attendance (
    worker_id, building_id, attendance_date, started_at, ended_at, note,
    entry_source, entry_created_by
  ) values (
    target_worker_id, target_building_id, target_date,
    started_timestamp, ended_timestamp, normalized_note,
    'manual_backfill', actor_id
  )
  returning * into saved;

  return saved;
exception
  when exclusion_violation then
    raise exception using
      errcode = '23P01',
      message = 'Směna se překrývá s jinou evidovanou směnou tohoto pracovníka.';
end;
$$;

revoke execute on function public.create_manual_attendance(uuid,uuid,date,time without time zone,time without time zone,text)
  from public, anon;
grant execute on function public.create_manual_attendance(uuid,uuid,date,time without time zone,time without time zone,text)
  to authenticated;

-- Přímý INSERT zůstává zachovaný jen pro běžné tlačítko Příchod. Ručně
-- doplněný původ může vytvořit pouze výše uvedené omezené RPC.
drop policy if exists "team starts own attendance" on public.attendance;
create policy "team starts own attendance"
on public.attendance
for insert to authenticated
with check (
  public.can_work_in_app()
  and worker_id = auth.uid()
  and entry_source = 'clock'
  and entry_created_by is null
);

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.attendance'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.attendance_audit'::regclass) then
    raise exception 'RLS docházky a jejího auditu musí zůstat zapnuté.';
  end if;
  -- anon zahrnuje i oprávnění zděděná z PUBLIC, takže tato kontrola ověřuje obě cesty.
  if has_function_privilege('anon', 'public.create_manual_attendance(uuid,uuid,date,time without time zone,time without time zone,text)', 'EXECUTE') then
    raise exception 'Anonymní role nesmí ručně doplňovat docházku.';
  end if;
  if not has_function_privilege('authenticated', 'public.create_manual_attendance(uuid,uuid,date,time without time zone,time without time zone,text)', 'EXECUTE') then
    raise exception 'Authenticated role musí mít přístup k omezenému RPC docházky.';
  end if;
  if has_function_privilege('authenticated', 'public.record_manual_attendance_creation()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.protect_attendance_entry_origin()', 'EXECUTE') then
    raise exception 'Trigger funkce docházky nesmí být klientským API.';
  end if;
end
$$;

commit;
