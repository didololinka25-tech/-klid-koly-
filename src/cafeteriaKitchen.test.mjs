import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  filterKitchenService,
  fulfillmentSummary,
  signedCount,
  sortKitchenService,
  summarizeKitchenCounts,
} from './cafeteria/kitchenModel.ts'
import { routeAllowed, routeFromHash } from './system/access.ts'

const count = (overrides = {}) => ({
  mealDayId: 'day-1', mealDate: '2026-09-08', cutoffAt: '2026-09-07T12:00:00Z',
  mealVariantId: 'variant-1', mealVariantName: 'Jídlo A', portionCategoryId: 'small',
  portionCode: 'small', portionName: 'Malá porce', cutoffCount: 4, currentCount: 5, lateDelta: 1,
  ...overrides,
})
const service = (overrides = {}) => ({
  orderId: 'order-1', dinerId: 'diner-1', dinerName: 'Anna Testovací', portionCode: 'small',
  portionName: 'Malá porce', quantity: 1, variantId: 'variant-1', variantName: 'Jídlo A', fulfillmentStatus: 'waiting',
  ...overrides,
})

const migrationUrl = new URL('../supabase/migrations/20260906132631_cafeteria_kitchen_workflow.sql', import.meta.url)
const sourceUrl = new URL('./cafeteria/CafeteriaKitchen.tsx', import.meta.url)
const repoUrl = new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url)
const appUrl = new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url)
const orderingUrl = new URL('../supabase/migrations/20260905195953_cafeteria_ordering_core.sql', import.meta.url)

test('Dnes sčítá cutoff, late delta a aktuální počty', () => {
  const totals = summarizeKitchenCounts([count(), count({ portionCategoryId: 'large', portionCode: 'large', cutoffCount: 2, currentCount: 1, lateDelta: -1 })])
  assert.deepEqual(totals, { cutoff: 6, late: 0, current: 6, small: 5, large: 1 })
  assert.equal(signedCount(2), '+2')
  assert.equal(signedCount(-1), '−1')
})

test('variant breakdown zachovává libovolné varianty a porce', () => {
  const rows = [count(), count({ mealVariantId: 'variant-2', mealVariantName: 'Jídlo B', portionCode: 'large', portionCategoryId: 'large', currentCount: 3 })]
  assert.deepEqual(rows.map((row) => [row.mealVariantName, row.portionCode, row.currentCount]), [['Jídlo A', 'small', 5], ['Jídlo B', 'large', 3]])
})

test('výdej shrnuje čekající, krabičky a vydané', () => {
  assert.deepEqual(fulfillmentSummary([service(), service({ orderId: '2', fulfillmentStatus: 'boxed' }), service({ orderId: '3', fulfillmentStatus: 'issued' })]), { waiting: 1, boxed: 1, issued: 1 })
})

test('výchozí stav bez fulfillment řádku je waiting', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.match(migration, /coalesce\(fulfillment\.status, 'waiting'\)/i)
})

for (const [from, to] of [['waiting', 'boxed'], ['boxed', 'issued'], ['issued', 'waiting'], ['issued', 'boxed']]) {
  test(`stav výdeje je vratný ${from} → ${to}`, async () => {
    const migration = await readFile(migrationUrl, 'utf8')
    assert.match(migration, /target_status not in \('waiting','boxed','issued'\)/i)
    assert.match(migration, /on conflict \(order_id\) do update[\s\S]*status = excluded\.status/i)
  })
}

test('výdej řadí waiting, boxed, issued a uvnitř podle jména', () => {
  const rows = sortKitchenService([service({ orderId: '3', dinerName: 'Cyril', fulfillmentStatus: 'issued' }), service({ orderId: '2', dinerName: 'Berta', fulfillmentStatus: 'boxed' }), service({ dinerName: 'Anna' })])
  assert.deepEqual(rows.map((row) => row.fulfillmentStatus), ['waiting', 'boxed', 'issued'])
})

test('filtry výdeje a filtr varianty fungují společně', () => {
  const rows = [service(), service({ orderId: '2', fulfillmentStatus: 'boxed', variantId: 'variant-2' })]
  assert.deepEqual(filterKitchenService(rows, 'boxed', '', '').map((row) => row.orderId), ['2'])
  assert.deepEqual(filterKitchenService(rows, 'all', '', 'variant-1').map((row) => row.orderId), ['order-1'])
})

test('hledání jména je case-insensitive a bez diakritiky', () => {
  assert.equal(filterKitchenService([service({ dinerName: 'Áňa Žáková' })], 'all', 'ana zak', '').length, 1)
})

test('ruční přidání používá existující objednávku nebo createOrder', async () => {
  const repository = await readFile(repoUrl, 'utf8')
  assert.match(repository, /addKitchenOrder[\s\S]*cafeteria_orders[\s\S]*createOrder[\s\S]*updateOrder/)
  assert.doesNotMatch(repository, /kitchen_manual_orders|guest_orders/)
})

test('audit ruční objednávky zachová actor_source kitchen', async () => {
  const ordering = await readFile(orderingUrl, 'utf8')
  assert.match(ordering, /role = 'kitchen'[\s\S]*v_actor_source := 'kitchen'/)
  assert.match(ordering, /cafeteria_orders_log_after_write/)
})

