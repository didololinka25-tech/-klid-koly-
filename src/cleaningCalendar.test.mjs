import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCalendarDaySummary, calendarDayCellScope, calendarPrintDay, calendarWorkerOptions, circledFloor, filterCalendarTasks, projectDynamicSchoolPlan } from './cleaningCalendar.ts'
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
  assert.deepEqual(summary.workBlocks.map((item) => [item.building, item.blocks[0]?.title]), [['Škola', 'Podlahy – 1. patro'], ['Školka', 'Úklid – Prostory']])
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

test('filtr pracovníka zachová sdílený serverový plán pracoviště a filtruje jen explicitně přiřazené 4. patro', () => {
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
  assert.deepEqual(didi.tasks.map((item) => item.id).sort(), ['didi-extra','fourth','martina-extra'])
  assert.equal(didi.fourthFloorRotation?.assignment?.workerId, 'didi-uuid')
  const martina = buildCalendarDaySummary({ date, today: date, tasks, context: resolveCleaningDay(date, []), planning, workerId: 'martina-uuid' })
  assert.deepEqual(martina.tasks.map((item) => item.id).sort(), ['didi-extra','martina-extra'])
  assert.equal(martina.fourthFloorRotation, null, 'pracovník nevidí cizí rotační 4. patro')
})

