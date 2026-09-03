import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260903003700_spread_weekly_responsibilities_across_shifts.sql', import.meta.url), 'utf8')

test('Více je rozdělené do pěti lidských skupin bez vloženého databázového editoru', () => {
  for (const label of ['LIDÉ A PRÁCE', 'PLÁN ÚKLIDU', 'PROSTORY', 'MANUÁL', 'ÚČTY A PŘÍSTUPY']) assert.match(app, new RegExp(label))
  const more = app.match(/function MoreScreen[\s\S]*?function DpcSettings/)?.[0] ?? ''
  assert.doesNotMatch(more, /<WorkplaceSettings|<DppLimitSetting|<DpcSettings/)
  assert.match(app, /section === "Lidé a práce"/)
  assert.match(app, /section === "Plán úklidu"/)
  assert.match(app, /section === "Prostory"/)
})

test('Lidé a práce otevírá detail osoby se všemi provozními vrstvami', () => {
  for (const label of ['PRACOVNÍ PLÁN', 'TÝDENNÍ POVINNOSTI', 'VÝJIMKY', 'PRACOVNÍ VZTAHY', 'PLÁNOVÁNÍ DOCHÁZKY']) assert.match(app, new RegExp(label))
  assert.match(app, /Pokročilé \/ záložní nastavení/)
  assert.match(app, /A\/B\/C je pouze záložní pořadí/)
  assert.match(app, /Plánovaný počet směn týdně/)
  assert.match(app, /Pracovníci v rozpisu jsou samostatně v části Lidé a práce a účet mít nemusí/)
})

test('mobilní detail osoby drží plnou šířku a 44px ovládání', () => {
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.person-detail-header/)
  assert.match(css, /\.person-duty-list button \{[^}]*min-height: 44px/)
  assert.match(css, /\.person-exception-list > button \{[^}]*width: 100%/)
})

// Stejná priorita jako v 03700: nejdřív dosud nepoužitá směna osoby,
// potom menší celková zátěž, vyšší počet lidí a nakonec stabilní datum.
const distribute = (shifts, duties) => {
  const used = new Map(shifts.map((shift) => [shift.date, 0]))
  return duties.map(() => {
    const selected = [...shifts].sort((a, b) => (used.get(a.date) - used.get(b.date)) || a.load - b.load || b.workers - a.workers || a.date.localeCompare(b.date))[0]
    used.set(selected.date, used.get(selected.date) + 1)
    return selected.date
  })
}

test('dvě týdenní povinnosti a dvě směny se rozloží na různé dny', () => {
  assert.deepEqual(distribute([{ date: '2026-09-07', load: 0, workers: 2 }, { date: '2026-09-10', load: 2, workers: 2 }], [{ key: '4F', dueFrom: '2026-09-07' }, { key: 'stairs', dueFrom: '2026-09-01' }]), ['2026-09-07', '2026-09-10'])
})

test('při jediné směně zůstávají obě povinnosti bezpečně v jediném dostupném dni', () => {
  assert.deepEqual(distribute([{ date: '2026-09-07', load: 0, workers: 2 }], [{ key: '4F', dueFrom: '2026-09-07' }, { key: 'stairs', dueFrom: '2026-09-01' }]), ['2026-09-07', '2026-09-07'])
})

test('změna pracovních dnů automaticky změní dostupné dny bez hardcodu Martiny', () => {
  assert.deepEqual(distribute([{ date: '2026-09-08', load: 1, workers: 2 }, { date: '2026-09-11', load: 0, workers: 2 }], ['4F', 'stairs']), ['2026-09-11', '2026-09-08'])
  assert.doesNotMatch(migration, /Martina|display_name\s*=/i)
})

test('03700 je atomická, nedestruktivní a rozkládá povinnosti bez vazby na shodné due_from', () => {
  const plannerFunction = migration.slice(0, migration.indexOf('revoke all on function'))
  assert.match(migration, /(?:^|\n)begin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.doesNotMatch(migration, /(?:^|\n)\s*(?:delete\s+from|truncate|drop\s+table)\b/i)
  assert.match(migration, /worker_responsibility_count[\s\S]*load_units[\s\S]*worker_count/)
  assert.match(migration, /order by generated_day\.worker_responsibility_count,[\s\S]*generated_day\.load_units/)
  assert.match(migration, /generated_day\.load_units, generated_day\.worker_count desc, generated_day\.plan_date/)
  assert.doesNotMatch(plannerFunction, /used\.due_from\s*=\s*duty\.due_from/)
  assert.match(migration, /not exists \([\s\S]*public\.cleaning_completions/)
})
