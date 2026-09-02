import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCalendarDaySummary, calendarWorkerOptions, circledFloor, filterCalendarTasks } from './cleaningCalendar.ts'
import { isTaskDueForCleaningDay, monthGridDates, resolveCleaningDay } from './scheduling.ts'

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

test('měsíční mřížka má vždy 6 týdnů Po–Ne pro únor, 30/31 dní i přechod roku', () => {
  for (const month of ['2026-02', '2026-04', '2026-08', '2026-12', '2027-01']) {
    const dates = monthGridDates(month)
    assert.equal(dates.length, 42)
    assert.equal(new Date(`${dates[0]}T12:00:00Z`).getUTCDay(), 1)
    assert.equal(new Date(`${dates[41]}T12:00:00Z`).getUTCDay(), 0)
  }
  assert.equal(monthGridDates('2026-02')[0], '2026-01-26')
  assert.equal(monthGridDates('2026-12')[0], '2026-11-30')
  assert.equal(monthGridDates('2026-12')[41], '2027-01-10')
})

test('filtr kalendáře obsahuje i aktivního plánovacího pracovníka bez účtu a bez období', () => {
  const planning = {
    planningWorkers: [
      { id: 'didi', name: 'Didi Ceridwen', linkedProfileId: 'profile-didi', active: true },
      { id: 'worker-2', name: 'Pracovník 2', linkedProfileId: null, active: true },
      { id: 'old', name: 'Neaktivní', linkedProfileId: null, active: false },
    ],
    assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: true,
  }
  assert.deepEqual(calendarWorkerOptions(planning).map((item) => item.id).sort(), ['didi', 'worker-2'])
})

test('summary ukáže Školu, 1F a skutečnou rotaci 2F/3F bez běžných mikroikon', () => {
  const plan = [
    task({ id: '1f', roomId: '1f' }),
    task({ id: '2f', roomId: '2f', room: 'Chodba', floor: '2. patro', floorSort: 2, cleaningCycleLength: 2, cleaningCycleOffset: 0 }),
    task({ id: '3f', roomId: '3f', room: 'Chodba', floor: '3. patro', floorSort: 3, cleaningCycleLength: 2, cleaningCycleOffset: 1 }),
  ]
  const mondayTasks = due(plan, '2026-08-31')
  const monday = buildCalendarDaySummary({ date: '2026-08-31', today: '2026-08-31', tasks: mondayTasks, context: resolveCleaningDay('2026-08-31', []) })
  assert.deepEqual(monday.workplaces.map((item) => [item.icon, item.name]), [['Š', 'Škola']])
  assert.deepEqual(monday.sections.map((item) => [item.marker, item.rotating]), [['1', false], ['2', true]])
  assert.equal(circledFloor(monday.rotatingSections[0].marker), '②')
  assert.deepEqual(monday.extraCategories, [])
  const wednesday = buildCalendarDaySummary({ date: '2026-09-02', today: '2026-08-31', tasks: due(plan, '2026-09-02'), context: resolveCleaningDay('2026-09-02', []) })
  assert.equal(wednesday.rotatingSections[0].marker, '3')
})

test('pátek agreguje 4F, Schodiště a praní bez taskových počtů v buňce', () => {
  const fridayTasks = [
    task({ floor: '1. patro' }),
    task({ floor: '4. patro', floorSort: 4, frequency: 'týdně', scheduleDays: [5] }),
    task({ floor: 'Schodiště', floorSort: 5, room: 'Schodiště', frequency: 'týdně', scheduleDays: [5] }),
    task({ roomId: undefined, room: 'Společné úkoly', floor: 'Společné', floorSort: 6, title: 'Vyprat hadry', activityType: 'laundry', frequency: 'týdně', scheduleDays: [5] }),
  ]
  const summary = buildCalendarDaySummary({ date: '2026-09-04', today: '2026-09-01', tasks: due(fridayTasks, '2026-09-04'), context: resolveCleaningDay('2026-09-04', []) })
  assert.ok(summary.sections.some((item) => item.marker === '4'))
  assert.ok(summary.sections.some((item) => item.staircase))
  assert.deepEqual(summary.extraCategories.map((item) => item.key), ['floors', 'staircase', 'laundry'])
})

test('každá práce navíc dostane čitelnou kategorii a v kalendáři se neztratí', () => {
  const date = '2026-09-04'
  const tasks = [
    task({ id: 'mirror', activityType: 'mirror', frequency: 'týdně', scheduleDays: [5], title: 'Vyčistit zrcadlo' }),
    task({ id: 'floor', activityType: 'vacuum', frequency: 'týdně', scheduleDays: [5], title: 'Vysát koberec' }),
    task({ id: 'unknown', activityType: 'other', frequency: 'týdně', scheduleDays: [5], title: 'Samostatná kontrola' }),
  ]
  const summary = buildCalendarDaySummary({ date, today: date, tasks: due(tasks, date), context: resolveCleaningDay(date, []) })
  assert.deepEqual(summary.extraCategories.map((item) => [item.key, item.label]), [
    ['mirrors', 'Zrcadla'], ['floors', 'Podlahy / koberce'], ['other', 'Další práce'],
  ])
})

