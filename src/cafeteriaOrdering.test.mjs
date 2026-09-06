import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  applicablePrice, buildMealWeek, chooseDraftVariant, dinerWeekHeaderPrice, dinerWeekOrderCount,
  draftAllForDiner, effectiveChoice, isBeforeCutoff, lateRequestMessage, orderDraftChanges,
  orderDraftKey, toggleSingleVariant, weekDateKeys, weekForDate,
} from './cafeteria/orderingModel.ts'
import { routeAllowed, routeFromHash } from './system/access.ts'

const now = new Date('2026-09-07T08:00:00Z')
const week = weekForDate('2026-09-09')
const diner = (index = 1, type = 'child') => ({ id: `diner-${index}`, fullName: type === 'adult' ? 'Dospělý A' : `Dítě ${index}`, dinerType: type, profileId: type === 'adult' ? 'profile-1' : null, familyId: type === 'adult' ? null : 'family-1', accountId: `account-${index}`, portionCategoryId: 'portion-1', portionName: 'Malá porce' })
const variant = (index = 1, mealDayId = 'meal-1') => ({ id: `variant-${index}`, mealDayId, name: `Jídlo ${index}`, note: null, sortOrder: index * 10 })
const meal = (overrides = {}) => ({ id: 'meal-1', mealDate: '2026-09-07', cutoffAt: '2026-09-08T12:00:00Z', status: 'published', note: null, variants: [variant()], ...overrides })
const order = (overrides = {}) => ({ id: 'order-1', dinerId: 'diner-1', mealDayId: 'meal-1', mealVariantId: 'variant-1', accountId: 'account-1', portionCategoryId: 'portion-1', unitPrice: 70, status: 'ordered', orderedAt: '2026-09-01T10:00:00Z', cancelledAt: null, ...overrides })
const late = (overrides = {}) => ({ id: 'late-1', orderId: null, dinerId: 'diner-1', mealDayId: 'meal-1', requestType: 'add', requestedVariantId: 'variant-1', status: 'pending', billingOutcome: null, requestedAt: '2026-09-08T13:00:00Z', ...overrides })
const day = (overrides = {}) => ({ mealDate: '2026-09-07', meal: meal(), order: null, lateRequest: null, price: 70, ...overrides })
const dinerWeek = (person = diner(), days = [day()]) => ({ week, diner: person, days })
const familyWeek = (count = 1, daysFactory = () => [day()]) => {
  const diners = Array.from({ length: count }, (_, index) => diner(index + 1))
  return { week, diners, dinerWeeks: diners.map((person) => dinerWeek(person, daysFactory(person))) }
}

test('jeden strávník tvoří jeden sloupec mřížky', () => assert.equal(familyWeek(1).dinerWeeks.length, 1))
test('dva strávníci tvoří dva sloupce mřížky', () => assert.equal(familyWeek(2).dinerWeeks.length, 2))
test('čtyři a více strávníků zůstávají samostatné sloupce', () => assert.equal(familyWeek(5).dinerWeeks.length, 5))

