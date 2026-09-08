import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { insertLegacyOrder, legacyApplySql } from '../scripts/lib/cafeteriaLegacyApply.mjs'
import {
  extractMenuColors, extractOrderCells, IMPORT_STATUSES, isAuxiliaryOrderRow, matchDiner, matchVariant, normalizeFontColor, parseLegacyQuantity, planImport,
} from '../scripts/lib/cafeteriaLegacyImport.mjs'

const diner = { id: 'd1', full_name: 'Anna Testovací', portion_category_id: 'small' }
const day = { id: 'day1', meal_date: '2026-09-07' }
const variants = [
  { id: 'v1', meal_day_id: 'day1', name: 'Sushi', active: true, sort_order: 10 },
  { id: 'v2', meal_day_id: 'day1', name: 'Rizoto', active: true, sort_order: 20 },
]
const database = { diners: [diner], mealDays: [day], variants, orders: [], priceRules: [{ portion_category_id: 'small', valid_from: '2026-09-01', valid_to: null, price: 70, active: true }] }
const source = (overrides = {}) => ({ mealDate: '2026-09-07', sourceParts: ['Testovací', 'Anna'], sourceName: 'Testovací Anna', value: 1, quantity: 1, quantityKind: 'order', color: '00AA00', ...overrides })

test('legacy quantity podporuje 0, 1 a 2', () => {
  assert.equal(parseLegacyQuantity(0).kind, 'none')
  assert.deepEqual(parseLegacyQuantity(1), { kind: 'order', quantity: 1 })
  assert.deepEqual(parseLegacyQuantity(2), { kind: 'order', quantity: 2 })
})

test('záporná, desetinná a příliš velká quantity je invalid', () => {
  for (const value of [-1, 1.5, 11, 'abc']) assert.equal(parseLegacyQuantity(value).kind, 'invalid')
})

test('RGB a ARGB barva textu se normalizují stejně', () => {
  assert.equal(normalizeFontColor({ argb: 'FF00aa00' }), '00AA00')
  assert.equal(normalizeFontColor({ argb: '00AA00' }), '00AA00')
})

test('XLSX čte datum z hlavičky, quantity a text color bez pevné pozice sloupce', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27'); const orders = workbook.addWorksheet('ZÁŘÍ_2026')
  menu.getCell('F2').value = new Date(2026, 8, 7); menu.getCell('F3').value = 'Sushi'; menu.getCell('F3').font = { color: { argb: 'FF00AA00' } }
  orders.getCell('G4').value = new Date(2026, 8, 7); orders.getCell('A5').value = 'Testovací'; orders.getCell('B5').value = 'Anna'; orders.getCell('G5').value = 2; orders.getCell('G5').font = { color: { argb: '00AA00' } }
  assert.deepEqual(extractMenuColors(menu).get('2026-09-07'), [{ name: 'Sushi', color: '00AA00' }])
  assert.deepEqual(extractOrderCells(orders)[0], { mealDate: '2026-09-07', sourceParts: ['Testovací', 'Anna'], sourceName: 'Testovací Anna', value: 2, quantity: 2, quantityKind: 'order', color: '00AA00' })
})

test('pomocné cenové a návštěvní řádky se do objednávek vůbec nezařadí', () => {
  const workbook = new ExcelJS.Workbook(); const orders = workbook.addWorksheet('ZÁŘÍ_2026')
  orders.getCell('D4').value = 1; orders.getCell('E4').value = 2; orders.getCell('F4').value = 3
  orders.getCell('A5').value = '80'; orders.getCell('B5').value = 'Kč (velký oběd - od 8. třídy + dospělí)'; orders.getCell('D5').value = 1
  orders.getCell('A6').value = '75'; orders.getCell('B6').value = 'návštěvy platí škola - malé'; orders.getCell('D6').value = 1
  orders.getCell('A7').value = 'Testovací'; orders.getCell('B7').value = 'Anna'; orders.getCell('D7').value = 2

  assert.equal(isAuxiliaryOrderRow(['80', 'Kč (velký oběd)']), true)
  assert.equal(isAuxiliaryOrderRow(['75', 'návštěvy platí škola - malé']), true)
  assert.deepEqual(extractOrderCells(orders).map((row) => [row.sourceName, row.quantity]), [['Testovací Anna', 2]])
})

test('neznámé jméno se pomocným filtrem neztratí a zůstane UNMATCHED_DINER', () => {
  assert.equal(isAuxiliaryOrderRow(['Neznámý', 'Člověk']), false)
  const result = planImport([source({ sourceParts: ['Neznámý', 'Člověk'], sourceName: 'Neznámý Člověk' })], database, new Map())
  assert.equal(result[0].status, IMPORT_STATUSES.UNMATCHED_DINER)
})

