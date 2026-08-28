-- Nedestruktivní podpora plánovaného tempa DPP a auditu oprav docházky.
alter table public.profiles
  add column if not exists planned_shifts_per_week smallint not null default 3;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_planned_shifts_per_week_valid'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_planned_shifts_per_week_valid
      check (planned_shifts_per_week between 1 and 7);
  end if;
end $$;

alter table public.attendance
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references public.profiles(id) on delete set null;

create or replace function public.audit_attendance_correction()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- První běžné ukončení otevřené směny není oprava. Pozdější změna ano.
  if new.started_at is distinct from old.started_at
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
    new.edited_at := now();
    new.edited_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists audit_attendance_correction on public.attendance;
create trigger audit_attendance_correction
before update of started_at, ended_at on public.attendance
for each row execute procedure public.audit_attendance_correction();

create or replace function public.set_own_planned_shifts_per_week(value smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if value not between 1 and 7 then
    raise exception 'Počet směn týdně musí být mezi 1 a 7.';
  end if;
  update public.profiles
  set planned_shifts_per_week = value
  where id = auth.uid() and active;
end;
$$;

revoke all on function public.set_own_planned_shifts_per_week(smallint) from public;
grant execute on function public.set_own_planned_shifts_per_week(smallint) to authenticated;

comment on column public.profiles.planned_shifts_per_week is
  'Orientační počet směn týdně pro rovnoměrné rozpočítání zbývajícího fondu DPP; nejde o zákonný týdenní limit.';
comment on column public.attendance.edited_at is
  'Čas poslední ruční opravy začátku nebo již uloženého konce směny.';
comment on column public.attendance.edited_by is
  'Uživatel, který provedl poslední ruční opravu směny.';