test('týden obsahuje přesně pondělí až pátek', () => {
  assert.deepEqual(week, { start: '2026-09-07', end: '2026-09-11' })
  assert.deepEqual(weekDateKeys(week), ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'])
})

test('jedna varianta se ovládá jako lokální toggle', () => {
  const draft = toggleSingleVariant({}, diner().id, day())
  assert.deepEqual(effectiveChoice(day(), diner().id, draft), { ordered: true, variantId: 'variant-1' })
})

test('více variant vyžaduje explicitní výběr', () => {
  const multi = day({ meal: meal({ variants: [variant(1), variant(2)] }) })
  assert.deepEqual(effectiveChoice(multi, diner().id, {}), { ordered: false, variantId: null })
  assert.equal(Object.keys(chooseDraftVariant({}, diner().id, multi, null)).length, 0)
})

test('výběr podporuje tři a více obecných variant', () => {
  const multi = day({ meal: meal({ variants: [variant(1), variant(2), variant(3)] }) })
  const draft = chooseDraftVariant({}, diner().id, multi, 'variant-3')
  assert.deepEqual(effectiveChoice(multi, diner().id, draft), { ordered: true, variantId: 'variant-3' })
})

test('Vše připraví vhodný jedno-variantový den pouze pro jedno dítě', () => {
  const data = familyWeek(2)
  const draft = draftAllForDiner(data, 'diner-1', {}, now)
  assert.deepEqual(Object.keys(draft), [orderDraftKey('diner-1', 'meal-1')])
})

test('Vše přeskočí vícevariantový den', () => {
  const data = familyWeek(1, () => [day({ meal: meal({ variants: [variant(1), variant(2)] }) })])
  assert.deepEqual(draftAllForDiner(data, 'diner-1', {}, now), {})
})

test('Vše přeskočí den po uzávěrce', () => {
  const data = familyWeek(1, () => [day({ meal: meal({ cutoffAt: '2026-09-06T12:00:00Z' }) })])
  assert.deepEqual(draftAllForDiner(data, 'diner-1', {}, now), {})
})

test('kliknutí v mřížce mění pouze draft a nezapisuje před Uložit', async () => {
  const source = await readFile(new URL('./cafeteria/CafeteriaOrdering.tsx', import.meta.url), 'utf8')
  assert.match(source, /onToggle=.*setDraft/)
  assert.match(source, /saveChanges[\s\S]*saveOrderDraft/)
  assert.doesNotMatch(source, /onToggle=.*createOrder/)
})

test('Uložit změny sestaví více nezávislých změn', () => {
  const data = familyWeek(2)
  let draft = toggleSingleVariant({}, 'diner-1', data.dinerWeeks[0].days[0])
  draft = toggleSingleVariant(draft, 'diner-2', data.dinerWeeks[1].days[0])
  assert.equal(orderDraftChanges(data, draft).length, 2)
})

test('repository pokračuje po jedné chybě další změnou', async () => {
  const source = await readFile(new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url), 'utf8')
  assert.match(source, /for \(const change of changes\)[\s\S]*try \{[\s\S]*result\.saved \+= 1[\s\S]*catch \(error\)[\s\S]*result\.failed\.push/)
})

test('draft odhlášení vytvoří cancel akci', () => {
  const orderedDay = day({ order: order() })
  const data = familyWeek(1, () => [orderedDay])
  const draft = toggleSingleVariant({}, 'diner-1', orderedDay)
  assert.equal(orderDraftChanges(data, draft)[0].action, 'cancel')
})

test('zrušená objednávka vytvoří reorder akci', () => {
  const cancelledDay = day({ order: order({ status: 'cancelled' }) })
  const data = familyWeek(1, () => [cancelledDay])
  const draft = toggleSingleVariant({}, 'diner-1', cancelledDay)
  assert.equal(orderDraftChanges(data, draft)[0].action, 'reorder')
})

test('změna vybrané varianty vytvoří change_variant akci', () => {
  const multi = day({ meal: meal({ variants: [variant(1), variant(2)] }), order: order() })
  const data = familyWeek(1, () => [multi])
  const draft = chooseDraftVariant({}, 'diner-1', multi, 'variant-2')
  assert.equal(orderDraftChanges(data, draft)[0].action, 'change_variant')
})

test('existující objednávka zachovává historickou unit_price', () => {
  const days = buildMealWeek({ week, portionCategoryId: 'portion-1', meals: [meal()], orders: [order({ unitPrice: 63 })], priceRules: [{ id: 'price-1', portionCategoryId: 'portion-1', validFrom: '2026-09-01', validTo: null, price: 80, active: true }], lateRequests: [] })
  assert.equal(days[0].price, 63)
})

test('jednotná cena se v hlavičce zobrazí, proměnlivá nikoli', () => {
  assert.equal(dinerWeekHeaderPrice(dinerWeek(diner(), [day(), day({ mealDate: '2026-09-08', meal: meal({ id: 'meal-2', mealDate: '2026-09-08' }) })])), 70)
  assert.equal(dinerWeekHeaderPrice(dinerWeek(diner(), [day(), day({ mealDate: '2026-09-08', meal: meal({ id: 'meal-2', mealDate: '2026-09-08' }), price: 80 })])), null)
})

test('pending pozdní žádost má lidský stav', () => assert.equal(lateRequestMessage(late()), '⏳ Čeká na potvrzení'))

test('výsledky pozdního storna zachovávají české účtovací texty', () => {
  assert.equal(lateRequestMessage(late({ requestType: 'cancel', status: 'approved', billingOutcome: 'charged' })), 'Oběd byl odhlášen, ale bude účtován.')
  assert.equal(lateRequestMessage(late({ requestType: 'cancel', status: 'approved', billingOutcome: 'not_charged' })), '✅ Oběd byl odhlášen bez účtování.')
})

test('po cutoff není běžná editace otevřená', () => {
  assert.equal(isBeforeCutoff(day({ meal: meal({ cutoffAt: '2026-09-06T12:00:00Z' }) }), now), false)
})

test('týdenní souhrn počítá i aktuální draft', () => {
  const data = dinerWeek()
  const draft = toggleSingleVariant({}, data.diner.id, data.days[0])
  assert.equal(dinerWeekOrderCount(data, draft), 1)
})

test('adult diner používá stejnou rodinnou mřížku s jedním sloupcem', async () => {
  const adultWeek = familyWeek(1); adultWeek.diners[0] = diner(1, 'adult'); adultWeek.dinerWeeks[0].diner = adultWeek.diners[0]
  assert.equal(adultWeek.dinerWeeks.length, 1)
  const source = await readFile(new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url), 'utf8')
  assert.match(source, /role === 'parent'[\s\S]*role === 'diner'[\s\S]*<CafeteriaOrdering/)
})

