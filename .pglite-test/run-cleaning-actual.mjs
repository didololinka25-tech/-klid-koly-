import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const id = {
  danaProfile: '00000000-0000-0000-0000-000000000001',
  adminProfile: '00000000-0000-0000-0000-000000000002',
  danaWorker: '10000000-0000-0000-0000-000000000001',
  martinaWorker: '10000000-0000-0000-0000-000000000002',
  school: '20000000-0000-0000-0000-000000000001',
  floor: '30000000-0000-0000-0000-000000000001',
  room: '40000000-0000-0000-0000-000000000001',
  task: '50000000-0000-0000-0000-000000000001',
  finalTask: '50000000-0000-0000-0000-000000000002',
  completion: '60000000-0000-0000-0000-000000000001',
  finalCompletion: '60000000-0000-0000-0000-000000000002',
  assignment: '70000000-0000-0000-0000-000000000001',
}

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.profiles(id uuid primary key, full_name text not null, access_role text not null, active boolean not null default true);
  create table public.planning_workers(id uuid primary key, display_name text not null, linked_profile_id uuid references public.profiles(id), active boolean not null default true);
  create table public.buildings(id uuid primary key, name text not null, active boolean not null default true);
  create table public.floors(id uuid primary key, building_id uuid not null references public.buildings(id), name text not null);
  create table public.rooms(id uuid primary key, building_id uuid not null references public.buildings(id), floor_id uuid references public.floors(id), name text not null);
  create table public.cleaning_tasks(id uuid primary key, room_id uuid references public.rooms(id), name text not null, frequency text not null default 'daily');
  create table public.cleaning_completions(id uuid primary key, completion_date date not null, task_id uuid not null references public.cleaning_tasks(id), worker_id uuid not null references public.profiles(id), completed boolean not null, completed_at timestamptz);
  create table public.worker_work_assignments(
    id uuid primary key, planning_worker_id uuid not null references public.planning_workers(id), building_id uuid not null references public.buildings(id),
    floor_id uuid references public.floors(id), area_label text not null, weekdays smallint[] not null, valid_from date not null, valid_to date,
    active boolean not null default true, created_by uuid not null references public.profiles(id), updated_by uuid not null references public.profiles(id)
  );
  create table public.worker_schedule_exceptions(
    id uuid primary key default gen_random_uuid(), planning_worker_id uuid not null references public.planning_workers(id), exception_date date not null,
    planned boolean not null, building_id uuid references public.buildings(id), floor_id uuid references public.floors(id), area_label text,
    note text not null default '', active boolean not null default true
  );

  create function public.is_admin() returns boolean language sql security definer set search_path=''
    as $$ select exists(select 1 from public.profiles where id=auth.uid() and active and access_role='admin') $$;
  create function public.can_work_in_app() returns boolean language sql security definer set search_path=''
    as $$ select exists(select 1 from public.profiles where id=auth.uid() and active and access_role in ('cleaning_team','admin')) $$;
  create function public.can_view_school_data() returns boolean language sql security definer set search_path=''
    as $$ select exists(select 1 from public.profiles where id=auth.uid() and active) $$;
  create function public.admin_save_planning_worker_schedule_exception(
    target_id uuid,target_planning_worker_id uuid,target_date date,target_planned boolean,target_building_id uuid,
    target_floor_id uuid,target_area_label text,target_note text,target_active boolean
  ) returns uuid language plpgsql security definer set search_path='' as $$
  declare saved uuid:=coalesce(target_id,gen_random_uuid());
  begin
    if not public.is_admin() then raise exception 'Pouze správce.'; end if;
    insert into public.worker_schedule_exceptions(id,planning_worker_id,exception_date,planned,building_id,floor_id,area_label,note,active)
    values(saved,target_planning_worker_id,target_date,target_planned,target_building_id,target_floor_id,target_area_label,coalesce(target_note,''),target_active)
    on conflict(id) do update set planning_worker_id=excluded.planning_worker_id,exception_date=excluded.exception_date,planned=excluded.planned,
      building_id=excluded.building_id,floor_id=excluded.floor_id,area_label=excluded.area_label,note=excluded.note,active=excluded.active;
    return saved;
  end $$;

  insert into public.profiles values
    ('${id.danaProfile}','Dana','cleaning_team',true),
    ('${id.adminProfile}','Správce','admin',true);
  insert into public.planning_workers values
    ('${id.danaWorker}','Dana','${id.danaProfile}',true),
    ('${id.martinaWorker}','Martina',null,true);
  insert into public.buildings values ('${id.school}','Škola',true);
  insert into public.floors values ('${id.floor}','${id.school}','1. patro');
  insert into public.rooms values ('${id.room}','${id.school}','${id.floor}','Společenská místnost');
  insert into public.cleaning_tasks values
    ('${id.task}','${id.room}','Vytřít','daily'),
    ('${id.finalTask}',null,'Zavřít okna','daily');
  insert into public.cleaning_completions values
    ('${id.completion}','2026-09-08','${id.task}','${id.danaProfile}',true,'2026-09-08 17:00+02'),
    ('${id.finalCompletion}','2026-09-08','${id.finalTask}','${id.danaProfile}',true,'2026-09-08 17:05+02');
  insert into public.worker_work_assignments values
    ('${id.assignment}','${id.danaWorker}','${id.school}','${id.floor}','1. patro',array[1,3,5]::smallint[],'2026-09-01',null,true,'${id.adminProfile}','${id.adminProfile}');