test('serverový planner → mapování → Plán dne nezahodí rotované patro ani extras', () => {
  const date = '2026-09-11'
  const planning = {
    available: true,
    planningWorkers: [
      { id: 'didi', name: 'Didi Ceridwen', linkedProfileId: 'profile-didi', active: true },
      { id: 'olga', name: 'Olga', linkedProfileId: null, active: true },
    ],
    assignments: [
      { id: 'a-didi', workerId: 'didi', workerName: 'Didi Ceridwen', buildingId: 'school', buildingName: 'Škola', floorId: 'f1', floorName: '1. patro', areaLabel: '1. patro', weekdays: [5], validFrom: '2026-09-01', validTo: null, active: true },
      { id: 'a-olga', workerId: 'olga', workerName: 'Olga', buildingId: 'school', buildingName: 'Škola', floorId: 'f2', floorName: '2. patro', areaLabel: '2. patro', weekdays: [5], validFrom: '2026-09-01', validTo: null, active: true },
    ],
    exceptions: [], rotationDefinitions: [], rotationSlots: [],
  }
  const catalog = [
    task({ id: 'floor-1', floorId: 'f1', plannerReason: null }),
    task({ id: 'wc', roomId: 'wc', room: 'WC ženy', activityType: 'toilet', plannerReason: null }),
    task({ id: 'floor-3', roomId: 'r3', room: 'Ateliér', floorId: 'f3', floor: '3. patro', floorSort: 3, plannerReason: null }),
    task({ id: 'stairs', roomId: 'stairs', room: 'Schodiště', floor: 'Schodiště', floorSort: 5, frequency: 'denně', plannerReason: null }),
    task({ id: 'small', activityType: 'windows', frequency: 'denně', plannerReason: null }),
    task({ id: 'large', activityType: 'deep_clean', frequency: 'denně', plannerReason: null }),
    task({ id: 'overdue', activityType: 'doors', frequency: 'denně', plannerReason: null }),
  ]
  const rpcRows = new Map([
    ['floor-1', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['wc', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['floor-3', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['stairs', { planReason: 'weekly-special', assignedWorkerId: null, plannerPriority: null }],
    ['small', { planReason: 'small', assignedWorkerId: null, plannerPriority: null }],
    ['large', { planReason: 'large', assignedWorkerId: null, plannerPriority: null }],
    ['overdue', { planReason: 'overdue', assignedWorkerId: null, plannerPriority: null }],
  ])
  const projected = projectDynamicSchoolPlan(catalog, rpcRows)
  const summary = buildCalendarDaySummary({ date, today: date, tasks: projected, context: resolveCleaningDay(date, []), planning, workerId: 'didi' })
  const labels = summary.workBlocks.flatMap((building) => [...building.blocks.map((item) => item.title), ...(building.wcQueue ? [building.wcQueue.title] : [])])
  assert.deepEqual(labels, ['Podlahy – 1. patro', 'Podlahy – 3. patro', 'WC – celá škola'])
  assert.deepEqual(summary.workers.map((item) => item.workerName), ['Didi Ceridwen'])
  assert.ok(summary.extraCategories.some((item) => item.key === 'staircase'))
  assert.ok(summary.extraCategories.some((item) => item.key === 'windows'))
  assert.ok(summary.extraCategories.some((item) => item.key === 'deep_clean'))
  assert.equal(summary.extraCategories.find((item) => item.key === 'doors')?.overdue, true)
})

test('Plán dne překládá 1/2/3 pracovníky do stejných hlavních celků jako Dnes', () => {
  const cases = [
    {
      workers: ['didi'],
      tasks: [
        task({ id: 'f1', plannerReason: 'routine' }),
        task({ id: 'wcq', room: 'WC ženy', roomId: 'wcq', activityType: 'toilet', plannerReason: 'wc-queue' }),
      ],
      expected: ['Podlahy – 1. patro', 'WC – otevřená fronta'],
    },
    {
      workers: ['didi', 'worker-2'],
      tasks: [
        task({ id: 'f1', plannerReason: 'routine' }),
        task({ id: 'wc', room: 'WC ženy', roomId: 'wc', activityType: 'toilet', plannerReason: 'routine' }),
        task({ id: 'f2', room: 'Učebna 1', roomId: 'f2', floor: '2. patro', floorSort: 2, plannerReason: 'routine' }),
      ],
      expected: ['Podlahy – 1. patro', 'Podlahy – 2. patro', 'WC – celá škola'],
    },
    {
      workers: ['didi', 'worker-2', 'worker-3'],
      tasks: [
        task({ id: 'f1', plannerReason: 'routine' }),
        task({ id: 'f2', room: 'Učebna 1', roomId: 'f2', floor: '2. patro', floorSort: 2, plannerReason: 'routine' }),
        task({ id: 'f3', room: 'Ateliér', roomId: 'f3', floor: '3. patro', floorSort: 3, plannerReason: 'routine' }),
        task({ id: 'wc', room: 'WC ženy', roomId: 'wc', activityType: 'toilet', plannerReason: 'routine' }),
      ],
      expected: ['Podlahy – 1. patro', 'Podlahy – 2. patro', 'Podlahy – 3. patro', 'WC – celá škola'],
    },
  ]
  for (const item of cases) {
    const planning = {
      available: true,
      planningWorkers: item.workers.map((id) => ({ id, name: id, linkedProfileId: id === 'didi' ? 'profile-didi' : null, active: true })),
      assignments: item.workers.map((id, index) => ({ id: `a-${id}`, workerId: id, workerName: id, buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1], validFrom: '2026-08-01', validTo: null, active: true })),
      exceptions: [], rotationDefinitions: [], rotationSlots: [],
    }
    const summary = buildCalendarDaySummary({ date: '2026-09-07', today: '2026-09-02', tasks: item.tasks, context: resolveCleaningDay('2026-09-07', []), planning })
    const labels = summary.workBlocks.flatMap((building) => [...building.blocks.map((block) => block.title), ...(building.wcQueue ? [building.wcQueue.title] : [])])
    assert.equal(summary.workers.length, item.workers.length)
    assert.deepEqual(labels, item.expected)
  }
})

test('oprávněný dynamický výsledek pro 3 pracovníky zachová 1F + 2F + 3F, WC, schodiště a large práci až do buňky Kalendáře', () => {
  const date = '2026-09-07'
  const planning = {
    available: true,
    planningWorkers: ['didi', 'martina', 'olga'].map((id) => ({ id, name: id, linkedProfileId: null, active: true })),
    assignments: ['didi', 'martina', 'olga'].map((id, index) => ({ id: `a-${id}`, workerId: id, workerName: id, buildingId: 'school', buildingName: 'Škola', floorId: `f${index + 1}`, floorName: `${index + 1}. patro`, areaLabel: `${index + 1}. patro`, weekdays: [1], validFrom: '2026-09-01', validTo: null, active: true })),
    exceptions: [], rotationDefinitions: [], rotationSlots: [],
  }
  const catalog = [
    task({ id: 'f1', floorId: 'f1', floor: '1. patro' }),
    task({ id: 'f2', roomId: 'r2', room: 'Učebna 1', floorId: 'f2', floor: '2. patro', floorSort: 2 }),
    task({ id: 'f3', roomId: 'r3', room: 'Ateliér', floorId: 'f3', floor: '3. patro', floorSort: 3 }),
    task({ id: 'wc', roomId: 'wc', room: 'WC ženy', activityType: 'toilet' }),
    task({ id: 'stairs', roomId: 'stairs', room: 'Schodiště', floor: 'Schodiště', floorSort: 5 }),
    task({ id: 'large-window', roomId: 'cleaning', room: 'Úklidová místnost', floorId: 'f3', floor: '3. patro', floorSort: 3, activityType: 'windows' }),
  ]
  const rpcRows = new Map([
    ['f1', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['f2', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['f3', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['wc', { planReason: 'routine', assignedWorkerId: null, plannerPriority: null }],
    ['stairs', { planReason: 'weekly-special', assignedWorkerId: null, plannerPriority: null }],
    ['large-window', { planReason: 'large', assignedWorkerId: null, plannerPriority: null }],
  ])
  const summary = buildCalendarDaySummary({ date, today: date, tasks: projectDynamicSchoolPlan(catalog, rpcRows), context: resolveCleaningDay(date, []), planning })
  const labels = summary.workBlocks.flatMap((building) => [...building.blocks.map((block) => block.title), ...(building.wcQueue ? [building.wcQueue.title] : [])])
  assert.deepEqual(labels, ['Podlahy – 1. patro', 'Podlahy – 2. patro', 'Podlahy – 3. patro', 'WC – celá škola'])
  assert.deepEqual(calendarDayCellScope(summary), { workers: 3, floors: ['1F', '2F', '3F'], hasWc: true, hasStairs: true, hasFourthFloor: false, extraCount: 1 })
})

test('Kalendář během načítání nebo chyby nepoužije starý statický plán jako dynamický výsledek', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(app, /plannerStatus === "ready" \? plannedTasksForDate[\s\S]*: \[\]/)
  assert.match(app, /plannerStatus === "loading"[\s\S]*Načítám plán dne/)
  assert.match(app, /plannerStatus === "error"[\s\S]*Plán dne se nepodařilo načíst/)
  assert.match(app, /setPlannerStatus\("loading"\)[\s\S]*setServerDynamicPlan\(null\)/)
})

test('Plán dne zachová overdue metadata, schodiště a skutečného pracovníka 4. patra', () => {
  const date = '2026-09-07'
  const planning = {
    available: true,
    planningWorkers: [{ id: 'worker-2', name: 'Pracovník 2', linkedProfileId: null, active: true }],
    assignments: [{ id: 'a', workerId: 'worker-2', workerName: 'Pracovník 2', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1], validFrom: date, validTo: null, active: true }],
    exceptions: [],
    rotationDefinitions: [{ rotationKey: 'school-fourth-floor', title: '4. patro', anchorDate: date, weekday: 1, slotCount: 3, active: true }],
    rotationSlots: [{ id: 'slot', rotationKey: 'school-fourth-floor', slotIndex: 0, workerId: 'worker-2', workerName: 'Pracovník 2', validFrom: date, validTo: null, active: true }],
  }
  const summary = buildCalendarDaySummary({
    date, today: date, context: resolveCleaningDay(date, []), planning, workerId: 'worker-2',
    tasks: [
      task({ id: 'stairs', room: 'Schodiště', roomId: 'stairs', floor: 'Schodiště', floorSort: 5, frequency: 'týdně', plannerReason: 'weekly-special' }),
      task({ id: 'fourth', room: 'Mediační místnost', roomId: 'fourth', floor: '4. patro', floorSort: 4, frequency: 'týdně', plannerReason: 'weekly-special', plannerAssignedWorkerId: 'worker-2' }),
      task({ id: 'windows', activityType: 'windows', frequency: 'měsíčně', plannerReason: 'overdue' }),
    ],
  })
  assert.equal(summary.fourthFloorAssignedWorker?.workerId, 'worker-2')
  assert.equal(summary.fourthFloorAssignedWorker?.workerName, 'Pracovník 2')
  assert.equal(summary.fourthFloorRotation, null, 'serverové přiřazení nesmí přepsat stará A/B/C rotace')
  assert.equal(summary.extraCategories.find((item) => item.key === 'windows')?.overdue, true)
  assert.ok(summary.extraCategories.some((item) => item.key === 'staircase'))
})

test('detail a tisk 4. patra preferují assigned planning worker před legacy A/B/C rotací', () => {
  const date = '2026-09-07'
  const planning = {
    available: true,
    planningWorkers: [
      { id: 'martina', name: 'Martina', linkedProfileId: null, active: true },
      { id: 'legacy', name: 'Legacy pracovník', linkedProfileId: null, active: true },
    ],
    assignments: [
      { id: 'martina-shift', workerId: 'martina', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1], validFrom: date, validTo: null, active: true },
    ],
    exceptions: [],
    rotationDefinitions: [{ rotationKey: 'school-fourth-floor', title: '4. patro', anchorDate: date, weekday: 1, slotCount: 3, active: true }],
    rotationSlots: [{ id: 'legacy-slot', rotationKey: 'school-fourth-floor', slotIndex: 0, workerId: 'legacy', workerName: 'Legacy pracovník', validFrom: date, validTo: null, active: true }],
  }
  const summary = buildCalendarDaySummary({
    date, today: date, context: resolveCleaningDay(date, []), planning,
    tasks: [task({ id: 'fourth-assigned', roomId: 'fourth', room: 'Mediační místnost', floor: '4. patro', floorSort: 4, plannerReason: 'weekly-special', plannerAssignedWorkerId: 'martina' })],
  })
  assert.equal(summary.fourthFloorAssignedWorker?.workerName, 'Martina')
  assert.equal(summary.fourthFloorRotation, null)
  assert.equal(calendarPrintDay(summary).fourthFloorWorker, 'Martina')
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const detail = app.slice(app.indexOf('function CalendarDayDetail'), app.indexOf('function CalendarDayModal'))
  assert.match(detail, /fourthFloorAssignedWorker\?\.workerName\s*\?\?\s*summary\.fourthFloorRotation/)
  assert.match(detail, /Na řadě: \$\{fourthFloorWorkerName\}/)
})

test('Plán dne umí skutečně prázdný den bez vymyšlené práce', () => {
  const summary = buildCalendarDaySummary({ date: '2026-09-06', today: '2026-09-02', tasks: [], context: resolveCleaningDay('2026-09-06', []) })
  assert.deepEqual(summary.tasks, [])
  assert.deepEqual(summary.workBlocks, [])
  assert.deepEqual(summary.extraCategories, [])
})

test('Plán dne je read-only a měsíční interval načte po bezpečných blocích bez PostgREST ořezu', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const detail = app.slice(app.indexOf('function CalendarDayDetail'), app.indexOf('function CleaningCalendar'))
  assert.match(app, /setDayDetailOpen\(true\)/)
  assert.match(detail, /aria-modal="true"/)
  assert.match(detail, /HLAVNÍ PLÁN DNE/)
  assert.doesNotMatch(detail, /Příchod|Odchod|Hotovo|completion/i)
  assert.match(repository, /get_dynamic_school_cleaning_plan[\s\S]*target_from: chunk\.from, target_to: chunk\.to/)
  assert.match(repository, /dateRangeChunks\(from, to\)[\s\S]*Promise\.all/)
  assert.match(repository, /result\.data\?\.length[\s\S]*>= 1000/)
  assert.match(repository, /planReason:[\s\S]*assignedWorkerId:[\s\S]*plannerPriority:/)
  assert.match(css, /\.calendar-day-sheet \{[^}]*width: min\(100%, 620px\)[^}]*overflow-x: hidden/)
  assert.match(css, /\.calendar-day-close \{[^}]*width: 44px[^}]*height: 44px/)
})

