import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildCalendarDaySummary, filterSchoolCalendarEvents, schoolCalendarEventOccursOn } from './cleaningCalendar.ts'
import { resolveCleaningDay } from './scheduling.ts'

const schoolEvent = {
  id: 'event-1', externalId: 'school-year:test', title: 'Školní akce',
  description: 'Pouze informace.', start: '2026-09-04', end: '2026-09-07',
  allDay: true, source: 'school-information', affectedBuildingId: 'school', collisionKind: 'none',
}

test('vícedenní školní akce používá exkluzivní konec a nevstupuje do úklidového plánu', () => {
  assert.equal(schoolCalendarEventOccursOn(schoolEvent, '2026-09-04'), true)
  assert.equal(schoolCalendarEventOccursOn(schoolEvent, '2026-09-06'), true)
  assert.equal(schoolCalendarEventOccursOn(schoolEvent, '2026-09-07'), false)
  const summary = buildCalendarDaySummary({
    date: '2026-09-05', today: '2026-09-01', tasks: [],
    context: resolveCleaningDay('2026-09-05', []), schoolEvents: [schoolEvent],
  })
  assert.deepEqual(summary.schoolEvents.map((event) => event.title), ['Školní akce'])
  assert.equal(summary.tasks.length, 0)
  assert.equal(summary.workBlocks.length, 0)
})

test('filtr pracoviště zobrazí školní akci jen u Školy', () => {
  assert.equal(filterSchoolCalendarEvents([schoolEvent], 'school').length, 1)
  assert.equal(filterSchoolCalendarEvents([schoolEvent], 'kindergarten').length, 0)
  assert.equal(filterSchoolCalendarEvents([schoolEvent], 'all').length, 1)
})

test('migrace 04200 ukládá všech 30 potvrzených akcí read-only a nedotýká se planneru', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260906004200_school_calendar_information_events.sql', import.meta.url), 'utf8')
  const seededKeys = [...migration.matchAll(/\('school-year-2026-27:[^']+'/g)].map((match) => match[0])
  assert.equal(new Set(seededKeys).size, 30)
  assert.match(migration, /create table if not exists public\.school_calendar_events/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /grant select on table public\.school_calendar_events to authenticated/)
  assert.match(migration, /revoke all privileges on table public\.school_calendar_events from public, anon, authenticated/)
  assert.match(migration, /Není běžný provoz školy\. Úklid se automaticky neruší\./)
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) public\.(?:cleaning_tasks|cleaning_completions|cleaning_planner_occurrences|worker_work_assignments)/i)
})

test('Kalendář načítá informační akce jednou za interval a vykreslí je odděleně od změn úklidu', async () => {
  const app = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
  const repository = await readFile(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
  assert.match(repository, /schoolInformationEvents:[\s\S]*from\('school_calendar_events'\)/)
  assert.match(repository, /\.lte\('starts_on', to\)[\s\S]*\.gte\('ends_on', from\)/)
  assert.match(app, /schoolRepository\.schoolInformationEvents\(\{ from: gridDates\[0\], to: gridDates\[gridDates\.length - 1\] \}\)/)
  assert.match(app, /className="calendar-school-event-badge">AKCE/)
  assert.match(app, /className="calendar-school-events"/)
  assert.match(app, /ŠKOLNÍ AKCE/)
  assert.match(app, /Informace · úklid se automaticky nemění/)
})