`)

const migration = readFileSync(new URL('../supabase/migrations/20260909203841_cleaning_recommendations_and_actual_work.sql', import.meta.url), 'utf8')
await db.exec(migration)

async function asUser(userId, callback) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId])
  try { return await callback() } finally { await db.exec('reset role') }
}

assert.equal((await db.query('select count(*)::integer count from public.worker_cleaning_areas')).rows[0].count, 1)
assert.equal((await db.query('select count(*)::integer count from public.cleaning_actual_records where legacy_completion_id=$1', [id.completion])).rows[0].count, 1)
assert.equal((await db.query('select count(*)::integer count from public.cleaning_actual_records where legacy_completion_id=$1', [id.finalCompletion])).rows[0].count, 0)

const own = await asUser(id.danaProfile, () => db.query(
  `select public.save_cleaning_actual_batch($1,'2026-09-09',$2::jsonb) ids`,
  [id.danaWorker, JSON.stringify([{ building_id: id.school, floor_id: id.floor, room_id: id.room, category: 'routine', outcome: 'completed', label: 'Běžný úklid místnosti' }])],
))
assert.equal(own.rows[0].ids.length, 1)
await assert.rejects(
  asUser(id.danaProfile, () => db.query(
    `select public.save_cleaning_actual_batch($1,'2026-09-09',$2::jsonb)`,
    [id.martinaWorker, JSON.stringify([{ building_id: id.school, floor_id: id.floor, room_id: id.room, category: 'routine', outcome: 'completed', label: 'Cizí práce' }])],
  )),
  /pouze svoji práci/i,
)

const other = await asUser(id.adminProfile, () => db.query(
  `select public.save_cleaning_actual_batch($1,'2026-09-09',$2::jsonb) ids`,
  [id.martinaWorker, JSON.stringify([{ building_id: id.school, floor_id: id.floor, room_id: id.room, category: 'detail', outcome: 'completed', label: 'Vodní kámen' }])],
))
assert.equal(other.rows[0].ids.length, 1)

await asUser(id.adminProfile, () => db.query(
  `select public.admin_save_worker_availability_change(null,$1,'2026-09-11','absent',null,null,null,null,'Nemoc',true)`,
  [id.danaWorker],
))
assert.equal((await db.query("select count(*)::integer count from public.worker_schedule_exceptions where planning_worker_id=$1 and exception_date='2026-09-11' and not planned and active", [id.danaWorker])).rows[0].count, 1)

await assert.rejects(
  asUser(id.danaProfile, () => db.query(`insert into public.cleaning_actual_records(work_date,subject_planning_worker_id,recorded_by,building_id,category,outcome,label) values('2026-09-09',$1,$2,$3,'routine','completed','Přímý zápis')`, [id.danaWorker, id.danaProfile, id.school])),
  /permission denied|row-level security/i,
)
assert.equal((await db.query("select has_function_privilege('anon','public.save_cleaning_actual_batch(uuid,date,jsonb)','EXECUTE') allowed")).rows[0].allowed, false)

console.log('cleaning actual/recommendation PostgreSQL integration: OK')
await db.close()