test('tiskový plán je pouze agregovaná prezentace skutečných dynamických směn', () => {
  const planning = {
    available: true,
    planningWorkers: [
      { id: 'didi', name: 'Didi', linkedProfileId: 'profile-didi', active: true },
      { id: 'martina', name: 'Martina', linkedProfileId: null, active: true },
      { id: 'olga', name: 'Olga', linkedProfileId: null, active: true },
    ],
    assignments: [
      { id: 'didi', workerId: 'didi', workerName: 'Didi', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1, 3, 5], validFrom: '2026-09-01', validTo: null, active: true },
      { id: 'martina-a', workerId: 'martina', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1, 3], validFrom: '2026-09-07', validTo: '2026-09-13', active: true },
      { id: 'martina-b', workerId: 'martina', workerName: 'Martina', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [3, 5], validFrom: '2026-09-14', validTo: '2026-09-20', active: true },
      { id: 'olga', workerId: 'olga', workerName: 'Olga', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1], validFrom: '2026-09-01', validTo: null, active: true },
    ],
    exceptions: [], rotationDefinitions: [], rotationSlots: [],
  }
  const threeWorkerTasks = [
    task({ id: 'f1', plannerReason: 'routine' }),
    task({ id: 'f2', roomId: 'f2', room: 'Učebna 1', floor: '2. patro', floorSort: 2, plannerReason: 'routine' }),
    task({ id: 'f3', roomId: 'f3', room: 'Ateliér', floor: '3. patro', floorSort: 3, plannerReason: 'routine' }),
    task({ id: 'wc', roomId: 'wc', room: 'WC ženy', activityType: 'toilet', plannerReason: 'routine' }),
  ]
  const monday = calendarPrintDay(buildCalendarDaySummary({ date: '2026-09-07', today: '2026-09-01', tasks: threeWorkerTasks, context: resolveCleaningDay('2026-09-07', []), planning }))
  assert.deepEqual(monday.workers.map((worker) => worker.name), ['Didi', 'Martina', 'Olga'])
  assert.deepEqual(monday.mainPlan.map((item) => item.title), ['Podlahy – 1. patro', 'Podlahy – 2. patro', 'Podlahy – 3. patro', 'WC – celá škola'])
  const firstFriday = calendarPrintDay(buildCalendarDaySummary({ date: '2026-09-11', today: '2026-09-01', tasks: [], context: resolveCleaningDay('2026-09-11', []), planning }))
  const secondFriday = calendarPrintDay(buildCalendarDaySummary({ date: '2026-09-18', today: '2026-09-01', tasks: [], context: resolveCleaningDay('2026-09-18', []), planning }))
  assert.deepEqual(firstFriday.workers.map((worker) => worker.name), ['Didi'])
  assert.deepEqual(secondFriday.workers.map((worker) => worker.name), ['Didi', 'Martina'])
})

