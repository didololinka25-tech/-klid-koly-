import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildMenuWeek } from './cafeteria/menuModel.ts'

const week = { start: '2026-09-07', end: '2026-09-11' }
const meal = (overrides = {}) => ({
  id: 'day-1', mealDate: '2026-09-08', cutoffAt: '2026-09-07T12:00:00Z', status: 'published', note: 'Poznámka dne',
  variants: [{ id: 'variant-1', mealDayId: 'day-1', name: 'Jídlo A', note: 'Poznámka varianty', sortOrder: 10 }],
  ...overrides,
})

test('parent navigace obsahuje Obědy, Jídelníček, Platby a Rodina v tomto pořadí', async () => {
  const source = await readFile(new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url), 'utf8')
  assert.match(source, /role === 'parent' \? \['Obědy', 'Jídelníček', 'Platby', 'Rodina'\]/)
})

test('admin a kitchen navigace zůstávají beze změny', async () => {
  const source = await readFile(new URL('./cafeteria/CafeteriaApp.tsx', import.meta.url), 'utf8')
  assert.match(source, /role === 'kitchen' \? \['Dnes', 'Výdej', 'Jídelníček', 'Žádosti'\]/)
  assert.match(source, /\['Přehled', 'Jídelníček', 'Lidé', 'Finance', 'Více'\]/)
})

test('read-only jídelníček skládá vždy karty pondělí až pátek', () => {
  const days = buildMenuWeek([meal()], week)
  assert.deepEqual(days.map((day) => day.mealDate), ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'])
  assert.equal(days[1].meal?.variants[0].name, 'Jídlo A')
  assert.equal(days[0].meal, null)
})

test('zrušený den zachová cancelled stav pro text Nevaří se / Volno', async () => {
  const days = buildMenuWeek([meal({ status: 'cancelled' })], week)
  const source = await readFile(new URL('./cafeteria/CafeteriaMenu.tsx', import.meta.url), 'utf8')
  assert.equal(days[1].meal?.status, 'cancelled')
  assert.match(source, /Nevaří se \/ Volno/)
})

test('menu načítá týden dávkově, pouze aktivní varianty a bez zápisových akcí', async () => {
  const repository = await readFile(new URL('./cafeteria/cafeteriaRepository.ts', import.meta.url), 'utf8')
  const source = await readFile(new URL('./cafeteria/CafeteriaMenu.tsx', import.meta.url), 'utf8')
  assert.match(repository, /loadMenuWeek: \(week: WeekRange\) => loadMeals\(false, week\)/)
  assert.match(repository, /cafeteria_meal_variants[\s\S]*\.eq\('active', true\)/)
  assert.match(repository, /\.gte\('meal_date', week\.start\)\.lte\('meal_date', week\.end\)/)
  assert.match(source, /variant\.name[\s\S]*variant\.note[\s\S]*meal\.note/)
  assert.doesNotMatch(source, /createOrder|updateOrder|Objednat|Odhlásit|Uložit/)
})

test('Vaří se nezobrazuje bez odpovídajícího údaje v současném modelu', async () => {
  const types = await readFile(new URL('./cafeteria/types.ts', import.meta.url), 'utf8')
  const source = await readFile(new URL('./cafeteria/CafeteriaMenu.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(types.match(/export type MealDay =[^\n]+/)?.[0] ?? '', /cook|chef|prepared/i)
  assert.doesNotMatch(source, /Vaří:/)
})
