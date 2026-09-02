import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '00000000-0000-0000-0000-000000000001'
const school = '00000000-0000-0000-0000-000000000010'
const floor = '00000000-0000-0000-0000-000000000020'

await db.exec(`
create role anon; create role authenticated; create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select '${admin}'::uuid $$;
create function public.is_admin() returns boolean language sql stable as $$ select true $$;
create function public.can_view_school_data() returns boolean language sql stable as $$ select true $$;
create function public.app_current_date() returns date language sql stable as $$ select date '2026-09-02' $$;
create function public.school_worker_count_for_date(target_date date) returns integer language sql stable as $$ select 2 $$;
create function public.school_rotating_floor_for_date(target_date date) returns text language sql stable as $$
 select case when (select count(*) from generate_series(date '2026-08-31',target_date,interval '1 day') generated(plan_day) where public.school_worker_count_for_date(generated.plan_day::date)=2)=2 then '2. patro' else '3. patro' end
$$;
create function public.get_dynamic_school_cleaning_plan(target_from date,target_to date)
returns table(task_id uuid,scheduled_date date,plan_reason text,due_from date,due_to date,assigned_worker_id uuid,planner_priority integer)
language sql stable as $$ select null::uuid,null::date,null::text,null::date,null::date,null::uuid,null::integer where false $$;
create table public.profiles(id uuid primary key,full_name text,active boolean not null default true,access_role text not null default 'cleaning_team');
create table public.buildings(id uuid primary key,name text not null,active boolean not null default true);
create table public.floors(id uuid primary key,building_id uuid references public.buildings(id),name text not null);
create table public.worker_work_assignments(
 id uuid primary key default gen_random_uuid(),worker_id uuid not null references public.profiles(id),building_id uuid not null references public.buildings(id),floor_id uuid references public.floors(id),area_label text not null,weekdays smallint[] not null,valid_from date not null,valid_to date,active boolean not null default true,created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id));
create table public.worker_schedule_exceptions(
 id uuid primary key default gen_random_uuid(),worker_id uuid not null references public.profiles(id),exception_date date not null,planned boolean not null,building_id uuid references public.buildings(id),floor_id uuid references public.floors(id),area_label text,note text not null default '',active boolean not null default true,created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id));
alter table public.worker_work_assignments enable row level security; alter table public.worker_schedule_exceptions enable row level security;
create table public.cleaning_rotation_definitions(rotation_key text primary key,title text not null,anchor_date date not null,weekday smallint,slot_count smallint not null,active boolean not null default true);
create table public.cleaning_rotation_slot_assignments(
 id uuid primary key default gen_random_uuid(),rotation_key text not null references public.cleaning_rotation_definitions(rotation_key),slot_index smallint not null,worker_id uuid references public.profiles(id),valid_from date not null,valid_to date,active boolean not null default true,created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id));
create table public.cleaning_planner_occurrences(id uuid primary key default gen_random_uuid(),task_id uuid not null,due_from date not null,due_to date not null,scheduled_for date,assigned_worker_id uuid references public.profiles(id),active boolean not null default true,updated_at timestamptz not null default now());
create table public.cleaning_completions(task_id uuid not null,completion_date date not null,completed boolean not null,worker_id uuid references public.profiles(id));
create function public.invalidate_future_dynamic_cleaning_plan() returns trigger language plpgsql as $$ begin return new; end $$;
insert into public.profiles values('${admin}','Didi Ceridwen',true,'admin');
insert into public.buildings values('${school}','Škola',true);
insert into public.floors values('${floor}','${school}','1. patro');
insert into public.worker_work_assignments(worker_id,building_id,floor_id,area_label,weekdays,valid_from,valid_to,created_by,updated_by)
values('${admin}','${school}','${floor}','1. patro',array[1,3,5]::smallint[],date '2026-08-28',date '2027-06-30','${admin}','${admin}');
insert into public.cleaning_rotation_definitions values('school-fourth-floor','4. patro',date '2026-09-04',null,3,true);
insert into public.cleaning_rotation_slot_assignments(rotation_key,slot_index,worker_id,valid_from,created_by,updated_by)
values('school-fourth-floor',0,'${admin}',date '2026-09-04','${admin}','${admin}');
insert into public.cleaning_completions values('00000000-0000-0000-0000-000000000099',date '2026-09-02',true,'${admin}');
`)

const migration = readFileSync(new URL('../supabase/migrations/20260902003400_planning_workers_without_accounts.sql', import.meta.url), 'utf8')
await db.exec(migration)

