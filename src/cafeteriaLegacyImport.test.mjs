import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  extractMenuColors, extractOrderCells, IMPORT_STATUSES, matchDiner, matchVariant, normalizeFontColor, parseLegacyQuantity, planImport,
} from '../scripts/lib/cafeteriaLegacyImport.mjs'

const diner = { id: 'd1', full_name: 'Anna Testovací', portion_category_id: 'small' }
const day = { id: 'day1', meal_date: '2026-09-07' }
const variants = [
  { id: 'v1', meal_day_id: 'day1', name: 'Sushi', active: true },
  { id: 'v2', meal_day_id: 'day1', name: 'Rizoto', active: true },
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

test('single variant lze přiřadit bez barvy', () => {
  assert.equal(matchVariant([variants[0]], [], null).id, 'v1')
})

test('varianty se mapují podle barvy zvlášť pro konkrétní den', () => {
  const menu = [{ name: 'Sushi', color: '00AA00' }, { name: 'Rizoto', color: '000000' }]
  assert.equal(matchVariant(variants, menu, '00AA00').id, 'v1')
  const reversed = [{ name: 'Sushi', color: '000000' }, { name: 'Rizoto', color: '00AA00' }]
  assert.equal(matchVariant(variants, reversed, '00AA00').id, 'v2')
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
})

test('hardening migrace je synchronizována pod produkční verzí', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260906140331_cafeteria_data_integrity_hardening.sql', import.meta.url), 'utf8')
  assert.match(sql, /cafeteria_diners_account_family_fkey/)
  assert.match(sql, /cafeteria_price_rules_no_active_overlap/)
})
