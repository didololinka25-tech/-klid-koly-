-- Neměnná historie změn pracovních dat a časů docházky.
begin;

create table if not exists public.attendance_audit (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null,
  old_attendance_date date not null,
  old_started_at timestamptz not null,
  old_ended_at timestamptz,
  new_attendance_date date not null,
  new_started_at timestamptz not null,
  new_ended_at timestamptz,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_by_name text not null,
  changed_at timestamptz not null default now(),
  change_kind text not null check (change_kind in ('clock_out', 'correction'))
);

create index if not exists attendance_audit_attendance_changed_idx
  on public.attendance_audit(attendance_id, changed_at desc);

alter table public.attendance_audit enable row level security;

drop policy if exists "admins read attendance audit" on public.attendance_audit;
create policy "admins read attendance audit"
on public.attendance_audit
for select
to authenticated
using (public.is_admin());

revoke all on public.attendance_audit from anon, authenticated;
grant select on public.attendance_audit to authenticated;

create or replace function public.record_attendance_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid;
  actor_name text;
  kind text;
begin
  if new.attendance_date is not distinct from old.attendance_date
     and new.started_at is not distinct from old.started_at
     and new.ended_at is not distinct from old.ended_at then
    return new;
  end if;

  actor_id := auth.uid();
  if actor_id is null then
    begin
      actor_id := nullif(current_setting('app.attendance_actor_id', true), '')::uuid;
    exception when invalid_text_representation then
      actor_id := null;
    end;
  end if;

  if actor_id is not null then
    select full_name into actor_name from public.profiles where id = actor_id;
  end if;
  actor_name := coalesce(actor_name, current_user);
  kind := case
    when old.ended_at is null
      and new.ended_at is not null
      and new.started_at is not distinct from old.started_at
      and new.attendance_date is not distinct from old.attendance_date
    then 'clock_out'
    else 'correction'
  end;

  insert into public.attendance_audit (
    attendance_id,
    old_attendance_date, old_started_at, old_ended_at,
    new_attendance_date, new_started_at, new_ended_at,
    changed_by, changed_by_name, changed_at, change_kind
  ) values (
    old.id,
    old.attendance_date, old.started_at, old.ended_at,
    new.attendance_date, new.started_at, new.ended_at,
    actor_id, actor_name, now(), kind
  );

  return new;
end;
$$;

revoke all on function public.record_attendance_audit() from public, anon, authenticated;

drop trigger if exists record_attendance_audit on public.attendance;
create trigger record_attendance_audit
after update of attendance_date, started_at, ended_at
on public.attendance
for each row execute procedure public.record_attendance_audit();

comment on table public.attendance_audit is
  'Neměnná historie původních a nových hodnot docházky. Zápisy vytváří pouze databázový trigger; aplikace je nemůže měnit ani mazat.';
comment on column public.attendance_audit.attendance_id is
  'Původní UUID směny je zachováno i při případném pozdějším odstranění směny.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.attendance'::regclass
      and tgname = 'record_attendance_audit'
      and not tgisinternal
  ) then
    raise exception 'Audit trigger docházky nebyl vytvořen.';
  end if;

  if has_table_privilege('authenticated', 'public.attendance_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.attendance_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.attendance_audit', 'DELETE') then
    raise exception 'Authenticated role nesmí měnit audit docházky.';
  end if;
end $$;

commit;
