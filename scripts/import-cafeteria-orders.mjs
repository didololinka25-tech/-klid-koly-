#!/usr/bin/env node
import ExcelJS from 'exceljs'
import pg from 'pg'
import { insertLegacyOrder } from './lib/cafeteriaLegacyApply.mjs'
import { extractMenuColors, extractOrderCells, IMPORT_STATUSES, planImport } from './lib/cafeteriaLegacyImport.mjs'

const MENU_SHEET = 'JÍDELNÍČEK 26/27'
const ORDERS_SHEET = 'ZÁŘÍ_2026'
const args = process.argv.slice(2)
const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null }
const file = valueAfter('--file')
const apply = args.includes('--apply')
if (!file || (apply && args.includes('--dry-run'))) {
  console.error('Použití: node scripts/import-cafeteria-orders.mjs --file "/cesta/obed.xlsx" [--dry-run | --apply]')
  process.exitCode = 2
} else await run()

async function run() {
  const connectionString = process.env.SUPABASE_DB_URL
  if (!connectionString) throw new Error('Nastavte SUPABASE_DB_URL. Hodnota se nikdy nevypisuje ani neukládá do repozitáře.')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const menuSheet = findWorksheet(workbook, MENU_SHEET); const ordersSheet = findWorksheet(workbook, ORDERS_SHEET)
  if (!menuSheet || !ordersSheet) throw new Error(`XLSX musí obsahovat listy „${MENU_SHEET}“ a „${ORDERS_SHEET}“.`)
  const sourceRows = extractOrderCells(ordersSheet); const menuColors = extractMenuColors(menuSheet)
  const dates = [...new Set(sourceRows.map((row) => row.mealDate))].sort()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query(apply ? 'begin' : 'begin read only')
    const database = await loadDatabase(client, dates)
    const plan = planImport(sourceRows, database, menuColors)
    printReport(plan, database.diners.length, apply)
    if (apply) {
      for (const item of plan.filter((row) => row.status === IMPORT_STATUSES.CREATE)) {
        await insertLegacyOrder(client, item)
      }
      await client.query('commit')
      console.log(`Zapsáno ${plan.filter((row) => row.status === IMPORT_STATUSES.CREATE).length} objednávek v jedné transakci.`)
    } else {
      await client.query('rollback')
      console.log('DRY-RUN: do databáze nebylo nic zapsáno.')
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally { await client.end() }
}

function findWorksheet(workbook, exactName) {
  const exact = workbook.getWorksheet(exactName)
  if (exact) return exact
  // XLSX itself forbids '/' in sheet names; Google export can replace it with '_'.
  const key = (value) => value.normalize('NFC').replace(/[\/_]/g, '').trim().toLocaleUpperCase('cs-CZ')
  const matches = workbook.worksheets.filter((sheet) => key(sheet.name) === key(exactName))
  return matches.length === 1 ? matches[0] : undefined
}

async function loadDatabase(client, dates) {
  if (!dates.length) return { diners: [], mealDays: [], variants: [], orders: [], priceRules: [] }
  const [diners, days, variants, orders, prices] = await Promise.all([
    client.query('select id, full_name, portion_category_id from public.cafeteria_diners where active'),
    client.query("select id, meal_date::text from public.cafeteria_meal_days where meal_date between $1 and $2 and status = 'published'", [dates[0], dates.at(-1)]),
    client.query('select v.id, v.meal_day_id, v.name, v.active from public.cafeteria_meal_variants v join public.cafeteria_meal_days d on d.id=v.meal_day_id where d.meal_date between $1 and $2', [dates[0], dates.at(-1)]),
    client.query('select o.diner_id, o.meal_day_id from public.cafeteria_orders o join public.cafeteria_meal_days d on d.id=o.meal_day_id where d.meal_date between $1 and $2', [dates[0], dates.at(-1)]),
    client.query('select portion_category_id, valid_from::text, valid_to::text, price, active from public.cafeteria_price_rules where valid_from <= $2 and (valid_to is null or valid_to >= $1)', [dates[0], dates.at(-1)]),
  ])
  return { diners: diners.rows, mealDays: days.rows, variants: variants.rows, orders: orders.rows, priceRules: prices.rows }
}

function printReport(plan, dinerCount, applyMode) {
  const count = (status) => plan.filter((row) => row.status === status).length
  console.log(`${dinerCount} strávníků v databázi`)
  console.log(`${plan.length} neprázdných objednávkových buněk ve zdroji`)
  console.log(`${count(IMPORT_STATUSES.CREATE)} objednávek připraveno k importu`)
  console.log(`${plan.filter((row) => row.quantity === 2).length} objednávky quantity=2`)
  for (const status of Object.values(IMPORT_STATUSES)) console.log(`${status}: ${count(status)}`)
  for (const row of plan.filter((item) => ![IMPORT_STATUSES.CREATE, IMPORT_STATUSES.SKIP_ALREADY_EXISTS].includes(item.status))) {
    console.log(`${row.status} | ${row.mealDate} | ${row.sourceName} | hodnota=${String(row.value)} | barva=${row.color ?? 'nezjištěna'} | ${row.reason}`)
  }
  console.log(`Režim: ${applyMode ? 'APPLY' : 'DRY-RUN'}`)
}