test('Škola a Školka mohou být ve stejném dni a filtr pouze skryje druhé pracoviště', () => {
  const school = task({ id: 'school' })
  const kindergarten = task({ id: 'kg', buildingId: 'kg', building: 'Školka', floor: 'Prostory', roomId: 'kg-room', room: 'Kuchyň', scheduleDays: [2] })
  const tasks = [school, kindergarten]
  const summary = buildCalendarDaySummary({ date: '2026-09-01', today: '2026-09-01', tasks, context: resolveCleaningDay('2026-09-01', []) })
  assert.deepEqual(summary.workplaces.map((item) => item.icon), ['Š', 'MŠ'])
  assert.deepEqual(filterCalendarTasks(tasks, 'kg').map((item) => item.id), ['kg'])
  assert.equal(filterCalendarTasks(tasks, 'all').length, 2)
})

test('weekly, monthly a period_months práce se agregují po kategorii pouze jednou', () => {
  const date = '2026-09-01'
  const plan = [
    ...Array.from({ length: 12 }, (_, index) => task({ id: `window-${index}`, roomId: `room-${index}`, activityType: 'windows', frequency: 'měsíčně', monthlyDay: 1, scheduleDays: [] })),
    task({ id: 'tables', activityType: 'tables', frequency: 'týdně', scheduleDays: [2] }),
    task({ id: 'deep', activityType: 'deep_clean', frequency: 'měsíčně', scheduleDays: [2], periodMonths: 3, periodWeek: 1, periodAnchorMonth: '2026-09-01' }),
  ]
  const summary = buildCalendarDaySummary({ date, today: date, tasks: due(plan, date), context: resolveCleaningDay(date, []) })
  assert.deepEqual(summary.extraCategories.map((item) => item.key), ['windows', 'furniture', 'deep_clean'])
  assert.equal(summary.extraCategories.find((item) => item.key === 'windows').taskCount, 12)
})

test('mimořádný, přidaný, přesunutý a zrušený den používají skutečný resolver', () => {
  const standard = task({ id: 'standard' })
  const extra = { id: 'extra', buildingId: 'school', kind: 'extraordinary', executionDate: '2026-09-05', title: 'Generální úklid', status: 'active' }
  const addedTasks = due([standard], '2026-09-05', [extra])
  const addedContext = resolveCleaningDay('2026-09-05', [extra])
  const added = buildCalendarDaySummary({ date: '2026-09-05', today: '2026-09-01', tasks: addedTasks, context: addedContext, exceptions: [extra] })
  assert.equal(added.context.kind, 'extraordinary')
  assert.deepEqual(added.extraordinary, ['Generální úklid'])
  const moved = { id: 'move', buildingId: 'school', kind: 'rescheduled', sourceDate: '2026-09-04', executionDate: '2026-09-05', title: 'Přesun kvůli akci', status: 'active' }
  assert.equal(resolveCleaningDay('2026-09-04', [moved]).kind, 'moved_away')
  assert.equal(resolveCleaningDay('2026-09-05', [moved]).kind, 'rescheduled')
  const cancelled = { ...extra, status: 'cancelled' }
  assert.equal(due([standard], '2026-09-05', [cancelled]).length, 0)
  const cancelledSummary = buildCalendarDaySummary({ date: '2026-09-05', today: '2026-09-01', tasks: [], context: resolveCleaningDay('2026-09-05', [cancelled]), exceptions: [cancelled] })
  assert.deepEqual(cancelledSummary.cancelledExceptions, ['Generální úklid'])
})

test('Kalendář a Dnes dostanou pro stejné datum stejný resolved task universe', () => {
  const plan = [task({ id: 'a' }), task({ id: 'b', floor: '2. patro', cleaningCycleLength: 2, cleaningCycleOffset: 0 })]
  const resolved = due(plan, '2026-08-31')
  const calendar = buildCalendarDaySummary({ date: '2026-08-31', today: '2026-09-01', tasks: resolved, context: resolveCleaningDay('2026-08-31', []) })
  assert.deepEqual(calendar.tasks.map((item) => item.id), resolved.map((item) => item.id))
})

