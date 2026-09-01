import type { Task } from './types.ts'
import { cleaningRotationForOccurrence, workersForDate, type PlannedWorker, type WorkerPlanningData } from './workerPlanning.ts'

export type PlannerSize = 'routine' | 'small' | 'large' | 'weekly-special'
export type PlannerReason = 'routine' | 'wc-queue' | 'weekly' | 'periodic' | 'overdue'

export type PlannedCleaningTask = {
  task: Task
  date: string
  dueFrom: string
  dueTo: string
  reason: PlannerReason
  size: PlannerSize
  groupKey: string
  assignedWorkerId?: string | null
}

export type DynamicCleaningDay = {
  date: string
  workers: PlannedWorker[]
  workerCount: number
  tasks: PlannedCleaningTask[]
  rotatingFloor?: '2. patro' | '3. patro'
  fourthFloorWorkerId?: string | null
}

type DayLoad = { weekly: number; small: number; large: number }

type PlannerInput = {
  startDate: string
  endDate: string
  tasks: Task[]
  planning: WorkerPlanningData
  completedDatesByTask?: ReadonlyMap<string, ReadonlySet<string>>
  schoolName?: string
}

const DAY = 86_400_000
const SCHOOL_ANCHOR = '2026-08-31'

function utc(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function dateKey(value: number) {
  return new Date(value).toISOString().slice(0, 10)
}

function addDays(date: string, amount: number) {
  return dateKey(utc(date) + amount * DAY)
}

function weekday(date: string) {
  return new Date(utc(date)).getUTCDay() || 7
}

function monday(date: string) {
  return addDays(date, 1 - weekday(date))
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`
}

function monthEnd(date: string) {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function monthsBetween(first: string, second: string) {
  const [firstYear, firstMonth] = first.split('-').map(Number)
  const [secondYear, secondMonth] = second.split('-').map(Number)
  return (secondYear - firstYear) * 12 + secondMonth - firstMonth
}

function datesBetween(start: string, end: string) {
  const result: string[] = []
  for (let value = utc(start); value <= utc(end); value += DAY) result.push(dateKey(value))
  return result
}

function schoolWorkers(date: string, planning: WorkerPlanningData, schoolName: string) {
  return workersForDate(date, planning).filter((worker) => worker.buildingName === schoolName)
}

function activeSchoolTask(task: Task, schoolName: string) {
  return task.active && task.roomActive !== false && task.building === schoolName && task.activityType !== 'laundry'
}

function isWc(task: Task) {
  return /^WC(?:\s|\s*\/)/i.test(task.room)
}

function isFloorTask(task: Task) {
  return task.activityType === 'vacuum' || task.activityType === 'mop'
}

function extraSize(task: Task): PlannerSize | null {
  if (task.floor === 'Schodiště' && task.activityType !== 'windows') return 'weekly-special'
  if (task.floor === '4. patro' && task.frequency === 'týdně') return 'weekly-special'
  if (task.activityType === 'windows' || task.activityType === 'deep_clean') return 'large'
  if (task.activityType === 'tables' || task.activityType === 'doors' || task.activityType === 'tiles' || task.activityType === 'surfaces') return 'small'
  return null
}

function extraGroup(task: Task) {
  const interval = task.periodMonths ? `${task.periodMonths}m` : task.frequency === 'týdně' ? 'week' : 'other'
  return `${task.activityType}|${task.floor}|${interval}|${task.periodWeek ?? 0}`
}

function isCompleted(taskId: string, from: string, to: string, completions?: ReadonlyMap<string, ReadonlySet<string>>) {
  const dates = completions?.get(taskId)
  return dates ? [...dates].some((date) => date >= from && date <= to) : false
}

function periodFor(task: Task, reference: string): { from: string; to: string } | null {
  if (task.frequency === 'týdně' && !task.periodMonths) {
    const from = monday(reference)
    return { from, to: addDays(from, 6) }
  }
  if (!task.periodMonths || !task.periodAnchorMonth) return null
  const currentMonth = monthStart(reference)
  if (currentMonth < monthStart(task.periodAnchorMonth)) return null
  if (((monthsBetween(monthStart(task.periodAnchorMonth), currentMonth) % task.periodMonths) + task.periodMonths) % task.periodMonths !== 0) return null
  return { from: currentMonth, to: monthEnd(reference) }
}

function loadUnits(load?: DayLoad) {
  return load ? load.weekly + load.small + 2 * load.large : 0
}

function reserve(loads: Map<string, DayLoad>, date: string, size: 'weekly' | 'small' | 'large') {
  const load = loads.get(date) ?? { weekly: 0, small: 0, large: 0 }
  load[size] += 1
  loads.set(date, load)
}

function eligibleShiftDates(from: string, to: string, planning: WorkerPlanningData, schoolName: string, minimum: number, loads?: ReadonlyMap<string, DayLoad>, keepWithinCapacity = false) {
  return datesBetween(from, to).map((date) => ({ date, count: schoolWorkers(date, planning, schoolName).length }))
    .filter((item) => item.count >= minimum)
    .sort((a, b) => {
      const overloadA = keepWithinCapacity && loadUnits(loads?.get(a.date)) + 1 > Math.min(a.count, 3)
      const overloadB = keepWithinCapacity && loadUnits(loads?.get(b.date)) + 1 > Math.min(b.count, 3)
      return Number(overloadA) - Number(overloadB) || b.count - a.count
        || loadUnits(loads?.get(a.date)) - loadUnits(loads?.get(b.date)) || a.date.localeCompare(b.date)
    })
}

function eligibleShiftSequence(until: string, planning: WorkerPlanningData, schoolName: string, minimum: number) {
  return datesBetween(SCHOOL_ANCHOR, until).filter((date) => schoolWorkers(date, planning, schoolName).length >= minimum)
}

function rotatingFloor(date: string, planning: WorkerPlanningData, schoolName: string): '2. patro' | '3. patro' {
  const sequence = eligibleShiftSequence(date, planning, schoolName, 2)
  const index = Math.max(0, sequence.indexOf(date))
  return index % 2 === 0 ? '2. patro' : '3. patro'
}

/**
 * Jeden deterministický planner pro Dnes i Kalendář. Nepracuje se jmény a
 * pro stejná UUID assignmentů, completion historii a interval vrací stejné výsledky.
 */
export function buildDynamicSchoolPlan({ startDate, endDate, tasks, planning, completedDatesByTask, schoolName = 'Škola' }: PlannerInput) {
  const schoolTasks = tasks.filter((task) => activeSchoolTask(task, schoolName))
  const days = datesBetween(startDate, endDate)
  const result = new Map<string, DynamicCleaningDay>()
  const loads = new Map<string, DayLoad>()
  const selectedGroupDates = new Map<string, string>()
  const weeklyGroups = [
    { key: 'stairs', present: schoolTasks.some((task) => task.floor === 'Schodiště' && task.activityType !== 'windows') },
    { key: 'fourth-floor', present: schoolTasks.some((task) => task.floor === '4. patro' && task.frequency === 'týdně') },
  ].filter((group) => group.present)
  const lookbackStart = addDays(startDate, -124)
  const referenceDates = datesBetween(lookbackStart, endDate)
  const groupCandidates = new Map<string, { tasks: Task[]; size: 'small' | 'large'; dueFrom: string; dueTo: string }>()
  for (const reference of referenceDates) {
    for (const task of schoolTasks) {
      const size = extraSize(task)
      if (size !== 'small' && size !== 'large') continue
      const period = periodFor(task, reference)
      if (!period || period.from !== (task.frequency === 'týdně' && !task.periodMonths ? monday(reference) : monthStart(reference))) continue
      if (task.frequency === 'týdně' && !task.periodMonths && period.from < monday(startDate)) continue
      if (isCompleted(task.id, period.from, period.to, completedDatesByTask)) continue
      const key = `${extraGroup(task)}|${period.from}`
      const existing = groupCandidates.get(key)
      if (existing) {
        if (!existing.tasks.some((item) => item.id === task.id)) existing.tasks.push(task)
      } else groupCandidates.set(key, { tasks: [task], size, dueFrom: period.from, dueTo: period.to })
    }
  }

  const sortedGroups = [...groupCandidates].sort((a, b) => a[1].dueFrom.localeCompare(b[1].dueFrom)
    || Number(b[1].size === 'large') - Number(a[1].size === 'large') || a[0].localeCompare(b[0]))
  const scheduleGroups = (groups: typeof sortedGroups) => {
    for (const [groupKey, group] of groups) {
      const earliest = group.dueFrom < startDate ? startDate : group.dueFrom
      const candidates = datesBetween(earliest, endDate).filter((date) => {
        const count = schoolWorkers(date, planning, schoolName).length
        const load = loads.get(date) ?? { weekly: 0, small: 0, large: 0 }
        const capacity = Math.min(count, 3)
        if (group.size === 'large') return count >= 3 && load.small === 0 && load.large === 0 && loadUnits(load) + 2 <= capacity
        if (count < 2) return false
        return load.large === 0 && load.small < (count >= 3 ? 2 : 1) && loadUnits(load) + 1 <= capacity
      }).sort((a, b) => {
        const countA = schoolWorkers(a, planning, schoolName).length
        const countB = schoolWorkers(b, planning, schoolName).length
        return countB - countA || loadUnits(loads.get(a)) - loadUnits(loads.get(b)) || a.localeCompare(b)
      })
      const scheduled = candidates[0]
      if (!scheduled) continue
      selectedGroupDates.set(groupKey, scheduled)
      reserve(loads, scheduled, group.size)
    }
  }
  scheduleGroups(sortedGroups.filter(([, group]) => group.dueTo < startDate))
  for (const week of [...new Set(days.map(monday))]) {
    for (const group of weeklyGroups) {
      const candidates = eligibleShiftDates(week, addDays(week, 6), planning, schoolName, 2, loads, true)
      if (!candidates[0]) continue
      selectedGroupDates.set(`${group.key}|${week}`, candidates[0].date)
      reserve(loads, candidates[0].date, 'weekly')
    }
  }
  scheduleGroups(sortedGroups.filter(([, group]) => group.dueTo >= startDate))

  for (const date of days) {
    const workers = schoolWorkers(date, planning, schoolName)
    if (!workers.length) continue
    const count = workers.length
    const chosen: PlannedCleaningTask[] = []
    const add = (task: Task, reason: PlannerReason, size: PlannerSize, dueFrom = date, dueTo = date, groupKey = `routine|${task.id}`, assignedWorkerId?: string | null) => {
      if (!chosen.some((item) => item.task.id === task.id)) chosen.push({ task, date, dueFrom, dueTo, reason, size, groupKey, assignedWorkerId })
    }

    schoolTasks.filter((task) => task.floor === '1. patro' && isFloorTask(task)).forEach((task) => add(task, 'routine', 'routine'))
    const wcTasks = schoolTasks.filter((task) => isWc(task) && extraSize(task) === null)
      .sort((a, b) => a.floorSort - b.floorSort || a.room.localeCompare(b.room, 'cs') || a.sortOrder - b.sortOrder)
    wcTasks.forEach((task) => add(task, count === 1 ? 'wc-queue' : 'routine', 'routine'))

    let floor: '2. patro' | '3. patro' | undefined
    if (count === 2) {
      floor = rotatingFloor(date, planning, schoolName)
      schoolTasks.filter((task) => task.floor === floor && isFloorTask(task)).forEach((task) => add(task, 'routine', 'routine'))
    } else if (count >= 3) {
      ;(['2. patro', '3. patro'] as const).forEach((floorName) => schoolTasks.filter((task) => task.floor === floorName && isFloorTask(task)).forEach((task) => add(task, 'routine', 'routine')))
    }

    const week = monday(date)
    let fourthWorkerId: string | null = null
    const period = { from: week, to: addDays(week, 6) }
    if (selectedGroupDates.get(`stairs|${week}`) === date) {
      schoolTasks.filter((task) => task.floor === 'Schodiště' && task.activityType !== 'windows').forEach((task) => add(task, 'weekly', 'weekly-special', period.from, period.to, `stairs|${week}`))
    }
    if (selectedGroupDates.get(`fourth-floor|${week}`) === date) {
      fourthWorkerId = cleaningRotationForOccurrence(date, planning)?.assignment?.workerId ?? null
      schoolTasks.filter((task) => task.floor === '4. patro' && task.frequency === 'týdně').forEach((task) => add(task, 'weekly', 'weekly-special', period.from, period.to, `fourth-floor|${week}`, fourthWorkerId))
    }

    for (const [groupKey, scheduled] of selectedGroupDates) {
      if (scheduled !== date) continue
      const group = groupCandidates.get(groupKey)
      if (!group) continue
      group.tasks.forEach((task) => add(task, group.dueTo < date ? 'overdue' : task.frequency === 'týdně' ? 'weekly' : 'periodic', group.size, group.dueFrom, group.dueTo, groupKey))
    }
    result.set(date, { date, workers, workerCount: count, tasks: chosen, rotatingFloor: floor, fourthFloorWorkerId: fourthWorkerId })
  }
  return result
}
