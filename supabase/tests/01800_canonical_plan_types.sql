-- Regresní SQL kontrakt pro PostgreSQL chybu 42804 v canonical_plan.
-- Spouští se proti testovací/lokální PostgreSQL databázi, nikdy proti produkci.
begin;

do $$
declare
  actual_types text[];
begin
  with canonical_plan(
    floor_name, room_name, task_code, task_name, activity_type, frequency,
    schedule_days, sort_order, period_months, period_week,
    period_anchor_month, requires_code
  ) as (
    select
      null::text, null::text, null::text, null::text, null::text, null::text,
      null::smallint[], null::integer, null::smallint, null::smallint,
      null::date, null::text
    where false

    union all

    select
      floor_name::text, room_name::text, task_code::text, task_name::text,
      activity_type::text, frequency::text, schedule_days::smallint[],
      sort_order::integer, period_months::smallint, period_week::smallint,
      period_anchor_month::date, requires_code::text
    from (values
      ('1. patro', 'Vstup', 'vacuum', 'Vysát',
       'vacuum', 'cleaning_day', '{1,3,5}',
       10, null, null, null, null),
      ('1. patro', 'Vstup', 'windows', 'Umýt okna',
       'windows', 'monthly', '{1,3,5}', 20, 1, 2, '2026-09-01', null)
    ) seed(
      floor_name, room_name, task_code, task_name, activity_type, frequency,
      schedule_days, sort_order, period_months, period_week,
      period_anchor_month, requires_code
    )

    union all

    select
      '2. patro'::text, room_name::text, task_code::text, task_name::text,
      activity_type::text, frequency::text, schedule_days::smallint[],
      sort_order::integer, period_months::smallint, period_week::smallint,
      period_anchor_month::date, requires_code::text
    from (values ('Učebna 1'), ('Učebna 2')) rooms(room_name)
    cross join (values
      ('vacuum', 'Vysát', 'vacuum', 'cleaning_day', '{1,3,5}'::smallint[],
       10, null::smallint, null::smallint, null::date, null::text),
      ('mop', 'Vytřít', 'mop', 'cleaning_day', '{1,3,5}',
       20, null, null, null, 'vacuum')
    ) tasks(
      task_code, task_name, activity_type, frequency, schedule_days,
      sort_order, period_months, period_week, period_anchor_month, requires_code
    )
  )
  select array[
    pg_typeof(floor_name)::text,
    pg_typeof(room_name)::text,
    pg_typeof(task_code)::text,
    pg_typeof(task_name)::text,
    pg_typeof(activity_type)::text,
    pg_typeof(frequency)::text,
    pg_typeof(schedule_days)::text,
    pg_typeof(sort_order)::text,
    pg_typeof(period_months)::text,
    pg_typeof(period_week)::text,
    pg_typeof(period_anchor_month)::text,
    pg_typeof(requires_code)::text
  ]
  into actual_types
  from canonical_plan
  limit 1;

  if actual_types is distinct from array[
    'text', 'text', 'text', 'text', 'text', 'text',
    'smallint[]', 'integer', 'smallint', 'smallint', 'date', 'text'
  ] then
    raise exception 'canonical_plan má neočekávané typy: %', actual_types;
  end if;
end;
$$;

rollback;
