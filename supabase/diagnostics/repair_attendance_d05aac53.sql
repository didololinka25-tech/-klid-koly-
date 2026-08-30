-- Jednorázová oprava potvrzené směny. Nejprve aplikujte migraci 02200,
-- aby se i tato změna zapsala do neměnné historie auditu.
begin;

do $$
declare
  target_id constant uuid := 'd05aac53-d33f-4ba9-bb43-b91f128e586e';
  changed_count integer;
begin
  perform 1
  from public.attendance
  where id = target_id
  for update;

  if not found then
    raise exception 'Oprava zastavena: cílová směna nebyla nalezena.';
  end if;

  update public.attendance
  set
    started_at = timestamptz '2026-08-29 14:01:28 Europe/Prague',
    ended_at = timestamptz '2026-08-29 18:30:00 Europe/Prague'
  where id = target_id
    and attendance_date = date '2026-08-30'
    and started_at = timestamptz '2026-08-30 09:00:00 Europe/Prague'
    and ended_at = timestamptz '2026-08-30 12:06:00 Europe/Prague';

  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    raise exception 'Oprava zastavena: současné hodnoty cílové směny neodpovídají očekávání.';
  end if;

  -- Trigger z migrace 02100 odvodí attendance_date z nového started_at v Praze.
  if not exists (
    select 1
    from public.attendance
    where id = target_id
      and attendance_date = date '2026-08-29'
      and started_at = timestamptz '2026-08-29 14:01:28 Europe/Prague'
      and ended_at = timestamptz '2026-08-29 18:30:00 Europe/Prague'
  ) then
    raise exception 'Oprava zastavena: kontrola výsledných hodnot selhala.';
  end if;
end $$;

commit;