test('tisk zachová schodiště, 4F pracovníka, small/large, overdue a Školku bez mikroúkolů', () => {
  const date = '2026-09-07'
  const planning = {
    available: true,
    planningWorkers: [{ id: 'worker-2', name: 'Pracovník 2', linkedProfileId: null, active: true }],
    assignments: [{ id: 'a', workerId: 'worker-2', workerName: 'Pracovník 2', buildingId: 'school', buildingName: 'Škola', floorId: null, areaLabel: 'Škola', weekdays: [1], validFrom: date, validTo: null, active: true }],
    exceptions: [],
    rotationDefinitions: [{ rotationKey: 'school-fourth-floor', title: '4. patro', anchorDate: date, weekday: 1, slotCount: 3, active: true }],
    rotationSlots: [{ id: 'slot', rotationKey: 'school-fourth-floor', slotIndex: 0, workerId: 'worker-2', workerName: 'Pracovník 2', validFrom: date, validTo: null, active: true }],
  }
  const summary = buildCalendarDaySummary({
    date, today: date, context: resolveCleaningDay(date, []), planning,
    tasks: [
      task({ id: 'floor', plannerReason: 'routine' }),
      task({ id: 'stairs', roomId: 'stairs', room: 'Schodiště', floor: 'Schodiště', floorSort: 5, plannerReason: 'weekly-special' }),
      task({ id: 'fourth', roomId: 'fourth', room: 'Mediační místnost', floor: '4. patro', floorSort: 4, plannerReason: 'weekly-special', plannerAssignedWorkerId: 'worker-2' }),
      task({ id: 'small', activityType: 'windows', plannerReason: 'small' }),
      task({ id: 'large', activityType: 'deep_clean', plannerReason: 'large' }),
      task({ id: 'overdue', activityType: 'doors', plannerReason: 'overdue' }),
      task({ id: 'kg', buildingId: 'kg', building: 'Školka', floor: 'Prostory', roomId: 'kg-room', room: 'Kuchyň', plannerReason: null }),
    ],
  })
  const print = calendarPrintDay(summary)
  assert.deepEqual(print.workplaces.sort(), ['Škola', 'Školka'])
  assert.equal(print.fourthFloorWorker, 'Pracovník 2')
  assert.ok(print.extras.some((extra) => extra.key === 'staircase'))
  assert.ok(print.extras.some((extra) => extra.key === 'windows'))
  assert.ok(print.extras.some((extra) => extra.key === 'deep_clean'))
  assert.equal(print.extras.find((extra) => extra.key === 'doors')?.overdue, true)
  assert.ok(print.mainPlan.some((item) => item.building === 'Školka' && item.title === 'Úklid – Prostory'))
  assert.ok(print.mainPlan.every((item) => !item.title.includes('Běžný úklid')))
  assert.equal(calendarPrintDay(buildCalendarDaySummary({ date: '2026-09-06', today: date, tasks: [], context: resolveCleaningDay('2026-09-06', []) })).hasWork, false)
})

