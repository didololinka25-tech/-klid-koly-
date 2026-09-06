import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  applicablePrice,
  buildMealWeek,
  bulkDayDecision,
  isBeforeCutoff,
  lateRequestMessage,
  lateRequestTypeFor,
  normalOrderVariant,
  showDinerPicker,
  weekDateKeys,
  weekForDate,
} from './cafeteria/orderingModel.ts'
import { routeAllowed, routeFromHash } from './system/access.ts'

const now = new Date('2026-09-07T08:00:00Z')
const week = weekForDate('2026-09-09')
const diner = { id: 'diner-1', fullName: 'Dítě A', dinerType: 'child', profileId: null, familyId: 'family-1', accountId: 'account-1', portionCategoryId: 'portion-1', portionName: 'Malá porce' }
const meal = (overrides = {}) => ({
  id: 'meal-1', mealDate: '2026-09-07', cutoffAt: '2026-09-08T12:00:00Z', note: null,
  variants: [{ id: 'variant-1', mealDayId: 'meal-1', name: 'Jídlo A', note: null, sortOrder: 10 }],
  ...overrides,
})
const order = (overrides = {}) => ({
  id: 'order-1', dinerId: diner.id, mealDayId: 'meal-1', mealVariantId: 'variant-1', accountId: diner.accountId,
  portionCategoryId: diner.portionCategoryId, unitPrice: 70, status: 'ordered', orderedAt: '2026-09-01T10:00:00Z', cancelledAt: null,
  ...overrides,
})
const late = (overrides = {}) => ({
  id: 'late-1', orderId: null, dinerId: diner.id, mealDayId: 'meal-1', requestType: 'add', requestedVariantId: 'variant-1',
  status: 'pending', billingOutcome: null, requestedAt: '2026-09-08T13:00:00Z', ...overrides,
})
const day = (overrides = {}) => ({ mealDate: '2026-09-07', meal: meal(), order: null, lateRequest: null, price: 70, ...overrides })

test('aktuální kalendářní týden obsahuje pondělí až pátek', () => {
  assert.deepEqual(week, { start: '2026-09-07', end: '2026-09-11' })
  assert.deepEqual(weekDateKeys(week), ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'])
})

test('jeden strávník nezobrazuje přepínač', () => assert.equal(showDinerPicker(1), false))
test('více strávníků zobrazuje přepínač', () => assert.equal(showDinerPicker(2), true))

test('jediná varianta se použije bez dalšího výběru', () => {
  assert.equal(normalOrderVariant(day(), null), 'variant-1')
})

test('u více variant je před objednáním nutný výběr', () => {
  const multi = day({ meal: meal({ variants: [meal().variants[0], { id: 'variant-2', mealDayId: 'meal-1', name: 'Jídlo B', note: null, sortOrder: 20 }] }) })
  assert.equal(normalOrderVariant(multi, null), null)
  assert.equal(normalOrderVariant(multi, 'variant-2'), 'variant-2')
})

test('objednání je před uzávěrkou povoleno', () => {
  assert.equal(isBeforeCutoff(day(), now), true)
  assert.equal(bulkDayDecision(day(), now), 'order')
})

test('repository ruší objednávku změnou statusu, nikoli smazáním', async () => {
  const source = await readFile(new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url), 'utf8')
  assert.match(source, /cancelOrder:[\s\S]*status: 'cancelled'/)
  assert.doesNotMatch(source, /from\('cafeteria_orders'\)\.delete/)
})

