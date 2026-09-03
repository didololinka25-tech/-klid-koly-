import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDynamicSchoolPlan } from './dynamicCleaningPlanner.ts'
import { weeklyResponsibilitiesForDate, workersForDate } from './workerPlanning.ts'

const migration = readFileSync(new URL('../supabase/migrations/20260903003500_weekly_responsibilities_and_confirmed_operations.sql', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')

const assignment = (workerId, workerName, weekdays) => ({
  id: `${workerId}-${weekdays.join('')}`, workerId, workerName, buildingId: 'school', buildingName: 'Škola',
  areaLabel: 'Pracovní oblast', weekdays, validFrom: '2026-09-01', validTo: null, active: true,
})
const planning = (weekdays = [1, 4], includeSecondWorker = false) => ({
  planningWorkers: [
    { id: 'martina', name: 'Martina', active: true },
    ...(includeSecondWorker ? [{ id: 'didi', name: 'Didi', active: true }] : []),
  ],
  assignments: [
    assignment('martina', 'Martina', weekdays),
    ...(includeSecondWorker ? [assignment('didi', 'Didi', weekdays)] : []),
  ], exceptions: [], rotationDefinitions: [], rotationSlots: [],
  weeklyResponsibilities: [
    { id: 'fourth', responsibilityKey: 'school-fourth-floor', workerId: 'martina', workerName: 'Martina', validFrom: '2026-08-31', validTo: null, active: true },
    { id: 'stairs', responsibilityKey: 'school-stairs', workerId: 'martina', workerName: 'Martina', validFrom: '2026-08-31', validTo: null, active: true },
  ], available: true,
})

const task = (id, overrides = {}) => ({
  id, roomId: id, room: 'Prostor', floor: '1. patro', floorSort: 1, buildingId: 'school', building: 'Škola',
  title: id, activityType: 'vacuum', frequency: 'denně', assignedTo: '', done: false, dueToday: true,
  sortOrder: 1, scheduleDays: [1, 2, 3, 4, 5, 6, 7], active: true, ...overrides,
})

test('Martina má dvě směny a týdenní 4F + Schodiště nezávislé na konkrétních dnech', () => {
  const first = planning([1, 4])
  assert.equal(['2026-09-07', '2026-09-10'].flatMap((date) => workersForDate(date, first)).length, 2)
  assert.deepEqual(weeklyResponsibilitiesForDate('2026-09-07', first).map((item) => item.responsibilityKey), ['school-fourth-floor', 'school-stairs'])
  const changedDays = planning([2, 5])
  assert.equal(['2026-09-08', '2026-09-11'].flatMap((date) => workersForDate(date, changedDays)).length, 2)
  assert.deepEqual(weeklyResponsibilitiesForDate('2026-09-07', changedDays).map((item) => item.responsibilityKey), ['school-fourth-floor', 'school-stairs'])
})

test('týdenní povinnost je UUID model s RLS, admin RPC a plannerem omezeným na směny osoby', () => {
  assert.match(migration, /create table if not exists public\.cleaning_weekly_worker_responsibilities/i)
  assert.match(migration, /planning_worker_id uuid references public\.planning_workers\(id\)/i)
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /if not public\.is_admin\(\)/i)
  assert.match(migration, /is_planning_worker_scheduled_at_school\(duty\.planning_worker_id/i)
  assert.doesNotMatch(migration, /is_planning_worker_scheduled_at_school\(duty\.planning_worker_id[\s\S]{0,180}worker_count_for_date\([^)]*\)\s*>=\s*2/i)
  assert.match(migration, /assigned_planning_worker_id/i)
  assert.doesNotMatch(migration, /where[^;]*display_name\s*=\s*'Martina'/i)
  assert.match(repository, /admin_set_cleaning_weekly_responsibility/)
  assert.match(app, /TÝDENNÍ ÚKOLY PRACOVNÍKŮ/)
  assert.match(app, /Splnit během libovolných směn v týdnu\./)
})

test('Výtah je jedna týdenní small práce bez pevného dne', () => {
  assert.match(migration, /plan_key='v2026\|school\|elevator\|weekly'/i)
  assert.match(migration, /'Uklidit výtah','surfaces','weekly'/i)
  assert.match(migration, /array\[1,2,3,4,5,6,7\]::smallint\[\]/i)
  const plan = buildDynamicSchoolPlan({
    startDate: '2026-09-07', endDate: '2026-09-13',
    planning: { ...planning([1, 4], true), weeklyResponsibilities: [] },
    tasks: [
      task('floor'),
      task('elevator', { room: 'Výtah', floor: 'Výtah', floorSort: 6, title: 'Uklidit výtah', activityType: 'surfaces', frequency: 'týdně' }),
    ],
  })
  const occurrences = [...plan.values()].flatMap((day) => day.tasks).filter((item) => item.task.id === 'elevator')
  assert.equal(occurrences.length, 1)
  assert.equal(occurrences[0].size, 'small')
})

test('2F má čtyři učebny a původní pátý prostor se přejmenuje bez duplicitní místnosti', () => {
  assert.match(migration, /room\.name='Učebna 5'/i)
  assert.match(migration, /set name='Společná místnost před učebnami'/i)
  assert.match(migration, /2f-common-before-classrooms\|carpet-vacuum/i)
  assert.match(migration, /2f-common-before-classrooms\|carpet-deep/i)
  assert.match(migration, /period_months=3/i)
  assert.match(migration, /Učebna 1','Učebna 2','Učebna 3','Učebna 4'/i)
  assert.doesNotMatch(migration, /insert into public\.rooms[\s\S]{0,250}Společná místnost před učebnami/i)
})

test('výlevka je idempotentně otevřená závada a nikdy nový cleaning task', () => {
  assert.match(migration, /insert into public\.incidents/i)
  assert.match(migration, /Nefunguje splachovadlo výlevky/i)
  assert.match(migration, /not exists[\s\S]*public\.incidents/i)
  assert.doesNotMatch(migration, /cleaning_tasks\([^)]*\)[\s\S]{0,250}Nefunguje splachovadlo výlevky/i)
})

test('Manuál a Školka zůstávají beze změny a migrace nemaže historii', () => {
  assert.doesNotMatch(migration, /manual_entries/i)
  assert.doesNotMatch(migration, /Školka/i)
  assert.doesNotMatch(migration, /delete\s+from|truncate|drop\s+table/i)
  assert.match(migration, /(?:^|\n)begin;/i)
  assert.match(migration, /commit;\s*$/i)
  for (const field of ['Co potřebuji', 'Jak postupovat', 'Na co si dát pozor', 'Poznámka školy']) assert.match(app, new RegExp(field))
})
