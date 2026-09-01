export type WorkerWorkAssignment = {
  id: string
  workerId: string
  workerName: string
  buildingId: string
  buildingName: string
  floorId?: string | null
  floorName?: string | null
  areaLabel: string
  weekdays: number[]
  validFrom: string
  validTo?: string | null
  active: boolean
}

export type WorkerScheduleException = {
  id: string
  workerId: string
  workerName: string
  date: string
  planned: boolean
  buildingId?: string | null
  buildingName?: string | null
  floorId?: string | null
  floorName?: string | null
  areaLabel?: string | null
  note: string
  active: boolean
}

export type WorkerPlanningData = {
  assignments: WorkerWorkAssignment[]
  exceptions: WorkerScheduleException[]
  available: boolean
}

export type PlannedWorker = {
  workerId: string
  workerName: string
  initials: string
  colorIndex: number
  buildingId: string
  buildingName: string
  areaLabel: string
  exception: boolean
  note: string
}

function weekday(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return value === 0 ? 7 : value
}

export function workerInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[words.length - 1]?.[0] ?? ''}` : words[0]?.slice(0, 2) ?? '?').toLocaleUpperCase('cs-CZ')
}

export function stableWorkerColor(workerId: string) {
  let hash = 0
  for (const character of workerId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash % 6
}

const plannedWorker = (value: Omit<PlannedWorker, 'initials' | 'colorIndex'>): PlannedWorker => ({
  ...value,
  initials: workerInitials(value.workerName),
  colorIndex: stableWorkerColor(value.workerId),
})

/** Aktivní výjimky konkrétního dne nahrazují běžný rozvrh daného pracovníka. */
export function workersForDate(date: string, planning: WorkerPlanningData): PlannedWorker[] {
  const day = weekday(date)
  const dateExceptions = planning.exceptions.filter((item) => item.active && item.date === date)
  const overriddenWorkers = new Set(dateExceptions.map((item) => item.workerId))
  const regular = planning.assignments
    .filter((item) => item.active && item.validFrom <= date && (!item.validTo || item.validTo >= date) && item.weekdays.includes(day) && !overriddenWorkers.has(item.workerId))
    .map((item) => plannedWorker({
      workerId: item.workerId, workerName: item.workerName, buildingId: item.buildingId, buildingName: item.buildingName,
      areaLabel: item.areaLabel, exception: false, note: '',
    }))
  const exceptions = dateExceptions.filter((item) => item.planned && item.buildingId && item.buildingName).map((item) => plannedWorker({
    workerId: item.workerId, workerName: item.workerName, buildingId: item.buildingId!, buildingName: item.buildingName!,
    areaLabel: item.areaLabel || item.floorName || 'Pracovní oblast', exception: true, note: item.note,
  }))
  return [...regular, ...exceptions].sort((a, b) => a.workerName.localeCompare(b.workerName, 'cs') || a.buildingName.localeCompare(b.buildingName, 'cs'))
}

export function assignmentOverlapsMonth(assignment: WorkerWorkAssignment, month: string) {
  const monthStart = `${month}-01`
  const [year, monthNumber] = month.split('-').map(Number)
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
  return assignment.validFrom <= monthEnd && (!assignment.validTo || assignment.validTo >= monthStart)
}

export function assignmentAppliesInMonth(assignment: WorkerWorkAssignment, month: string) {
  return assignment.active && assignmentOverlapsMonth(assignment, month)
}

export function workAssignmentsConflict(first: WorkerWorkAssignment, second: WorkerWorkAssignment) {
  if (!first.active || !second.active || first.id === second.id || first.workerId !== second.workerId) return false
  const datesOverlap = first.validFrom <= (second.validTo || '9999-12-31') && second.validFrom <= (first.validTo || '9999-12-31')
  const weekdaysOverlap = first.weekdays.some((day) => second.weekdays.includes(day))
  return datesOverlap && weekdaysOverlap
}

export function scheduleExceptionsConflict(first: WorkerScheduleException, second: WorkerScheduleException) {
  return first.active && second.active && first.id !== second.id && first.workerId === second.workerId && first.date === second.date
}
