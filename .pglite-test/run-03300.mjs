import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '00000000-0000-0000-0000-000000000001'

await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select '${admin}'::uuid $$;

  create table public.profiles (
    id uuid primary key default gen_random_uuid(), full_name text, active boolean not null default true,
    access_role text not null default 'cleaning_team'
  );
  create table public.buildings (
    id uuid primary key default gen_random_uuid(), name text not null, active boolean not null default true
  );
  create table public.floors (
    id uuid primary key default gen_random_uuid(), building_id uuid references public.buildings(id),
    name text not null, sort_order integer not null default 0
  );
  create table public.rooms (
    id uuid primary key default gen_random_uuid(), building_id uuid references public.buildings(id),
    floor_id uuid references public.floors(id), name text not null, sort_order integer not null default 0,
    active boolean not null default true
  );
  create table public.cleaning_tasks (
    id uuid primary key default gen_random_uuid(), room_id uuid references public.rooms(id),
    active boolean not null default true, plan_key text, activity_type text not null, frequency text not null,
    schedule_days smallint[], monthly_day smallint, period_months smallint, period_week smallint,
    period_anchor_month date, cleaning_cycle_length smallint, cleaning_cycle_offset smallint,
    sort_order integer not null default 0, requires_task_id uuid references public.cleaning_tasks(id)
  );
  create table public.cleaning_completions (
    task_id uuid references public.cleaning_tasks(id), completion_date date not null, completed boolean not null default true,
    worker_id uuid references public.profiles(id)
  );
  create table public.worker_work_assignments (
    id uuid primary key default gen_random_uuid(), worker_id uuid not null references public.profiles(id),
    building_id uuid references public.buildings(id), floor_id uuid references public.floors(id), area_label text not null,
    weekdays smallint[] not null default '{}', valid_from date not null, valid_to date, active boolean not null default true,
    created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id),
    updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id)
  );
  create table public.worker_schedule_exceptions (
    id uuid primary key default gen_random_uuid(), worker_id uuid not null references public.profiles(id),
    exception_date date not null, planned boolean not null, building_id uuid references public.buildings(id),
    floor_id uuid references public.floors(id), area_label text, note text not null default '', active boolean not null default true,
    created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id),
    updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id)
  );
  create table public.cleaning_day_exceptions (
    id uuid primary key default gen_random_uuid(), execution_date date, source_date date, status text,
    scope_type text, building_id uuid references public.buildings(id), kind text
  );

  create function public.can_view_school_data() returns boolean language sql stable as $$ select true $$;
  create function public.can_work_in_app() returns boolean language sql stable as $$ select true $$;
  create function public.is_admin() returns boolean language sql stable as $$ select true $$;
  create function public.app_current_date() returns date language sql stable as $$ select date '2026-09-02' $$;
  create function public.is_task_in_extraordinary_cleaning_day(uuid,uuid) returns boolean language sql stable as $$ select false $$;
  create function public.is_cleaning_task_scheduled_on(uuid,date) returns boolean language sql stable as $$ select false $$;

  insert into public.buildings(name) values('Škola'),('Školka');
  insert into public.floors(building_id,name,sort_order)
  select id,'1. patro',1 from public.buildings where name='Škola'
  union all select id,'Schodiště',5 from public.buildings where name='Škola'
  union all select id,'Prostory',1 from public.buildings where name='Školka';
  insert into public.rooms(building_id,floor_id,name,sort_order)
  select building.id,floor.id,'Vstup',1 from public.buildings building join public.floors floor on floor.building_id=building.id where building.name='Škola' and floor.name='1. patro'
  union all select building.id,floor.id,'Schodiště',1 from public.buildings building join public.floors floor on floor.building_id=building.id where building.name='Škola' and floor.name='Schodiště'
  union all select building.id,floor.id,'Místnost 1',1 from public.buildings building join public.floors floor on floor.building_id=building.id where building.name='Školka';

  insert into public.cleaning_tasks(room_id,plan_key,activity_type,frequency,schedule_days,period_months)
  select room.id,'v2026|1. patro|Vstup|windows','windows','monthly',array[5]::smallint[],1 from public.rooms room join public.buildings building on building.id=room.building_id where building.name='Škola' and room.name='Vstup'
  union all select room.id,'v2026|Schodiště|Schodiště|windows','windows','weekly',array[5]::smallint[],null from public.rooms room join public.buildings building on building.id=room.building_id where building.name='Škola' and room.name='Schodiště'
  union all select room.id,'v2026|postgres-integration','vacuum','weekly',array[1,3,5]::smallint[],null from public.rooms room join public.buildings building on building.id=room.building_id where building.name='Škola' and room.name='Schodiště'
  union all select room.id,'v2026-kindergarten|Místnost 1|windows','windows','weekly',array[2]::smallint[],null from public.rooms room join public.buildings building on building.id=room.building_id where building.name='Školka';

  insert into public.cleaning_tasks(room_id,plan_key,activity_type,frequency,schedule_days,period_months)
  values
    (null,'v2026|school|common|laundry','laundry','weekly',array[5]::smallint[],null),
    (null,'v2026|school|common|final-close-windows','windows','cleaning_day',array[1,3,5]::smallint[],null),
    (null,'v2026|school|common|final-laundry','laundry','cleaning_day',array[1,3,5]::smallint[],null);
  insert into public.profiles(id,full_name,access_role) values('${admin}','Didi Ceridwen','admin');
  insert into public.worker_work_assignments(worker_id,building_id,area_label,weekdays,valid_from,created_by,updated_by)
  select '${admin}',building.id,'1. patro',array[1,3,5]::smallint[],date '2026-01-01','${admin}','${admin}'
  from public.buildings building where building.name='Škola';