test('uložení jednoho dne obnovuje týden na pozadí bez globálního loaderu', async () => {
  const source = await readFile(new URL('./cafeteria/CafeteriaOrdering.tsx', import.meta.url), 'utf8')
  assert.match(source, /setSavingDays[\s\S]*await loadWeek\(true\)/)
  assert.match(source, /if \(!background\) \{[\s\S]*setLoading\(true\)/)
})

test('zrušenou objednávku lze před uzávěrkou znovu objednat', () => {
  assert.equal(bulkDayDecision(day({ order: order({ status: 'cancelled' }) }), now), 'reorder')
})

test('po uzávěrce není nabídnuta běžná změna', () => {
  const closed = day({ meal: meal({ cutoffAt: '2026-09-06T12:00:00Z' }) })
  assert.equal(isBeforeCutoff(closed, now), false)
  assert.equal(bulkDayDecision(closed, now), 'closed')
})

test('pozdní požadavek bez objednávky je add', () => assert.equal(lateRequestTypeFor(day()), 'add'))
test('pozdní požadavek s objednávkou je cancel', () => assert.equal(lateRequestTypeFor(day({ order: order() })), 'cancel'))

test('pending pozdní žádost se před vložením kontroluje', async () => {
  const source = await readFile(new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url), 'utf8')
  assert.match(source, /cafeteria_late_change_requests[\s\S]*\.eq\('status', 'pending'\)\.maybeSingle\(\)/)
  assert.match(source, /if \(pending\.data\) return \{ created: false/)
})

test('schválené účtované storno má českou zprávu', () => {
  assert.equal(lateRequestMessage(late({ requestType: 'cancel', status: 'approved', billingOutcome: 'charged' })), 'Oběd byl odhlášen, ale bude účtován.')
})

test('schválené neúčtované storno má českou zprávu', () => {
  assert.equal(lateRequestMessage(late({ requestType: 'cancel', status: 'approved', billingOutcome: 'not_charged' })), '✅ Oběd byl odhlášen bez účtování.')
})

test('hromadná volba objedná otevřený den s jednou variantou', () => assert.equal(bulkDayDecision(day(), now), 'order'))

test('hromadná volba přeskočí den s více variantami', () => {
  const variants = [meal().variants[0], { id: 'variant-2', mealDayId: 'meal-1', name: 'Jídlo B', note: null, sortOrder: 20 }]
  assert.equal(bulkDayDecision(day({ meal: meal({ variants }) }), now), 'needs_variant')
})

test('hromadná volba přeskočí uzavřený den', () => {
  assert.equal(bulkDayDecision(day({ meal: meal({ cutoffAt: '2026-09-06T12:00:00Z' }) }), now), 'closed')
})

test('existující objednávka zobrazuje historickou unit_price', () => {
  const days = buildMealWeek({
    week, portionCategoryId: diner.portionCategoryId, meals: [meal()], orders: [order({ unitPrice: 63 })],
    priceRules: [{ id: 'price-1', portionCategoryId: diner.portionCategoryId, validFrom: '2026-09-01', validTo: null, price: 80, active: true }], lateRequests: [],
  })
  assert.equal(days[0].price, 63)
})

test('zrušená objednávka se znovu přihlásí za aktuálně platnou cenu', () => {
  const days = buildMealWeek({
    week, portionCategoryId: diner.portionCategoryId, meals: [meal()], orders: [order({ status: 'cancelled', unitPrice: 63 })],
    priceRules: [{ id: 'price-1', portionCategoryId: diner.portionCategoryId, validFrom: '2026-09-01', validTo: null, price: 80, active: true }], lateRequests: [],
  })
  assert.equal(days[0].price, 80)
})

test('nový den používá platnou historickou cenovou sazbu', () => {
  const rules = [
    { id: 'old', portionCategoryId: diner.portionCategoryId, validFrom: '2026-01-01', validTo: '2026-08-31', price: 60, active: true },
    { id: 'current', portionCategoryId: diner.portionCategoryId, validFrom: '2026-09-01', validTo: null, price: 70, active: true },
  ]
  assert.equal(applicablePrice(rules, diner.portionCategoryId, '2026-09-07'), 70)
})

test('adult diner i parent používají stejný objednávkový engine', async () => {
  const source = await readFile(new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url), 'utf8')
  assert.match(source, /role === 'parent'[\s\S]*role === 'diner'[\s\S]*<CafeteriaOrdering diners=\{data\.orderingDiners\}/)
})

test('launcher a hash cesta Úklidu zůstávají funkční', () => {
  const access = { cleaning: true, cafeteria: true, cafeteriaAvailable: true, cafeteriaRoles: ['parent'] }
  assert.equal(routeFromHash('#/cleaning'), 'cleaning')
  assert.equal(routeAllowed('cleaning', access), true)
})

test('cena bez pravidla není nula a běžná hromadná objednávka ji přeskočí', () => {
  assert.equal(applicablePrice([], diner.portionCategoryId, '2026-09-07'), null)
  assert.equal(bulkDayDecision(day({ price: null }), now), 'missing_price')
})
