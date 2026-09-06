import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const actor = '00000000-0000-0000-0000-000000000001'
const diner = '00000000-0000-0000-0000-000000000002'
const portion = '00000000-0000-0000-0000-000000000003'
const day = '00000000-0000-0000-0000-000000000004'
const variant = '00000000-0000-0000-0000-000000000005'
const order = '00000000-0000-0000-0000-000000000006'

await db.exec(`
create role anon;
create role authenticated;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
create table public.profiles(id uuid primary key, full_name text, is_owner boolean default false);
create table public.user_module_roles(user_id uuid, module text, role text);
grant select on public.user_module_roles to authenticated;
create function public.is_owner() returns boolean language sql stable as $$ select false $$;
create table public.cafeteria_portion_categories(id uuid primary key, code text, name text, active boolean default true);
create table public.cafeteria_diners(id uuid primary key, full_name text, portion_category_id uuid, active boolean, valid_from date, valid_to date);
create table public.cafeteria_meal_days(id uuid primary key, meal_date date, status text);
create table public.cafeteria_meal_variants(id uuid primary key, meal_day_id uuid, name text);
create table public.cafeteria_orders(id uuid primary key, diner_id uuid, meal_day_id uuid, meal_variant_id uuid, portion_category_id uuid, status text);
create table public.cafeteria_late_change_requests(id uuid primary key, order_id uuid, diner_id uuid, meal_day_id uuid, request_type text, requested_variant_id uuid, requested_at timestamptz, status text);
insert into public.profiles values ('${actor}', 'Kuchařka A', false);
insert into public.user_module_roles values ('${actor}', 'cafeteria', 'kitchen');
`)

const migration = readFileSync(new URL('../supabase/migrations/20260906132631_cafeteria_kitchen_workflow.sql', import.meta.url), 'utf8')
await db.exec(migration)

await db.exec(`
insert into public.cafeteria_portion_categories values ('${portion}', 'small', 'Malá porce', true);
insert into public.cafeteria_diners values ('${diner}', 'Strávník A', '${portion}', true, current_date - 1, null);
insert into public.cafeteria_meal_days values ('${day}', current_date, 'published');
insert into public.cafeteria_meal_variants values ('${variant}', '${day}', 'Jídlo A');
insert into public.cafeteria_orders values ('${order}', '${diner}', '${day}', '${variant}', '${portion}', 'ordered');
`)

const service = await db.query(`select * from public.cafeteria_kitchen_service(current_date)`)
assert.equal(service.rows.length, 1)
assert.equal(service.rows[0].diner_name, 'Strávník A')
assert.equal(service.rows[0].fulfillment_status, 'waiting')
assert.deepEqual(Object.keys(service.rows[0]).sort(), ['diner_id','diner_name','fulfillment_status','order_id','portion_code','portion_name','variant_id','variant_name'].sort())

await db.query(`select public.cafeteria_set_order_fulfillment('${order}', 'boxed')`)
await db.query(`select public.cafeteria_set_order_fulfillment('${order}', 'issued')`)
const fulfillment = await db.query(`select status, updated_by from public.cafeteria_order_fulfillments where order_id='${order}'`)
assert.deepEqual(fulfillment.rows, [{ status: 'issued', updated_by: actor }])
const events = await db.query(`select status, actor_user_id from public.cafeteria_order_fulfillment_events where order_id='${order}' order by occurred_at, id`)
assert.deepEqual(events.rows.map((row) => row.status), ['boxed', 'issued'])
assert.ok(events.rows.every((row) => row.actor_user_id === actor))

const search = await db.query(`select * from public.cafeteria_kitchen_search_diners('Strávník', current_date)`)
assert.equal(search.rows.length, 1)
assert.deepEqual(Object.keys(search.rows[0]).sort(), ['diner_id','diner_name','portion_category_id','portion_code','portion_name'].sort())

assert.equal((await db.query(`select has_function_privilege('anon','public.cafeteria_kitchen_service(date)','EXECUTE') allowed`)).rows[0].allowed, false)
assert.equal((await db.query(`select relrowsecurity from pg_class where oid='public.cafeteria_order_fulfillments'::regclass`)).rows[0].relrowsecurity, true)

await db.exec('set role authenticated')
assert.equal((await db.query(`select count(*)::integer count from public.cafeteria_order_fulfillments`)).rows[0].count, 1)
assert.equal((await db.query(`select count(*)::integer count from public.cafeteria_kitchen_service(current_date)`)).rows[0].count, 1)
await db.exec('reset role')

await db.exec(`delete from public.user_module_roles where user_id='${actor}'`)
await db.exec('set role authenticated')
assert.equal((await db.query(`select count(*)::integer count from public.cafeteria_order_fulfillments`)).rows[0].count, 0)
await assert.rejects(() => db.query(`select * from public.cafeteria_kitchen_service(current_date)`), /Nemáte oprávnění/)
await db.exec('reset role')
await db.exec(`insert into public.user_module_roles values ('${actor}', 'cafeteria', 'kitchen')`)

await db.exec('set role anon')
await assert.rejects(() => db.query(`select * from public.cafeteria_kitchen_service(current_date)`), /permission denied/)
await db.exec('reset role')

const sqlContract = readFileSync(new URL('../supabase/tests/132631_cafeteria_kitchen_workflow.sql', import.meta.url), 'utf8')
await db.exec(sqlContract)

console.log('cafeteria kitchen SQL/RLS integration: OK')
