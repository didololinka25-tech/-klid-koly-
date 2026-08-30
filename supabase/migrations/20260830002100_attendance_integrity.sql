-- Ochrana pracovního data a překrývajících se směn bez změny historie.
begin;

create or replace function public.enforce_attendance_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Serializuje souběžné zápisy téhož pracovníka (např. dva telefony).
  perform pg_advisory_xact_lock(hashtextextended(new.worker_id::text, 2100));

  if new.ended_at is not null and new.ended_at < new.started_at then
    raise exception using errcode = '22007', message = 'Odchod nesmí být před příchodem.';
  end if;

  -- Jediným zdrojem pracovního data je okamžik příchodu v českém časovém pásmu.
  new.attendance_date := (new.started_at at time zone 'Europe/Prague')::date;

  if exists (
    select 1
    from public.attendance existing
    where existing.worker_id = new.worker_id
      and existing.id <> new.id
      and tstzrange(existing.started_at, coalesce(existing.ended_at, 'infinity'::timestamptz), '[)')
          && tstzrange(new.started_at, coalesce(new.ended_at, 'infinity'::timestamptz), '[)')
  ) then
    raise exception using
      errcode = '23P01',
      message = 'Směna se překrývá s jinou evidovanou směnou tohoto pracovníka.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_attendance_integrity on public.attendance;
create trigger enforce_attendance_integrity
before insert or update of worker_id, started_at, ended_at
on public.attendance
for each row execute procedure public.enforce_attendance_integrity();

comment on function public.enforce_attendance_integrity() is
  'Odvozuje attendance_date z started_at v Europe/Prague a brání překrývajícím se směnám. Existující historii nemění.';

commit;
