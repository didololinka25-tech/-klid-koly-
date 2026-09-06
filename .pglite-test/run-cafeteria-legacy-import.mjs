import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { insertLegacyOrder } from '../scripts/lib/cafeteriaLegacyApply.mjs'
import { IMPORT_STATUSES, planImport } from '../scripts/lib/cafeteriaLegacyImport.mjs'

const db = new PGlite()
const ids = {
  portion: '00000000-0000-0000-0000-000000000001',
  diner: '00000000-0000-0000-0000-000000000002',
  pastDay: '00000000-0000-0000-0000-000000000003',
  futureDay: '00000000-0000-0000-0000-000000000004',
  pastVariant: '00000000-0000-0000-0000-000000000005',
  futureVariant: '00000000-0000-0000-0000-000000000006',
}

await db.exec(`
create table public.cafeteria_portion_categories (
  id uuid primary key,
  code text not null
);
create table public.cafeteria_diners (
  id uuid primary key,
  full_name text not null,
  portion_category_id uuid not null references public.cafeteria_portion_categories(id)
);
create table public.cafeteria_meal_days (
  id uuid primary key,
  meal_date date not null,
  cutoff_at timestamptz not null
);
create table public.cafeteria_meal_variants (
  id uuid primary key,
  meal_day_id uuid not null references public.cafeteria_meal_days(id),
  name text not null,
  active boolean not null default true
);
create table public.cafeteria_orders (
  id uuid primary key default gen_random_uuid(),
  diner_id uuid not null references public.cafeteria_diners(id),
  meal_day_id uuid not null references public.cafeteria_meal_days(id),
  meal_variant_id uuid not null references public.cafeteria_meal_variants(id),
  portion_category_id uuid references public.cafeteria_portion_categories(id),
  quantity smallint not null check (quantity between 1 and 10),
  status text not null,
  unique (diner_id, meal_day_id)
);
create table public.cafeteria_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.cafeteria_orders(id),
  diner_id uuid not null,
  meal_day_id uuid not null,
  meal_variant_id uuid not null,
  portion_category_id uuid not null,
  quantity smallint not null,
  status text not null,
  event_type text not null,
  actor_source text not null,
  occurred_at timestamptz not null default now()
);

create function normalize_legacy_order() returns trigger language plpgsql as $$
begin
  select d.portion_category_id into new.portion_category_id
  from public.cafeteria_diners d where d.id = new.diner_id;
  return new;
end
$$;
create trigger cafeteria_orders_normalize_before_write
before insert on public.cafeteria_orders
for each row execute function normalize_legacy_order();

create function log_legacy_order_event() returns trigger language plpgsql as $$
begin
  insert into public.cafeteria_order_events (
    order_id, diner_id, meal_day_id, meal_variant_id, portion_category_id,
    quantity, status, event_type, actor_source, occurred_at
  ) values (
    new.id, new.diner_id, new.meal_day_id, new.meal_variant_id, new.portion_category_id,
    new.quantity, new.status, 'ordered', 'system', now()
  );
  return new;
end
$$;
create trigger cafeteria_orders_log_after_write
after insert on public.cafeteria_orders
for each row execute function log_legacy_order_event();

create view public.cafeteria_kitchen_order_counts as
with cutoff_last as (
  select distinct on (e.order_id) e.order_id, e.meal_day_id, e.status, e.quantity
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days d on d.id = e.meal_day_id
  where e.occurred_at <= d.cutoff_at
  order by e.order_id, e.occurred_at desc, e.id desc
), cutoff_counts as (
  select meal_day_id, coalesce(sum(quantity) filter (where status = 'ordered'), 0)::integer cutoff_count
  from cutoff_last group by meal_day_id
), current_counts as (
  select meal_day_id, coalesce(sum(quantity) filter (where status = 'ordered'), 0)::integer current_count
  from public.cafeteria_orders group by meal_day_id
)
select d.id meal_day_id, coalesce(c.cutoff_count, 0) cutoff_count,
       coalesce(n.current_count, 0) current_count,
       coalesce(n.current_count, 0) - coalesce(c.cutoff_count, 0) late_delta
from public.cafeteria_meal_days d
left join cutoff_counts c on c.meal_day_id = d.id
left join current_counts n on n.meal_day_id = d.id;

insert into public.cafeteria_portion_categories values ('${ids.portion}', 'small');
insert into public.cafeteria_diners values ('${ids.diner}', 'Anna Testovací', '${ids.portion}');
insert into public.cafeteria_meal_days values
  ('${ids.pastDay}', current_date - 1, now() - interval '1 hour'),
  ('${ids.futureDay}', current_date + 1, now() + interval '1 hour');
insert into public.cafeteria_meal_variants values
  ('${ids.pastVariant}', '${ids.pastDay}', 'Minulé jídlo', true),
  ('${ids.futureVariant}', '${ids.futureDay}', 'Budoucí jídlo', true);
`)