const didi = await db.query(`select id,linked_profile_id from public.planning_workers where linked_profile_id='${admin}'`)
assert.deepEqual(didi.rows,[{id:admin,linked_profile_id:admin}])
const assignment = await db.query(`select planning_worker_id,worker_id,weekdays,valid_from,valid_to from public.worker_work_assignments`)
assert.equal(assignment.rows[0].planning_worker_id,admin)
assert.equal(assignment.rows[0].worker_id,admin)
assert.deepEqual(assignment.rows[0].weekdays,[1,3,5])
assert.equal(assignment.rows[0].valid_from.toISOString().slice(0,10),'2026-08-28')
assert.equal(assignment.rows[0].valid_to.toISOString().slice(0,10),'2027-06-30')

const worker2 = (await db.query(`select public.admin_save_planning_worker(null,'Pracovník 2',null,true) id`)).rows[0].id
const worker3 = (await db.query(`select public.admin_save_planning_worker(null,'Pracovník 3',null,true) id`)).rows[0].id
await db.query(`select public.admin_save_planning_worker_work_assignment(null,'${worker2}','${school}',null,'Škola',array[3,5]::smallint[],date '2026-08-28',null,true)`)
await db.query(`select public.admin_save_planning_worker_work_assignment(null,'${worker3}','${school}',null,'Škola',array[1]::smallint[],date '2026-08-28',null,true)`)
assert.equal((await db.query(`select public.school_worker_count_for_date(date '2026-08-31') count`)).rows[0].count,2)
assert.equal((await db.query(`select public.school_worker_count_for_date(date '2026-09-02') count`)).rows[0].count,2)

const absence = (await db.query(`select public.admin_save_planning_worker_schedule_exception(null,'${worker2}',date '2026-09-02',false,null,null,null,'Volno',true) id`)).rows[0].id
assert.equal((await db.query(`select public.school_worker_count_for_date(date '2026-09-02') count`)).rows[0].count,1)
await db.query(`select public.admin_save_planning_worker_schedule_exception('${absence}','${worker2}',date '2026-09-02',false,null,null,null,'Volno',false)`)
await db.query(`select public.admin_save_planning_worker_schedule_exception(null,'${worker3}',date '2026-09-02',true,'${school}',null,'Škola','Mimořádná směna',true)`)
assert.equal((await db.query(`select public.school_worker_count_for_date(date '2026-09-02') count`)).rows[0].count,3)

assert.equal((await db.query(`select public.school_rotating_floor_for_date(date '2026-08-31') floor`)).rows[0].floor,'2. patro')
assert.equal((await db.query(`select public.school_rotating_floor_for_date(date '2026-09-02') floor`)).rows[0].floor,'2. patro')
assert.equal((await db.query(`select public.school_rotating_floor_for_date(date '2026-09-04') floor`)).rows[0].floor,'3. patro')
assert.equal((await db.query(`select public.school_rotating_floor_for_date(date '2026-09-07') floor`)).rows[0].floor,'2. patro')

await db.query(`select public.admin_set_cleaning_rotation_planning_worker_slot('school-fourth-floor',0::smallint,'${admin}',date '2026-09-04')`)
await db.query(`select public.admin_set_cleaning_rotation_planning_worker_slot('school-fourth-floor',1::smallint,'${worker2}',date '2026-09-04')`)
await db.query(`select public.admin_set_cleaning_rotation_planning_worker_slot('school-fourth-floor',2::smallint,'${worker3}',date '2026-09-04')`)
const payload = (await db.query(`select public.get_worker_work_planning() data`)).rows[0].data
assert.deepEqual(payload.rotation_slots.map((slot) => slot.worker_name),['Didi Ceridwen','Pracovník 2','Pracovník 3'])
assert.ok(payload.planning_workers.some((worker) => worker.display_name==='Pracovník 2' && worker.linked_profile_id===null))
assert.equal((await db.query(`select count(*)::int count from public.cleaning_completions where worker_id='${admin}'`)).rows[0].count,1)

await db.exec(migration)
assert.equal((await db.query(`select count(*)::int count from public.planning_workers where linked_profile_id='${admin}'`)).rows[0].count,1)
assert.equal((await db.query(`select count(*)::int count from public.worker_work_assignments where planning_worker_id='${admin}'`)).rows[0].count,1)
console.log('03400 PostgreSQL/PGlite integration: OK')
