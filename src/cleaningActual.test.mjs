import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { availabilityForDate, buildCleaningRecommendations, recommendedAlternatingPart } from './cleaningActual.ts'

const task = (overrides = {}) => ({ id: crypto.randomUUID(), roomId: 'room-1', room: 'Společenská místnost', floorId: 'floor-1', floor: '1. patro', floorSort: 1, buildingId: 'school', building: 'Škola', title: 'Vytřít', activityType: 'mop', frequency: 'denně', assignedTo: '', done: false, dueToday: true, sortOrder: 1, scheduleDays: [1, 3, 5], active: true, ...overrides })
const planning = { planningWorkers: [{ id: 'dana', name: 'Dana', linkedProfileId: 'profile-dana', active: true }, { id: 'olga', name: 'Olga', active: true }, { id: 'martina', name: 'Martina', active: true }], assignments: [
  { id: 'a1', workerId: 'dana', workerName: 'Dana', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-1', areaLabel: '1. patro', weekdays: [1, 3, 5], validFrom: '2026-09-01', active: true },
  { id: 'a2', workerId: 'olga', workerName: 'Olga', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-2', areaLabel: '2. patro', weekdays: [1, 3, 5], validFrom: '2026-09-01', active: true },
  { id: 'a3', workerId: 'martina', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-3', areaLabel: '3. + 4. patro', weekdays: [1, 3], validFrom: '2026-09-01', active: true },
], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: true }
const areas = [
  { id: 'area-1', workerId: 'dana', workerName: 'Dana', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-1', areaCode: 'main', title: '1. patro', visitsPerWeek: 3, rotationMode: 'none', alwaysIncludeWc: false, validFrom: '2026-09-01', active: true },
  { id: 'area-2', workerId: 'olga', workerName: 'Olga', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-2', areaCode: 'main', title: '2. patro', visitsPerWeek: 3, rotationMode: 'alternating_ab', alwaysIncludeWc: true, validFrom: '2026-09-01', active: true },
  { id: 'area-3', workerId: 'martina', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-3', areaCode: 'main', title: '3. + 4. patro', visitsPerWeek: 2, rotationMode: 'history', alwaysIncludeWc: false, validFrom: '2026-09-01', active: true },
]

test('Dana dostane doporučení pouze ze své stálé oblasti 1. patra', () => {
  const result = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'dana', tasks: [task(), task({ roomId: 'room-2', room: 'Učebna', floorId: 'floor-2', floor: '2. patro' })], planning, areas, records: [] })
  assert.deepEqual(result.map((item) => item.title), ['Společenská místnost'])
})

test('Olga má při každé směně WC a A/B je pouze doporučení', () => {
  const result = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'olga', tasks: [task({ roomId: 'wc', room: 'WC dívky', floorId: 'floor-2', floor: '2. patro' }), task({ roomId: 'class', room: 'Učebna 1', floorId: 'floor-2', floor: '2. patro' })], planning, areas, records: [] })
  assert.equal(result.length, 2)
  assert.ok(result.every((item) => ['A', 'B'].includes(item.recommendedPart)))
  assert.ok(result.some((item) => /Doporučená část/.test(item.reason)))
})

test('Martina dostane 3. patro i serverem přidělenou týdenní práci ve 4. patře', () => {
  const result = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'martina', tasks: [
    task({ roomId: 'third', room: 'Ateliér', floorId: 'floor-3', floor: '3. patro' }),
    task({ roomId: 'fourth', room: 'Mediační místnost', floorId: 'floor-4', floor: '4. patro', plannerReason: 'weekly-special', plannerAssignedWorkerId: 'martina' }),
  ], planning, areas, records: [] })
  assert.deepEqual(result.map((item) => item.title).sort(), ['Ateliér', 'Mediační místnost'])
  assert.match(result.find((item) => item.title === 'Mediační místnost').reason, /Přidělená týdenní/)
})