test('ruční přidání s více variantami vyžaduje výběr', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /meal\.variants\.length > 1[\s\S]*type="radio"/)
  assert.match(source, /disabled=\{!selected \|\| !variantId/)
})

test('jedna varianta ručního přidání se předvybere', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /meal\.variants\.length === 1 \? meal\.variants\[0\]\.id : ''/)
})

test('pending late requests se načítají jedním minimálním RPC', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.match(migration, /function public\.cafeteria_kitchen_pending_requests\(\)/i)
  assert.match(migration, /where request\.status = 'pending'/i)
  assert.doesNotMatch(migration, /family_id|account_id|variable_symbol|phone|email/i)
})

test('pozdní cancel nabízí bez účtování, s účtováním a deny', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  for (const text of ['Odhlásit bez účtování', 'Odhlásit, ale účtovat', 'Zamítnout', "'not_charged'", "'charged'", "'denied'"]) assert.match(source, new RegExp(text))
})

test('dodatečné přihlášení a změna varianty používají existující decision RPC', async () => {
  const repository = await readFile(repoUrl, 'utf8')
  assert.match(repository, /decideKitchenLateRequest[\s\S]*cafeteria_decide_late_change/)
  const ordering = await readFile(orderingUrl, 'utf8')
  assert.match(ordering, /request_type = 'add'[\s\S]*insert into public\.cafeteria_orders/)
  assert.match(ordering, /request_type = 'change_variant'[\s\S]*meal_variant_id = v_request\.requested_variant_id/)
})

test('fulfillment změna zapisuje append-only audit event', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.match(migration, /after insert or update on public\.cafeteria_order_fulfillments/)
  assert.match(migration, /insert into public\.cafeteria_order_fulfillment_events/)
  assert.doesNotMatch(migration, /delete\s+from|truncate\s+/i)
})

test('fulfillment tabulky mají RLS a přístup jen pro kitchen admin owner', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const table of ['cafeteria_order_fulfillments', 'cafeteria_order_fulfillment_events']) assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  assert.match(migration, /role\.role in \('admin','kitchen'\)/i)
  assert.doesNotMatch(migration, /role\.role in \('parent','diner'/i)
})

test('anon a public nemají tabulky ani kitchen RPC', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.match(migration, /revoke all on table public\.cafeteria_order_fulfillments from public, anon, authenticated/i)
  assert.match(migration, /revoke all on function public\.cafeteria_kitchen_service\(date\) from public, anon, authenticated/i)
  assert.match(migration, /grant execute on function public\.cafeteria_kitchen_service\(date\) to authenticated/i)
})

test('SECURITY DEFINER RPC ověřují auth a mají prázdný search_path', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const name of ['cafeteria_kitchen_service', 'cafeteria_kitchen_search_diners', 'cafeteria_set_order_fulfillment', 'cafeteria_kitchen_pending_requests']) {
    const block = migration.slice(migration.indexOf(`function public.${name}`), migration.indexOf('$$;', migration.indexOf(`function public.${name}`)) + 3)
    assert.match(block, /security definer[\s\S]*set search_path = ''/i)
    assert.match(block, /auth\.uid\(\) is null[\s\S]*role in \('admin','kitchen'\)/i)
  }
})

test('kitchen UI má čtyři požadované záložky a Dnes je první', async () => {
  const app = await readFile(appUrl, 'utf8')
  assert.match(app, /role === 'kitchen' \? \['Dnes', 'Výdej', 'Jídelníček', 'Žádosti'\]/)
})

test('frontend před aplikací migrace zobrazí bezpečný kitchen fallback', async () => {
  const repository = await readFile(repoUrl, 'utf8')
  assert.match(repository, /code === 'PGRST202'[\s\S]*Kuchyňský provoz zatím není aktivovaný\./)
})

test('kitchen UI je karetní, bez desktopové tabulky a s velkými touch akcemi', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /<table|<thead|<tbody/)
  assert.match(styles, /\.kitchen-row-actions button \{ min-height: 48px/)
  assert.match(styles, /\.kitchen-filter-row button \{ min-height: 44px/)
})

test('rodičovská rodinná mřížka zůstává zapojená beze změny engine', async () => {
  const app = await readFile(appUrl, 'utf8')
  assert.match(app, /role === 'parent' && section === 'Obědy'[\s\S]*<CafeteriaOrdering/)
  const orderingGrid = await readFile(new URL('./cafeteria/CafeteriaOrdering.tsx', import.meta.url), 'utf8')
  assert.match(orderingGrid, /family-order-grid/)
})

test('Úklid a launcher zachovávají původní hash navigaci', () => {
  assert.equal(routeFromHash('#/cleaning'), 'cleaning')
  assert.equal(routeFromHash('#/cafeteria'), 'cafeteria')
  assert.equal(routeAllowed('cleaning', { cleaning: true, cafeteria: true, cafeteriaAvailable: true, cafeteriaRoles: ['kitchen'] }), true)
})