`)

const kindergartenBefore = await db.query(`select active,frequency,schedule_days,period_months from public.cleaning_tasks where plan_key='v2026-kindergarten|Místnost 1|windows'`)

const migration = readFileSync(new URL('../supabase/migrations/20260901003300_approved_school_year_plan_and_fourth_floor_rotation.sql', import.meta.url), 'utf8')
await db.exec(migration)
await db.query(`select * from public.get_dynamic_school_cleaning_plan(date '2026-09-01',date '2026-09-07')`)
await db.query(`select public.can_complete_task((select id from public.cleaning_tasks limit 1),date '2026-09-01')`)
await db.query(`select public.admin_set_cleaning_rotation_slot('school-fourth-floor',0::smallint,null::uuid,date '2026-09-04')`)
await db.query(`select public.get_worker_work_planning()`)
await db.exec(migration)
await db.query(`select * from public.get_dynamic_school_cleaning_plan(date '2026-09-01',date '2026-09-07')`)

const schoolWindows = await db.query(`select plan_key,period_months,schedule_days from public.cleaning_tasks where plan_key in ('v2026|1. patro|Vstup|windows','v2026|Schodiště|Schodiště|windows') order by plan_key`)
assert.equal(schoolWindows.rows.length,2)
for (const task of schoolWindows.rows) {
  assert.equal(task.period_months,3)
  assert.deepEqual(task.schedule_days,[1,2,3,4,5,6,7])
}
const commonTasks = await db.query(`select plan_key,active,frequency,period_months from public.cleaning_tasks where plan_key in ('v2026|school|common|laundry','v2026|school|common|final-close-windows','v2026|school|common|final-laundry') order by plan_key`)
assert.deepEqual(commonTasks.rows, [
  { plan_key:'v2026|school|common|final-close-windows',active:true,frequency:'cleaning_day',period_months:null },
  { plan_key:'v2026|school|common|final-laundry',active:true,frequency:'cleaning_day',period_months:null },
  { plan_key:'v2026|school|common|laundry',active:false,frequency:'weekly',period_months:null },
])
const kindergartenAfter = await db.query(`select active,frequency,schedule_days,period_months from public.cleaning_tasks where plan_key='v2026-kindergarten|Místnost 1|windows'`)
assert.deepEqual(kindergartenAfter.rows, kindergartenBefore.rows)

// Skutečný řetězec čisté DB po 03200: nejprve finální dynamická 03300, potom identity 03400.
const migration034 = readFileSync(new URL('../supabase/migrations/20260902003400_planning_workers_without_accounts.sql', import.meta.url), 'utf8')
await db.exec(migration034)
const didiPlanning = await db.query(`select id,linked_profile_id from public.planning_workers where linked_profile_id='${admin}'`)
assert.deepEqual(didiPlanning.rows,[{id:admin,linked_profile_id:admin}])
const worker2 = (await db.query(`select public.admin_save_planning_worker(null,'Pracovník 2',null,true) id`)).rows[0].id
await db.query(`select public.admin_save_planning_worker_work_assignment(null,'${worker2}',(select id from public.buildings where name='Škola'),null,'Škola',array[3]::smallint[],date '2026-01-01',null,true)`)
assert.equal((await db.query(`select public.school_worker_count_for_date(date '2026-09-02') count`)).rows[0].count,2)
await db.exec(migration034)
assert.equal((await db.query(`select count(*)::int count from public.planning_workers where linked_profile_id='${admin}'`)).rows[0].count,1)

const result = await db.query(`
  select
    to_regprocedure('public.refresh_dynamic_school_cleaning_plan(date,date)') is not null as refresh_exists,
    to_regprocedure('public.get_dynamic_school_cleaning_plan(date,date)') is not null as planner_exists,
    to_regprocedure('public.enforce_cleaning_rotation_slot_unambiguous()') is not null as trigger_exists
`)
const version = await db.query(`select version()`)
console.log(JSON.stringify({ ...result.rows[0], version: version.rows[0].version }))
await db.close()
