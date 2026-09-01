import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extraActivityTypes,
  floorPresentationKind,
  isExtraCleaningTask,
  isStandardCleaningTask,
  roomIsComplete,
  roomPresentationLabel,
  roomPresentationState,
  summarizeCleaningDay,
} from './cleaningPresentation.ts'
import { isTaskDueForCleaningDay, resolveCleaningDay } from './scheduling.ts'

const task = (overrides = {}) => ({
  id: crypto.randomUUID(), roomId: 'room-1', room: 'Jídelna', floor: '1. patro', floorSort: 1,
  buildingId: 'school', building: 'Škola', title: 'Běžný úklid', activityType: 'vacuum',
  frequency: 'denně', assignedTo: 'Úklidový tým', done: false, dueToday: true,
  sortOrder: 10, scheduleDays: [1, 3, 5], active: true,
  ...overrides,
})

const due = (tasks, date, records = []) => tasks.filter((item) => isTaskDueForCleaningDay({
  id: item.id,
  frequency: item.frequency,
  schedule_days: item.scheduleDays,
  monthly_day: item.monthlyDay,
  cleaning_cycle_length: item.cleaningCycleLength,
  cleaning_cycle_offset: item.cleaningCycleOffset,
  period_months: item.periodMonths,
  period_week: item.periodWeek,
  period_anchor_month: item.periodAnchorMonth,
}, resolveCleaningDay(date, records.filter((record) => record.buildingId === item.buildingId))))

test('běžná práce a rotace patra zůstávají STANDARD, periodické práce jsou DNES NAVÍC', () => {
  const standard = task()
  const rotation = task({ cleaningCycleLength: 2, cleaningCycleOffset: 0 })
  const weekly = task({ frequency: 'týdně', activityType: 'tables' })
  const monthly = task({ frequency: 'měsíčně', activityType: 'windows', periodMonths: 1, periodWeek: 2 })
  assert.equal(isStandardCleaningTask(standard), true)
  assert.equal(isStandardCleaningTask(rotation), true)
  assert.equal(floorPresentationKind([rotation]), 'rotation')
  assert.equal(isExtraCleaningTask(weekly), true)
  assert.equal(isExtraCleaningTask(monthly), true)
  assert.deepEqual(extraActivityTypes([standard, weekly, monthly]), ['tables', 'windows'])
})

test('souhrn dne počítá místnosti, ne mikroúkoly, a zachová obě pracoviště', () => {
  const input = [
    task({ id: 'a', done: true }),
    task({ id: 'b', activityType: 'mop', done: true }),
    task({ id: 'c', roomId: 'room-2', room: 'Kuchyň' }),
    task({ id: 'd', roomId: 'kg-room', room: 'Vstup', floor: 'Prostory', floorSort: 1, buildingId: 'kg', building: 'Školka', scheduleDays: [2] }),
  ]
  const summary = summarizeCleaningDay(input)
  assert.equal(summary.length, 2)
  assert.equal(summary.find((item) => item.name === 'Škola').roomCount, 2)
  assert.equal(summary.find((item) => item.name === 'Škola').completedRoomCount, 1)
  assert.equal(summary.find((item) => item.name === 'Školka').roomCount, 1)
})

test('místnost je hotová až po dokončení všech dnešních relevantních úkolů', () => {
  assert.equal(roomIsComplete([task({ done: true }), task({ frequency: 'měsíčně', activityType: 'windows', done: false })]), false)
  assert.equal(roomIsComplete([task({ done: true }), task({ frequency: 'měsíčně', activityType: 'windows', done: true })]), true)
})

test('karta místnosti rozlišuje nedokončený, částečný, hotový a pouze extra stav bez taskových počtů', () => {
  const routine = [task({ id: 'routine-a' }), task({ id: 'routine-b' })]
  assert.equal(roomPresentationLabel(roomPresentationState(routine, routine)), 'Běžný úklid')
  const partial = [task({ id: 'routine-a', done: true }), task({ id: 'routine-b' })]
  assert.equal(roomPresentationLabel(roomPresentationState(partial, partial)), 'Běžný úklid · část hotová')
  const done = routine.map((item) => ({ ...item, done: true }))
  assert.equal(roomPresentationLabel(roomPresentationState(done, done)), 'Hotovo')
  const extra = [task({ frequency: 'měsíčně', activityType: 'windows' })]
  assert.equal(roomPresentationLabel(roomPresentationState(extra, [])), 'Práce navíc')
})

