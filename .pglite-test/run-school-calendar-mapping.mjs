import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const actor = '00000000-0000-0000-0000-000000000010'
const school = '00000000-0000-0000-0000-000000000020'
const floor = '00000000-0000-0000-0000-000000000030'
const room = '00000000-0000-0000-0000-000000000040'
const db = new PGlite()

await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
  create table public.profiles(id uuid primary key);
  create table public.buildings(id uuid primary key, name text not null);
  create table public.floors(id uuid primary key, building_id uuid not null references public.buildings(id));
  create table public.rooms(id uuid primary key, building_id uuid not null references public.buildings(id), floor_id uuid references public.floors(id));
  insert into public.profiles values ('${actor}');
  insert into public.buildings values ('${school}', 'Škola');
  insert into public.floors values ('${floor}', '${school}');
  insert into public.rooms values ('${room}', '${school}', '${floor}');
  create function public.can_view_school_data() returns boolean language sql stable as $$ select true $$;
  create function public.is_admin() returns boolean language sql stable as $$ select true $$;
`)

const migration = readFileSync(new URL('../supabase/migrations/20260907120000_school_calendar_scope_mappings.sql', import.meta.url), 'utf8')
await db.exec(migration)

const instance = await db.query(`select public.admin_save_school_calendar_event_mapping(
  null, 'google-instance', null, 'rooms', '${school}', null, array['${room}'::uuid], true
) id`)
assert.equal(instance.rows.length, 1)

await db.query(`select public.admin_save_school_calendar_event_mapping(
  null, null, 'google-series', 'building', '${school}', null, array[]::uuid[], true
)`)
await db.query(`select public.admin_save_school_calendar_location_alias(
  null, 'Tělocvična', 'rooms', '${school}', null, '${room}', true
)`)

assert.equal((await db.query(`select count(*)::integer count from public.school_calendar_event_scope_mappings where active`)).rows[0].count, 2)
assert.equal((await db.query(`select count(*)::integer count from public.school_calendar_event_scope_rooms`)).rows[0].count, 1)
assert.equal((await db.query(`select normalized_alias from public.school_calendar_location_aliases where active`)).rows[0].normalized_alias, 'telocvicna')
assert.equal((await db.query(`select has_table_privilege('anon','public.school_calendar_event_scope_mappings','SELECT') allowed`)).rows[0].allowed, false)
assert.equal((await db.query(`select has_function_privilege('anon','public.admin_save_school_calendar_event_mapping(uuid,text,text,text,uuid,uuid,uuid[],boolean)','EXECUTE') allowed`)).rows[0].allowed, false)
assert.equal((await db.query(`select has_function_privilege('authenticated','public.admin_save_school_calendar_event_mapping(uuid,text,text,text,uuid,uuid,uuid[],boolean)','EXECUTE') allowed`)).rows[0].allowed, true)

console.log('School Calendar mapping PostgreSQL integration: OK')
