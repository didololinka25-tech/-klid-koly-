-- Školní akce jako čistě informační vrstva Kalendáře.
-- Události nijak nemění planner, pracovníky, cleaning_tasks ani completions.
begin;

create table if not exists public.school_calendar_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  title text not null,
  note text,
  starts_on date not null,
  ends_on date not null,
  building_id uuid references public.buildings(id) on delete restrict,
  source text not null default 'school-information',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  constraint school_calendar_events_key_present check (length(btrim(event_key)) > 0),
  constraint school_calendar_events_title_present check (length(btrim(title)) > 0),
  constraint school_calendar_events_date_order check (ends_on >= starts_on),
  constraint school_calendar_events_source_valid check (source = 'school-information')
);

create index if not exists school_calendar_events_active_range_idx
  on public.school_calendar_events(starts_on, ends_on)
  where active;

comment on table public.school_calendar_events is
  'Read-only informační školní akce. Samy nikdy nemění úklidový plán.';
comment on column public.school_calendar_events.ends_on is
  'Poslední kalendářní den události včetně.';

alter table public.school_calendar_events enable row level security;

drop policy if exists "approved users read school calendar events" on public.school_calendar_events;
create policy "approved users read school calendar events"
  on public.school_calendar_events
  for select
  to authenticated
  using (public.can_view_school_data() and (active or public.is_admin()));

revoke all privileges on table public.school_calendar_events from public, anon, authenticated;
grant select on table public.school_calendar_events to authenticated;

with school as (
  select building.id
  from public.buildings building
  where building.name = 'Škola'
    and building.active
  order by building.id
  limit 1
), events(event_key, title, note, starts_on, ends_on) as (
  values
    ('school-year-2026-27:first-day', 'První školní den', null, date '2026-09-01', date '2026-09-01'),
    ('school-year-2026-27:adaptation-course', 'Adaptační kurz', null, date '2026-09-04', date '2026-09-06'),
    ('school-year-2026-27:parents-cafe-2026-10', 'Rodičovská kavárna', null, date '2026-10-13', date '2026-10-13'),
    ('school-year-2026-27:open-day', 'Den otevřených dveří', null, date '2026-10-20', date '2026-10-20'),
    ('school-year-2026-27:autumn-holidays', 'Podzimní prázdniny', null, date '2026-10-29', date '2026-10-30'),
    ('school-year-2026-27:tripartite-2026-11', 'Tripartity', 'Pouze informace. Běžný úklid se automaticky nemění.', date '2026-11-09', date '2026-11-27'),
    ('school-year-2026-27:parents-cafe-2026-11', 'Rodičovská kavárna', null, date '2026-11-12', date '2026-11-12'),
    ('school-year-2026-27:headteacher-day-2026-11', 'Ředitelské volno', null, date '2026-11-16', date '2026-11-16'),
    ('school-year-2026-27:nvc-course', 'Kurz nenásilné komunikace', null, date '2026-12-05', date '2026-12-06'),
    ('school-year-2026-27:christmas-party', 'Vánoční večírek', null, date '2026-12-15', date '2026-12-15'),
    ('school-year-2026-27:headteacher-days-2026-12', 'Ředitelské volno', null, date '2026-12-21', date '2026-12-22'),
    ('school-year-2026-27:christmas-holidays', 'Vánoční prázdniny', null, date '2026-12-23', date '2027-01-03'),
    ('school-year-2026-27:first-day-2027', 'První školní den v novém roce', null, date '2027-01-04', date '2027-01-04'),
    ('school-year-2026-27:parents-cafe-2027-01', 'Rodičovská kavárna', null, date '2027-01-14', date '2027-01-14'),
    ('school-year-2026-27:first-term-end', 'Konec 1. pololetí / vysvědčení', null, date '2027-01-28', date '2027-01-28'),
    ('school-year-2026-27:half-year-holiday', 'Pololetní prázdniny', null, date '2027-01-29', date '2027-01-29'),
    ('school-year-2026-27:ski-course', 'Lyžařský výcvik', 'Běžný provoz školy pokračuje. Událost je pouze informace.', date '2027-02-08', date '2027-02-13'),
    ('school-year-2026-27:tripartite-2027-02', 'Pololetní tripartity', 'Pouze informace. Běžný úklid se automaticky nemění.', date '2027-02-22', date '2027-02-28'),
    ('school-year-2026-27:spring-holidays', 'Jarní prázdniny', null, date '2027-02-22', date '2027-02-28'),
    ('school-year-2026-27:parents-cafe-2027-03', 'Rodičovská kavárna', null, date '2027-03-09', date '2027-03-09'),
    ('school-year-2026-27:easter-holiday', 'Velikonoční prázdniny', null, date '2027-03-25', date '2027-03-25'),
    ('school-year-2026-27:good-friday', 'Velký pátek', null, date '2027-03-26', date '2027-03-26'),
    ('school-year-2026-27:easter-monday', 'Velikonoční pondělí', null, date '2027-03-29', date '2027-03-29'),
    ('school-year-2026-27:tripartite-2027-04', 'Tripartity', 'Pouze informace. Běžný úklid se automaticky nemění.', date '2027-04-05', date '2027-04-23'),
    ('school-year-2026-27:parents-cafe-2027-04', 'Rodičovská kavárna', null, date '2027-04-15', date '2027-04-15'),
    ('school-year-2026-27:headteacher-day-2027-04', 'Ředitelské volno', null, date '2027-04-30', date '2027-04-30'),
    ('school-year-2026-27:parents-cafe-2027-05', 'Rodičovská kavárna', null, date '2027-05-11', date '2027-05-11'),
    ('school-year-2026-27:outdoor-school', 'Škola v přírodě Heroltice', 'Není běžný provoz školy. Úklid se automaticky neruší.', date '2027-06-07', date '2027-06-11'),
    ('school-year-2026-27:end-of-year-celebration', 'Slavnost ke konci školního roku', null, date '2027-06-29', date '2027-06-29'),
    ('school-year-2026-27:headteacher-day-2027-06', 'Ředitelské volno', null, date '2027-06-30', date '2027-06-30')
)
insert into public.school_calendar_events(
  event_key, title, note, starts_on, ends_on, building_id, source, active
)
select events.event_key, events.title, events.note, events.starts_on, events.ends_on,
       school.id, 'school-information', true