test('souhrn stejného resolveru ukáže 1F + střídající se 2F/3F a páteční 4F se schodištěm', () => {
  const plan = [
    task({ id: '1f', floor: '1. patro', roomId: '1f-room' }),
    task({ id: '2f', floor: '2. patro', floorSort: 2, roomId: '2f-room', cleaningCycleLength: 2, cleaningCycleOffset: 0 }),
    task({ id: '3f', floor: '3. patro', floorSort: 3, roomId: '3f-room', cleaningCycleLength: 2, cleaningCycleOffset: 1 }),
    task({ id: '4f', floor: '4. patro', floorSort: 4, roomId: '4f-room', frequency: 'týdně', scheduleDays: [5] }),
    task({ id: 'stairs', floor: 'Schodiště', floorSort: 5, roomId: 'stairs-room', frequency: 'týdně', scheduleDays: [5] }),
  ]
  assert.deepEqual(summarizeCleaningDay(due(plan, '2026-08-31'))[0].floors.map((floor) => [floor.name, floor.kind]), [['1. patro', 'standard'], ['2. patro', 'rotation']])
  assert.deepEqual(summarizeCleaningDay(due(plan, '2026-09-02'))[0].floors.map((floor) => [floor.name, floor.kind]), [['1. patro', 'standard'], ['3. patro', 'rotation']])
  assert.deepEqual(summarizeCleaningDay(due(plan, '2026-09-04'))[0].floors.map((floor) => floor.name), ['1. patro', '2. patro', '4. patro', 'Schodiště'])
})

test('úterní souhrn ukáže Školku a výjimka je odvozena stejným resolverem', () => {
  const kindergarten = task({ id: 'kg', building: 'Školka', buildingId: 'kg', floor: 'Prostory', roomId: 'kg-room', scheduleDays: [2] })
  assert.equal(summarizeCleaningDay(due([kindergarten], '2026-09-01'))[0].name, 'Školka')
  const saturday = due([kindergarten], '2026-09-05', [{ id: 'extra', buildingId: 'kg', kind: 'extraordinary', executionDate: '2026-09-05', title: 'Mimořádný úklid', status: 'active' }])
  assert.equal(saturday.length, 1)
})

test('UI používá místnost jako hlavní jednotku a jednotlivé úkoly nechává sbalené', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(source, /✓ Hotovo/)
  assert.match(source, /› Podrobnosti/)
  assert.match(source, /Vrátit dokončení místnosti/)
  assert.match(source, /today-extras/)
  assert.match(source, /DNES NAVÍC/)
  assert.match(source, /compact-task-list/)
  assert.doesNotMatch(source, /běžných hotovo/)
  assert.doesNotMatch(source, /className="room-floor"/)
})

test('detail používá skutečný název prerequisite a nikoli technickou obecnou hlášku', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(source, /`Nejdřív \$\{prerequisiteTask\.title\.toLocaleLowerCase\("cs-CZ"\)\}`/)
  assert.doesNotMatch(source, /Nejdříve předchozí činnost/)
})

test('kalendář a Dnes sdílejí scheduling resolver a kalendář nezobrazuje běžný checklist', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(source, /function dueTasksForDate[\s\S]*isTaskDueForCleaningDay/)
  assert.match(source, /dueToday/)
  assert.match(source, /Běžný úklid probíhá podle pracovního rozdělení/)
  assert.match(source, /DNES NAVÍC/)
  assert.doesNotMatch(source, /Zobrazit celý plán dne/)
  assert.match(source, /calendar-filter/)
})

test('mobilní redesign drží touch targety a na desktopu rozšíří měsíční mřížku', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /@media \(max-width: 430px\)/)
  assert.match(css, /\.room-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /\.room-primary-action \.complete-room,[\s\S]*min-height: 46px/)
  assert.match(css, /\.room-group:has\(\.room-detail-toggle\[aria-expanded="true"\]\) \{ grid-column: 1 \/ -1; \}/)
  assert.match(css, /\.compact-task-list[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /@media \(min-width: 800px\)[\s\S]*\.app:has\(\.cleaning-calendar\)/)
  assert.match(css, /\.app:has\(\.building-task-group\) \.room-list \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(css, /overflow-x: hidden/)
})

test('Dnes vede přímo od docházky přes práci navíc k místnostem', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const today = source.match(/\{section === "Dnes"[\s\S]*?\{section === "Správa"/)?.[0] ?? ''
  assert.doesNotMatch(today, /className=\{visible\.length > 0[\s\S]*?hero today-overview/)
  assert.doesNotMatch(today, /today-work-overview/)
  assert.match(today, /<TodayExtras tasks=\{todayExtras\}/)
  assert.ok(today.indexOf('<TodayExtras') < today.indexOf('<TaskHierarchy'))
  assert.ok(today.indexOf('<TaskHierarchy') < today.indexOf('<DepartureChecks'))
  assert.doesNotMatch(source, /Co jsem dnes udělal\/a|Vyberte místnosti a uložte je najednou|ShiftRoomCompletion/)
  assert.match(source, /Otevřená WC fronta/)
  assert.match(source, /povinných místností/)
  assert.doesNotMatch(source, /místností · \{floorKindLabel/)
  assert.doesNotMatch(source, /className="room-today-extra"/)
})