test('A/B doporučení se střídá přes Po/St/Pá a pokračuje další týden', () => {
  assert.equal(recommendedAlternatingPart('2026-09-02', '2026-09-01', [1, 3, 5]), 'A')
  assert.equal(recommendedAlternatingPart('2026-09-04', '2026-09-01', [1, 3, 5]), 'B')
  assert.equal(recommendedAlternatingPart('2026-09-07', '2026-09-01', [1, 3, 5]), 'A')
  assert.equal(recommendedAlternatingPart('2026-09-09', '2026-09-01', [1, 3, 5]), 'B')
})

test('obsazená a vynechaná společenská místnost má příště vysokou prioritu bez hodnocení pracovníka', () => {
  const records = [{ id: 'r1', workDate: '2026-09-07', workerId: 'dana', recordedBy: 'admin', recordedByName: 'Správce', buildingId: 'school', buildingName: 'Škola', floorId: 'floor-1', roomId: 'room-1', roomName: 'Společenská místnost', category: 'routine', outcome: 'skipped', skipReason: 'occupied', label: 'Běžný úklid', note: '', occurredAt: '2026-09-07T18:00:00Z', active: true }]
  const [result] = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'dana', tasks: [task()], planning, areas, records })
  assert.equal(result.priority, 'high'); assert.match(result.reason, /obsazeno/)
})

test('kompletní úklid schodů sníží bezprostřední prioritu', () => {
  const stairTask = task({ roomId: 'stairs', room: 'Schodiště', floorId: 'stairs-floor', floor: 'Schodiště' })
  const area = { ...areas[0], floorId: null, title: 'Škola' }
  const records = [{ id: 'r2', workDate: '2026-09-09', workerId: 'dana', recordedBy: 'admin', recordedByName: 'Správce', buildingId: 'school', buildingName: 'Škola', roomId: 'stairs', roomName: 'Schodiště', category: 'frequency', outcome: 'completed', label: 'Schody', note: '', occurredAt: '2026-09-09T18:00:00Z', active: true }]
  const [result] = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'dana', tasks: [stairTask], planning, areas: [area], records })
  assert.equal(result.priority, 'low')
})

test('absence, přesun a zástup mění skutečně dostupné osoby bez dvojího započítání', () => {
  const changes = [
    { id: 'x1', workerId: 'dana', workerName: 'Dana', date: '2026-09-09', status: 'absent', note: '', active: true, createdAt: '', createdBy: '' },
    { id: 'x2', workerId: 'martina', workerName: 'Martina', date: '2026-09-09', status: 'substitute', substitutesForWorkerId: 'dana', note: '', active: true, createdAt: '', createdBy: '' },
  ]
  const result = availabilityForDate('2026-09-09', planning, changes)
  assert.equal(new Set(result.map((item) => item.workerId)).size, result.length)
  assert.ok(result.some((item) => item.workerId === 'martina'))
  assert.ok(!result.some((item) => item.workerId === 'dana'))
})

test('Google blokace prostoru zvýší prioritu, ale chyba/absence Google dat doporučení nerozbije', () => {
  const blocked = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'dana', tasks: [task()], planning, areas, records: [], blockedRoomIds: new Set(['room-1']) })[0]
  const fallback = buildCleaningRecommendations({ date: '2026-09-09', workerId: 'dana', tasks: [task()], planning, areas, records: [] })[0]
  assert.equal(blocked.blockedByCalendar, true); assert.ok(fallback)
})

test('migrace je additivní, backfilluje historii a zápis cizí práce povoluje jen správci', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260910071257_cleaning_recommendations_and_actual_work.sql', import.meta.url), 'utf8')
  assert.match(sql, /insert into public\.cleaning_actual_records[\s\S]*from public\.cleaning_completions/)
  assert.match(sql, /if not public\.is_admin\(\) and linked is distinct from actor/)
  assert.match(sql, /source_schedule_exception_id/)
  assert.match(sql, /admin_save_planning_worker_schedule_exception/)
  assert.doesNotMatch(sql, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i)
})

test('UI nabízí dávkový záznam, důvody vynechání, detail a historii', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  for (const value of ['Co se skutečně uklidilo', 'Běžný úklid hotov', 'Neuděláno', '+ Přidat další práci', 'Obsazeno', 'Poslední zapsaný úklid']) assert.match(app, new RegExp(value.replace('+', '\\+')))
})