test('měsíční list odvodí plná data z českého názvu a číselné hlavičky', () => {
  for (const sheetName of ['ZÁŘÍ_2026', 'ZARI_2026', 'Září 2026']) {
    const workbook = new ExcelJS.Workbook(); const orders = workbook.addWorksheet(sheetName)
    orders.getCell('D4').value = 1; orders.getCell('E4').value = 2; orders.getCell('F4').value = 3
    orders.getCell('A5').value = 'Testovací'; orders.getCell('B5').value = 'Anna'
    orders.getCell('D5').value = 1; orders.getCell('E5').value = 2
    orders.getCell('E5').font = { color: { argb: 'FF00AA00' } }

    assert.deepEqual(extractOrderCells(orders).map((row) => ({ mealDate: row.mealDate, quantity: row.quantity, color: row.color })), [
      { mealDate: '2026-09-01', quantity: 1, color: null },
      { mealDate: '2026-09-02', quantity: 2, color: '00AA00' },
    ])
  }
})

test('číselná hlavička odmítne den, který v daném měsíci neexistuje', () => {
  const workbook = new ExcelJS.Workbook(); const orders = workbook.addWorksheet('DUBEN_2026')
  orders.getCell('D4').value = 1; orders.getCell('E4').value = 2; orders.getCell('F4').value = 31
  assert.throws(() => extractOrderCells(orders), /Neplatný den 31/i)
})

test('číselná hlavička bez bezpečně rozpoznatelného měsíce a roku se odmítne', () => {
  const workbook = new ExcelJS.Workbook(); const orders = workbook.addWorksheet('OBJEDNÁVKY')
  orders.getCell('D4').value = 1; orders.getCell('E4').value = 2; orders.getCell('F4').value = 3
  assert.throws(() => extractOrderCells(orders), /Měsíc a rok nelze bezpečně určit/i)
})

test('čísla mimo souvislou rostoucí hlavičku se nepovažují za datumové sloupce', () => {
  const workbook = new ExcelJS.Workbook(); const orders = workbook.addWorksheet('ZÁŘÍ_2026')
  orders.getCell('A2').value = 70; orders.getCell('D2').value = 1; orders.getCell('H2').value = 4; orders.getCell('L2').value = 9
  orders.getCell('A4').value = 80; orders.getCell('D4').value = 1; orders.getCell('E4').value = 2; orders.getCell('F4').value = 3
  orders.getCell('A5').value = 'Testovací'; orders.getCell('B5').value = 'Anna'; orders.getCell('D5').value = 1
  assert.deepEqual(extractOrderCells(orders).map((row) => row.mealDate), ['2026-09-01'])
})

test('svislý jídelníček čte datum z B a jednu variantu z C stejného řádku', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27')
  menu.getCell('B12').value = new Date(2026, 8, 7); menu.getCell('C12').value = '1 - Sushi'; menu.getCell('C12').font = { color: { argb: 'FF00AA00' } }
  assert.deepEqual(extractMenuColors(menu).get('2026-09-07'), [{ name: 'Sushi', color: '00AA00' }])
})

test('svislý rich text rozdělí více variant podle jednoznačných barevných úseků', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27')
  menu.getCell('B12').value = new Date(2026, 8, 7)
  menu.getCell('C12').value = { richText: [
    { text: '1-Sushi', font: { color: { argb: 'FF00AA00' } } },
    { text: ', 1-Rizoto', font: { color: { argb: 'FF000000' } } },
  ] }
  assert.deepEqual(extractMenuColors(menu).get('2026-09-07'), [
    { name: 'Sushi', color: '00AA00' },
    { name: 'Rizoto', color: '000000' },
  ])
  assert.equal(matchVariant(variants, extractMenuColors(menu).get('2026-09-07'), '00AA00').id, 'v1')
})

test('vodorovný jídelníček zůstává podporovaný', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27')
  menu.getCell('F2').value = new Date(2026, 8, 7); menu.getCell('G2').value = new Date(2026, 8, 8)
  menu.getCell('F3').value = 'Sushi'; menu.getCell('F3').font = { color: { argb: 'FF00AA00' } }
  menu.getCell('G3').value = 'Polévka'; menu.getCell('G3').font = { color: { argb: 'FF000000' } }
  assert.deepEqual(extractMenuColors(menu).get('2026-09-07'), [{ name: 'Sushi', color: '00AA00' }])
  assert.deepEqual(extractMenuColors(menu).get('2026-09-08'), [{ name: 'Polévka', color: '000000' }])
})