test('tisk používá browser print a samostatné A4 portrait/landscape layouty bez ovládání', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(app, /Vytisknout plán/)
  assert.match(app, /Tento týden/)
  assert.match(app, /Tento měsíc/)
  assert.match(app, /window\.print\(\)/)
  assert.match(app, /printCalendarDays[\s\S]*workerId: "all"/)
  assert.match(css, /@page calendar-week-plan \{ size: A4 portrait/)
  assert.match(css, /@page calendar-month-plan \{ size: A4 landscape/)
  assert.match(css, /@media print[\s\S]*body \* \{ visibility: hidden !important/)
  assert.match(css, /\.calendar-print-day \{[^}]*break-inside: avoid/)
})

test('vysvětlivky náročnosti jsou pouze v týdenním tisku a bezpečně se zalamují na A4', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const printComponent = app.slice(app.indexOf('function CalendarPrintPlan'), app.indexOf('function CleaningCalendar'))
  const monthBranch = printComponent.slice(0, printComponent.indexOf('const workDays'))
  const weekBranch = printComponent.slice(printComponent.indexOf('const workDays'))
  assert.doesNotMatch(monthBranch, /CalendarFloorEffortNotes/)
  assert.match(weekBranch, /<CalendarFloorEffortNotes \/>/)
  for (const title of ['1. patro – nejnáročnější', '2. patro – středně náročné až náročné', '3. patro – relativně nejjednodušší z hlavních pater', '4. patro – samostatný týdenní úkol', 'Schodiště – samostatný týdenní úkol']) assert.match(app, new RegExp(title))
  assert.match(app, /Okna na schodišti patří do samostatného periodického mytí oken/)
  assert.match(css, /\.calendar-print-explanations > article \{[^}]*break-inside: avoid[^}]*page-break-inside: avoid/)
  assert.match(css, /@page calendar-week-plan \{ size: A4 portrait/)
})