test('rodinný týden se načítá dávkově pro seznam diner ID', async () => {
  const source = await readFile(new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url), 'utf8')
  assert.match(source, /loadFamilyMealWeek[\s\S]*\.in\('diner_id', dinerIds\)/)
  assert.doesNotMatch(source, /for \(const diner of diners\)[\s\S]*from\('cafeteria_orders'\)/)
})

test('mřížka má sticky hlavičku, sticky první sloupec a touch ovládání', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /family-order-grid thead th[\s\S]*position: sticky[\s\S]*top: 0/)
  assert.match(css, /family-order-grid \.meal-column[\s\S]*position: sticky[\s\S]*left: 0/)
  assert.match(css, /grid-order-cell > button[\s\S]*min-height: 64px/)
})

test('mobilní šířky 360, 390 a 430 px používají posuvnou mřížku bez zmenšení touch buněk', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /family-grid-scroll[\s\S]*overflow: auto/)
  assert.match(css, /family-order-grid[\s\S]*width: max-content/)
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*min-width: 116px/)
  assert.match(css, /@media \(min-width: 430px\)[\s\S]*min-width: 132px/)
})

test('neuložené změny jsou chráněné při změně týdne, sekce i launcheru', async () => {
  const ordering = await readFile(new URL('./cafeteria/CafeteriaOrdering.tsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url), 'utf8')
  assert.match(ordering, /Máte neuložené změny\. Zahodit je\?/)
  assert.match(app, /confirmDiscard[\s\S]*leaveForLauncher/)
})

test('launcher zůstává dostupný přes původní hash cestu', () => assert.equal(routeFromHash('#/cafeteria'), 'cafeteria'))

test('Úklid zůstává povolený a jeho hash cesta beze změny', () => {
  const access = { cleaning: true, cafeteria: true, cafeteriaAvailable: true, cafeteriaRoles: ['parent'] }
  assert.equal(routeFromHash('#/cleaning'), 'cleaning')
  assert.equal(routeAllowed('cleaning', access), true)
})

test('chybějící cenové pravidlo zůstává null, nikoli nula', () => assert.equal(applicablePrice([], 'portion-1', '2026-09-07'), null))
