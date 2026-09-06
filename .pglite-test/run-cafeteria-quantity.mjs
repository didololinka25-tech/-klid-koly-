import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const ids = Array.from({ length: 7 }, (_, index) => `00000000-0000-0000-0000-00000000000${index + 1}`)
const [actor, account, portion, diner, day, variant, order] = ids
await db.exec(`
create role anon; create role authenticated; create schema auth; create schema private;
create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
create table public.profiles(id uuid primary key);
create table public.user_module_roles(user_id uuid, module text, role text);
create function public.is_owner() returns boolean language sql stable as $$ select true $$;
create table public.cafeteria_accounts(id uuid primary key);
create table public.cafeteria_portion_categories(id uuid primary key, code text, name text);
create table public.cafeteria_diners(id uuid primary key, account_id uuid, portion_category_id uuid, active boolean, valid_from date, valid_to date, full_name text);
create table public.cafeteria_meal_days(id uuid primary key, meal_date date, cutoff_at timestamptz, status text);
create table public.cafeteria_meal_variants(id uuid primary key, meal_day_id uuid, name text, active boolean);
create table public.cafeteria_price_rules(id uuid primary key, portion_category_id uuid, valid_from date, valid_to date, price numeric, active boolean, created_at timestamptz);
create table public.cafeteria_orders(
 id uuid primary key, diner_id uuid, meal_day_id uuid, meal_variant_id uuid, account_id uuid, portion_category_id uuid,
 unit_price numeric, quantity smallint default 1 constraint cafeteria_orders_quantity_check check(quantity=1), status text,
 ordered_at timestamptz, cancelled_at timestamptz, created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid
);
create table public.cafeteria_order_events(
 id uuid primary key, order_id uuid, diner_id uuid, meal_day_id uuid, meal_variant_id uuid, account_id uuid,
 portion_category_id uuid, unit_price numeric, quantity smallint constraint cafeteria_order_events_quantity_check check(quantity=1),
 status text, event_type text, actor_user_id uuid, actor_source text, occurred_at timestamptz
);
create table public.cafeteria_order_fulfillments(order_id uuid primary key, status text);
`)

const migration = readFileSync(new URL('../supabase/migrations/20260906165639_cafeteria_order_quantity_support.sql', import.meta.url), 'utf8')
await db.exec(migration)
await db.exec(`
insert into public.profiles values ('${actor}');
insert into public.cafeteria_accounts values ('${account}');
insert into public.cafeteria_portion_categories values ('${portion}','small','Malá porce');
insert into public.cafeteria_diners values ('${diner}','${account}','${portion}',true,current_date-1,null,'Strávník A');
insert into public.cafeteria_meal_days values ('${day}',current_date,now()+interval '1 hour','published');
insert into public.cafeteria_meal_variants values ('${variant}','${day}','Jídlo A',true);
insert into public.cafeteria_price_rules values (gen_random_uuid(),'${portion}',current_date-1,null,70,true,now());
insert into public.cafeteria_orders values ('${order}','${diner}','${day}','${variant}','${account}','${portion}',70,2,'ordered',now(),null,now(),'${actor}',now(),'${actor}');
insert into public.cafeteria_order_events values (gen_random_uuid(),'${order}','${diner}','${day}','${variant}','${account}','${portion}',70,2,'ordered','ordered','${actor}','system',now());
`)
const counts = (await db.query('select cutoff_count,current_count,late_delta from public.cafeteria_kitchen_order_counts')).rows[0]
assert.deepEqual(counts, { cutoff_count: 2, current_count: 2, late_delta: 0 })
const service = (await db.query('select quantity from public.cafeteria_kitchen_service(current_date)')).rows
assert.deepEqual(service, [{ quantity: 2 }])
await assert.rejects(() => db.exec(`insert into public.cafeteria_orders values (gen_random_uuid(),'${diner}','${day}','${variant}','${account}','${portion}',70,11,'ordered',now(),null,now(),'${actor}',now(),'${actor}')`), /quantity_range/)
console.log('cafeteria quantity SQL integration: OK')