const client = { query: (sql, values = []) => db.query(sql, values) }
const diner = { id: ids.diner, full_name: 'Anna Testovací', portion_category_id: ids.portion }
const pastDay = { id: ids.pastDay, meal_date: '2026-09-05' }
const pastVariant = { id: ids.pastVariant, meal_day_id: ids.pastDay, name: 'Minulé jídlo', active: true }

const importedPast = await insertLegacyOrder(client, { diner, mealDay: pastDay, variant: pastVariant, quantity: 2 })
assert.equal(importedPast.cutoffPassed, true)
assert.equal(importedPast.snapshotAdjusted, true)

const pastEvent = (await db.query(`
  select e.actor_source, e.quantity,
         e.occurred_at = d.cutoff_at - interval '1 second' as is_snapshot
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days d on d.id = e.meal_day_id
  where e.order_id = $1
`, [importedPast.orderId])).rows[0]
assert.deepEqual(pastEvent, { actor_source: 'system', quantity: 2, is_snapshot: true })

const pastCount = (await db.query(`
  select cutoff_count, current_count, late_delta
  from public.cafeteria_kitchen_order_counts where meal_day_id = $1
`, [ids.pastDay])).rows[0]
assert.deepEqual(pastCount, { cutoff_count: 2, current_count: 2, late_delta: 0 })

const futureDay = { id: ids.futureDay, meal_date: '2026-09-07' }
const futureVariant = { id: ids.futureVariant, meal_day_id: ids.futureDay, name: 'Budoucí jídlo', active: true }
const beforeFutureInsert = Date.now()
const importedFuture = await insertLegacyOrder(client, { diner, mealDay: futureDay, variant: futureVariant, quantity: 1 })
assert.equal(importedFuture.cutoffPassed, false)
assert.equal(importedFuture.snapshotAdjusted, false)

const futureEvent = (await db.query(`
  select extract(epoch from e.occurred_at) * 1000 as occurred_ms,
         e.occurred_at = d.cutoff_at - interval '1 second' as is_snapshot
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days d on d.id = e.meal_day_id
  where e.order_id = $1
`, [importedFuture.orderId])).rows[0]
assert.equal(futureEvent.is_snapshot, false)
assert.ok(Number(futureEvent.occurred_ms) >= beforeFutureInsert - 1000)

const databaseAfterImport = {
  diners: [diner], mealDays: [pastDay], variants: [pastVariant],
  orders: [{ diner_id: ids.diner, meal_day_id: ids.pastDay }],
  priceRules: [{ portion_category_id: ids.portion, valid_from: '2020-01-01', valid_to: null, price: 70, active: true }],
}
const repeatedPlan = planImport([{
  mealDate: pastDay.meal_date, sourceParts: ['Testovací', 'Anna'], sourceName: 'Testovací Anna',
  value: 2, quantity: 2, quantityKind: 'order', color: null,
}], databaseAfterImport, new Map())
assert.equal(repeatedPlan[0].status, IMPORT_STATUSES.SKIP_ALREADY_EXISTS)
assert.equal((await db.query('select count(*)::integer count from public.cafeteria_orders where diner_id = $1 and meal_day_id = $2', [ids.diner, ids.pastDay])).rows[0].count, 1)

console.log('cafeteria legacy cutoff import SQL integration: OK')