test('svislý vícevariantový den bez jednoznačné barevné hranice zůstane ambiguous', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27')
  menu.getCell('B12').value = new Date(2026, 8, 7)
  menu.getCell('C12').value = { richText: [
    { text: '1-Sushi, ', font: { color: { argb: 'FF00AA00' } } },
    { text: '1-Rizoto', font: { color: { argb: 'FF00AA00' }, bold: true } },
  ] }
  const colors = extractMenuColors(menu)
  assert.equal(colors.get('2026-09-07').length, 1)
  assert.equal(planImport([source()], database, colors)[0].status, IMPORT_STATUSES.AMBIGUOUS_VARIANT)
})

test('různé odstíny barvy se neslučují a vyžadují přesnou shodu', () => {
  const workbook = new ExcelJS.Workbook(); const menu = workbook.addWorksheet('JÍDELNÍČEK 26_27')
  menu.getCell('B12').value = new Date(2026, 8, 7)
  menu.getCell('C12').value = { richText: [
    { text: '1-Sushi', font: { color: { argb: 'FF00AA00' } } },
    { text: ', 1-Rizoto', font: { color: { argb: 'FF00AB00' } } },
  ] }
  const colors = extractMenuColors(menu).get('2026-09-07')
  assert.deepEqual(colors.map((variant) => variant.color), ['00AA00', '00AB00'])
  assert.equal(matchVariant(variants, colors, '00AA80'), null)
})

test('single variant lze přiřadit bez barvy', () => {
  assert.equal(matchVariant([variants[0]], [], null).id, 'v1')
})

test('varianty se mapují podle barvy zvlášť pro konkrétní den', () => {
  const menu = [{ name: 'Úplně jiný text první varianty', color: '00AA00' }, { name: 'Jiný text druhé varianty', color: '000000' }]
  assert.equal(matchVariant(variants, menu, '00AA00').id, 'v1')
  const reversed = [{ name: 'První položka', color: '000000' }, { name: 'Druhá položka', color: '00AA00' }]
  assert.equal(matchVariant(variants, reversed, '00AA00').id, 'v2')
})

test('DB varianty se párují podle jednoznačného sort_order, ne vstupního pořadí nebo textu', () => {
  const reversedDatabase = [variants[1], variants[0]]
  const menu = [{ name: 'První menu text', color: 'AA0000' }, { name: 'Druhý menu text', color: '000000' }]
  assert.equal(matchVariant(reversedDatabase, menu, 'AA0000').id, 'v1')
  assert.equal(matchVariant(reversedDatabase, menu, '000000').id, 'v2')
})

test('nejednoznačné pořadí nebo rozdílný počet variant se odmítne', () => {
  const menu = [{ name: 'První', color: 'AA0000' }, { name: 'Druhá', color: '000000' }]
  assert.equal(matchVariant([{ ...variants[0], sort_order: 10 }, { ...variants[1], sort_order: 10 }], menu, 'AA0000'), null)
  assert.equal(matchVariant(variants, [menu[0]], 'AA0000'), null)
})

test('neexistuje globální mapování červená=maso a nejasná barva se odmítne', () => {
  assert.equal(matchVariant(variants, [{ name: 'Sushi', color: 'FF0000' }, { name: 'Rizoto', color: 'FF0000' }], 'FF0000'), null)
  assert.equal(matchVariant(variants, [], null), null)
})

test('diner match je přesný a řeší pořadí příjmení/jména a mezery', () => {
  assert.equal(matchDiner(['Testovací ', ' Anna'], [diner]).id, 'd1')
  assert.equal(matchDiner(['Jiná', 'Anna'], [diner]), null)
})

test('plán rozlišuje CREATE, quantity 2, existing a unmatched', () => {
  const colors = new Map([['2026-09-07', [{ name: 'Sushi', color: '00AA00' }, { name: 'Rizoto', color: '000000' }]]])
  assert.equal(planImport([source({ value: 2, quantity: 2 })], database, colors)[0].status, IMPORT_STATUSES.CREATE)
  assert.equal(planImport([source()], { ...database, orders: [{ diner_id: 'd1', meal_day_id: 'day1' }] }, colors)[0].status, IMPORT_STATUSES.SKIP_ALREADY_EXISTS)
  assert.equal(planImport([source({ sourceParts: ['Nikdo', 'Neznámý'] })], database, colors)[0].status, IMPORT_STATUSES.UNMATCHED_DINER)
})