from events
cross join school
on conflict (event_key) do update set
  title = excluded.title,
  note = excluded.note,
  starts_on = excluded.starts_on,
  ends_on = excluded.ends_on,
  building_id = excluded.building_id,
  source = excluded.source,
  active = true,
  updated_at = now();

do $$
declare
  expected_keys constant text[] := array[
    'school-year-2026-27:first-day','school-year-2026-27:adaptation-course',
    'school-year-2026-27:parents-cafe-2026-10','school-year-2026-27:open-day',
    'school-year-2026-27:autumn-holidays','school-year-2026-27:tripartite-2026-11',
    'school-year-2026-27:parents-cafe-2026-11','school-year-2026-27:headteacher-day-2026-11',
    'school-year-2026-27:nvc-course','school-year-2026-27:christmas-party',
    'school-year-2026-27:headteacher-days-2026-12','school-year-2026-27:christmas-holidays',
    'school-year-2026-27:first-day-2027','school-year-2026-27:parents-cafe-2027-01',
    'school-year-2026-27:first-term-end','school-year-2026-27:half-year-holiday',
    'school-year-2026-27:ski-course','school-year-2026-27:tripartite-2027-02',
    'school-year-2026-27:spring-holidays','school-year-2026-27:parents-cafe-2027-03',
    'school-year-2026-27:easter-holiday','school-year-2026-27:good-friday',
    'school-year-2026-27:easter-monday','school-year-2026-27:tripartite-2027-04',
    'school-year-2026-27:parents-cafe-2027-04','school-year-2026-27:headteacher-day-2027-04',
    'school-year-2026-27:parents-cafe-2027-05','school-year-2026-27:outdoor-school',
    'school-year-2026-27:end-of-year-celebration','school-year-2026-27:headteacher-day-2027-06'
  ];
begin
  if not (select relrowsecurity from pg_class where oid = 'public.school_calendar_events'::regclass) then
    raise exception 'RLS na school_calendar_events musí být zapnuté.';
  end if;
  if (select count(*) from public.school_calendar_events where active and event_key = any(expected_keys)) <> cardinality(expected_keys) then
    raise exception 'Nebyl uložen celý potvrzený seznam školních akcí.';
  end if;
  if exists (
    select 1 from public.school_calendar_events event
    where event.event_key = any(expected_keys)
      and (event.building_id is null or event.ends_on < event.starts_on or event.source <> 'school-information')
  ) then
    raise exception 'Školní akce nemají platný rozsah, zdroj nebo pracoviště.';
  end if;
  -- has_table_privilege pro anon zahrnuje i oprávnění zděděná z PUBLIC.
  if has_table_privilege('anon', 'public.school_calendar_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'Anon/PUBLIC nesmí mít přístup ke školním akcím.';
  end if;
  if not has_table_privilege('authenticated', 'public.school_calendar_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.school_calendar_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'Authenticated smí školní akce pouze číst.';
  end if;
end
$$;

commit;
