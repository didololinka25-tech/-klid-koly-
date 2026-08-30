-- POUZE ČTECÍ diagnostika. Dotaz nic nemění ani nemaže.
-- Spusťte celý blok v Supabase SQL Editoru a zkontrolujte UUID obou řádků.
select
  a.id,
  a.worker_id,
  p.full_name,
  p.email,
  a.attendance_date,
  a.started_at,
  a.ended_at,
  a.started_at at time zone 'Europe/Prague' as started_at_prague,
  a.ended_at at time zone 'Europe/Prague' as ended_at_prague,
  (a.started_at at time zone 'Europe/Prague')::date as date_from_start_prague,
  a.attendance_date <> (a.started_at at time zone 'Europe/Prague')::date as date_mismatch,
  a.created_at,
  a.edited_at,
  a.edited_by,
  a.building_id,
  b.name as building_name,
  case when a.ended_at is null then null
       else round(extract(epoch from (a.ended_at - a.started_at)) / 60)::integer
  end as worked_minutes
from public.attendance a
join public.profiles p on p.id = a.worker_id
join public.buildings b on b.id = a.building_id
where p.full_name = 'Didi Ceridwen'
  and (
    a.attendance_date between date '2026-08-29' and date '2026-08-30'
    or (a.started_at at time zone 'Europe/Prague')::date between date '2026-08-29' and date '2026-08-30'
  )
order by a.started_at, a.created_at, a.id;