test('missing meal day a ambiguous variant se nezapisují', () => {
  assert.equal(planImport([source()], { ...database, mealDays: [] }, new Map())[0].status, IMPORT_STATUSES.MEAL_DAY_NOT_FOUND)
  assert.equal(planImport([source({ color: null })], database, new Map())[0].status, IMPORT_STATUSES.AMBIGUOUS_VARIANT)
})

test('quantity migrace používá sum(quantity) a rozsah 1 až 10', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260906165639_cafeteria_order_quantity_support.sql', import.meta.url), 'utf8')
  assert.match(sql, /quantity between 1 and 10/i)
  assert.match(sql, /sum\(quantity\)::integer as cutoff_count/i)
  assert.match(sql, /sum\(quantity\)::integer as current_count/i)
  assert.doesNotMatch(sql, /new\.quantity := 1/)
})

test('parent a kitchen UI zobrazí quantity 2× a service RPC ji vrací', async () => {
  const parent = await readFile(new URL('./cafeteria/CafeteriaOrdering.tsx', import.meta.url), 'utf8')
  const kitchen = await readFile(new URL('./cafeteria/CafeteriaKitchen.tsx', import.meta.url), 'utf8')
  const sql = await readFile(new URL('../supabase/migrations/20260906165639_cafeteria_order_quantity_support.sql', import.meta.url), 'utf8')
  assert.match(parent, /day\.order\.quantity > 1/)
  assert.match(kitchen, /order\.quantity > 1/)
  assert.match(sql, /diner_name text, quantity smallint/)
})

test('importer je defaultně dry-run a apply je explicitní transakce', async () => {
  const cli = await readFile(new URL('../scripts/import-cafeteria-orders.mjs', import.meta.url), 'utf8')
  assert.match(cli, /args\.includes\('--apply'\)/)
  assert.match(cli, /begin read only/)
  assert.match(cli, /await client\.query\('rollback'\)/)
  assert.match(cli, /await client\.query\('commit'\)/)
  assert.match(cli, /SKIP_ALREADY_EXISTS/)
  assert.match(cli, /select v\.id, v\.meal_day_id, v\.name, v\.active, v\.sort_order/i)
  assert.match(cli, /order by d\.meal_date, v\.sort_order, v\.id/i)
})

function legacyApplyClient({ cutoffPassed }) {
  const queries = []
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values })
      if (/insert into public\.cafeteria_orders/i.test(sql)) return { rows: [{ id: 'imported-order-1' }] }
      return { rows: [{ event_id: 'event-1', actor_source: 'system', cutoff_passed: cutoffPassed, snapshot_adjusted: cutoffPassed }] }
    },
  }
}

test('APPLY po cutoffu přesune právě vytvořený system event do syntetického cutoff snapshotu', async () => {
  const client = legacyApplyClient({ cutoffPassed: true })
  const result = await insertLegacyOrder(client, { diner, mealDay: day, variant: variants[0], quantity: 2 })

  assert.deepEqual(result, { orderId: 'imported-order-1', cutoffPassed: true, snapshotAdjusted: true })
  assert.deepEqual(client.queries[1].values, ['imported-order-1'])
  assert.match(legacyApplySql.snapshotEvent, /e\.order_id = \$1 and e\.event_type = 'ordered'/i)
  assert.match(legacyApplySql.snapshotEvent, /actor_source = 'system'/i)
  assert.match(legacyApplySql.snapshotEvent, /cutoff_at <= now\(\)/i)
  assert.match(legacyApplySql.snapshotEvent, /occurred_at = imported_event\.cutoff_at - interval '1 second'/i)
})

test('APPLY před cutoffem ponechá čas právě vytvořeného eventu beze změny', async () => {
  const client = legacyApplyClient({ cutoffPassed: false })
  const result = await insertLegacyOrder(client, { diner, mealDay: day, variant: variants[0], quantity: 1 })

  assert.deepEqual(result, { orderId: 'imported-order-1', cutoffPassed: false, snapshotAdjusted: false })
  assert.match(legacyApplySql.snapshotEvent, /and imported_event\.cutoff_passed/i)
  assert.doesNotMatch(legacyApplySql.snapshotEvent, /set actor_source/i)
})

test('hardening migrace je synchronizována pod produkční verzí', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260906140331_cafeteria_data_integrity_hardening.sql', import.meta.url), 'utf8')
  assert.match(sql, /cafeteria_diners_account_family_fkey/)
  assert.match(sql, /cafeteria_price_rules_no_active_overlap/)
})