test('UI má 7 sloupců, today/selected/outside stavy, kompaktní legendu a žádné task counts v buňce', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const model = readFileSync(new URL('./cleaningCalendar.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/)
  assert.match(app, /summary\.isToday \? " today"/)
  assert.match(app, /selected \? " selected"/)
  assert.match(app, /outside \? " outside"/)
  assert.match(app, /className="calendar-today-button"/)
  assert.match(app, /function CalendarLegend/)
  assert.match(model, /schoolEvents: \[\]/)
  assert.doesNotMatch(app.slice(app.indexOf('function CalendarDayCell'), app.indexOf('function CalendarLegend')), /tasks\.length|úkolů/)
  assert.doesNotMatch(app.slice(app.indexOf('function CalendarDayCell'), app.indexOf('function CalendarLegend')), /summary\.sections|summary\.workplaces/)
})

test('kalendář propojí skutečný pracovní rozvrh s extra prací a skryje standardní práci', () => {
  const date = '2026-09-02'
  const planning = {
    available: true,
    assignments: [{ id: 'a', workerId: 'worker-dana', workerName: 'Dana Nováková', buildingId: 'school', buildingName: 'Škola', floorId: 'f1', floorName: '1. patro', areaLabel: '1. patro', weekdays: [1, 3, 5], validFrom: '2026-09-01', validTo: null, active: true }],
    exceptions: [],
  }
  const tasks = [
    task({ id: 'standard', title: 'Vytřít podlahu', activityType: 'mop' }),
    task({ id: 'windows', title: 'Umýt okna', activityType: 'windows', frequency: 'měsíčně', monthlyDay: 2, scheduleDays: [] }),
  ]
  const summary = buildCalendarDaySummary({ date, today: date, tasks: due(tasks, date), context: resolveCleaningDay(date, []), planning })
  assert.equal(summary.workers.length, 1)
  assert.equal(summary.workers[0].workerId, 'worker-dana')
  assert.equal(summary.workers[0].initials, 'DN')
  assert.deepEqual(summary.extraCategories.map((item) => item.key), ['windows'])
  assert.deepEqual(summary.extraCategories.map((item) => [item.symbol, item.label]), [['OK', 'Okna / skla']])
})

test('month cell používá textové extra labely, omezení pracovníků a žádné emoji ikony', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const model = readFileSync(new URL('./cleaningCalendar.ts', import.meta.url), 'utf8')
  const cell = app.slice(app.indexOf('function CalendarDayCell'), app.indexOf('function CalendarLegend'))
  const detail = app.slice(app.indexOf('function CalendarDayDetail'), app.indexOf('function CleaningCalendar'))
  assert.match(cell, /summary\.workers\.slice\(0, 2\)/)
  assert.match(cell, /summary\.workers\.length - 2/)
  assert.match(cell, /category\.label/)
  assert.match(cell, /category\.symbol/)
  assert.match(detail, /category\.scopes\.map/)
  assert.doesNotMatch(cell, /\p{Extended_Pictographic}/u)
  assert.doesNotMatch(model, /\p{Extended_Pictographic}/u)
})

test('kalendář má čitelné mobilní a desktop varianty bez horizontálního přetečení', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.calendar-day \{ min-height: 88px/)
  assert.match(css, /\.calendar-extras-mobile \{ display: grid/)
  assert.match(css, /@media \(min-width: 800px\)[\s\S]*\.calendar-extras-desktop \{ display: grid/)
  assert.match(css, /\.calendar-day \{ min-width: 0;[\s\S]*overflow: hidden/)
  assert.match(css, /text-overflow: ellipsis/)
})

test('filtr pracovníka spojí UUID, pracovní oblast, pracoviště a jeho rotační 4. patro', () => {
  const date = '2026-09-04'
  const planning = {
    available: true,
    assignments: [
      { id: 'd', workerId: 'didi-uuid', workerName: 'Didi', buildingId: 'school', buildingName: 'Škola', floorId: 'f1', floorName: '1. patro', areaLabel: '1. patro', weekdays: [5], validFrom: '2026-09-01', validTo: null, active: true },
      { id: 'm', workerId: 'martina-uuid', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: 'f2', floorName: '2. patro', areaLabel: '2. patro', weekdays: [5], validFrom: '2026-09-01', validTo: null, active: true },
    ],
    exceptions: [],
    rotationDefinitions: [{ rotationKey: 'school-fourth-floor', title: '4. patro', anchorDate: date, weekday: 5, slotCount: 3, active: true }],
    rotationSlots: [{ id: 'slot-a', rotationKey: 'school-fourth-floor', slotIndex: 0, workerId: 'didi-uuid', workerName: 'Didi', validFrom: date, validTo: null, active: true }],
  }
  const tasks = [
    task({ id: 'didi-extra', floorId: 'f1', floor: '1. patro', activityType: 'doors', frequency: 'měsíčně', monthlyDay: 4, scheduleDays: [] }),
    task({ id: 'martina-extra', floorId: 'f2', floor: '2. patro', activityType: 'tiles', frequency: 'měsíčně', monthlyDay: 4, scheduleDays: [] }),
    task({ id: 'fourth', floorId: 'f4', floor: '4. patro', activityType: 'vacuum', frequency: 'týdně', scheduleDays: [5] }),
  ]
  const didi = buildCalendarDaySummary({ date, today: date, tasks, context: resolveCleaningDay(date, []), planning, workerId: 'didi-uuid' })
  assert.deepEqual(didi.workers.map((item) => item.workerId), ['didi-uuid'])
  assert.deepEqual(didi.tasks.map((item) => item.id).sort(), ['didi-extra','fourth'])
  assert.equal(didi.fourthFloorRotation?.assignment?.workerId, 'didi-uuid')
  const martina = buildCalendarDaySummary({ date, today: date, tasks, context: resolveCleaningDay(date, []), planning, workerId: 'martina-uuid' })
  assert.deepEqual(martina.tasks.map((item) => item.id), ['martina-extra'])
  assert.equal(martina.fourthFloorRotation, null, 'pracovník nevidí cizí rotační 4. patro')
})
