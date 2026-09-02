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
  rotationDefinitions: CleaningRotationDefinition[]
  rotationSlots: CleaningRotationSlot[]
  available: boolean
}

export type CleaningRotationDefinition = {
  rotationKey: string
  title: string
  anchorDate: string
  weekday: number
  slotCount: number
  active: boolean
}

export type CleaningRotationSlot = {
  id: string
  rotationKey: string
  slotIndex: number
  workerId?: string | null
  workerName?: string | null
  validFrom: string
  validTo?: string | null
  active: boolean
}

export type PlannedWorker = {
  workerId: string
  workerName: string
  initials: string
  colorIndex: number
  buildingId: string
  buildingName: string
  floorId?: string | null
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
      floorId: item.floorId, areaLabel: item.areaLabel, exception: false, note: '',
    }))
  const exceptions = dateExceptions.filter((item) => item.planned && item.buildingId && item.buildingName).map((item) => plannedWorker({
    workerId: item.workerId, workerName: item.workerName, buildingId: item.buildingId!, buildingName: item.buildingName!,
    floorId: item.floorId, areaLabel: item.areaLabel || item.floorName || 'Pracovní oblast', exception: true, note: item.note,
  }))
  return [...regular, ...exceptions].sort((a, b) => a.workerName.localeCompare(b.workerName, 'cs') || a.buildingName.localeCompare(b.buildingName, 'cs'))
}

const utcDayNumber = (date: string) => {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

export type RotationForDate = {
  definition: CleaningRotationDefinition
  slotIndex: number
  slotLabel: string
  assignment?: CleaningRotationSlot
}

function addDays(date: string, amount: number) {
  return new Date((utcDayNumber(date) + amount) * 86_400_000).toISOString().slice(0, 10)
}

function monday(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7
  return addDays(date, 1 - value)
}

function bestSchoolShiftInWeek(weekMonday: string, planning: WorkerPlanningData) {
  const candidates = Array.from({ length: 7 }, (_, index) => addDays(weekMonday, index)).map((date) => ({
    date,
    count: workersForDate(date, planning).filter((worker) => worker.buildingName === 'Škola').length,
  })).filter((item) => item.count >= 2)
  return candidates.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))[0]?.date ?? null
}

function rotationForOccurrence(date: string, planning: WorkerPlanningData, rotationKey: string): RotationForDate | null {
  const definition = (planning.rotationDefinitions ?? []).find((item) => item.rotationKey === rotationKey && item.active)
  if (!definition || date < definition.anchorDate) return null
  let occurrenceIndex = 0
  for (let week = monday(definition.anchorDate); week < monday(date); week = addDays(week, 7)) {
    if (bestSchoolShiftInWeek(week, planning)) occurrenceIndex += 1
  }
  const slotIndex = occurrenceIndex % definition.slotCount
  const assignment = (planning.rotationSlots ?? [])
    .filter((item) => item.active && item.rotationKey === rotationKey && item.slotIndex === slotIndex && item.validFrom <= date && (!item.validTo || item.validTo >= date))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
  return { definition, slotIndex, slotLabel: String.fromCharCode(65 + slotIndex), assignment }
}

/** Stabilní pořadí je odvozené z týdenních výskytů 4. patra a UUID, nikdy ze jména ani pevného pátku. */
export function cleaningRotationForDate(date: string, planning: WorkerPlanningData, rotationKey = 'school-fourth-floor'): RotationForDate | null {
  const definition = (planning.rotationDefinitions ?? []).find((item) => item.rotationKey === rotationKey && item.active)
  if (!definition || date < definition.anchorDate) return null
  if (bestSchoolShiftInWeek(monday(date), planning) !== date) return null
  return rotationForOccurrence(date, planning, rotationKey)
}

/** Pozice skutečně naplánovaného výskytu; konkrétní den už vybral kapacitní planner. */
export function cleaningRotationForOccurrence(date: string, planning: WorkerPlanningData, rotationKey = 'school-fourth-floor') {
  return rotationForOccurrence(date, planning, rotationKey)
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

/** Supabase PostgrestError je obyčejný objekt, ne instance Error. */
export function workerPlanningSaveError(error: unknown, fallback: string) {
  const value = error as { code?: string; message?: string; details?: string } | null
  const message = value?.message?.trim() || value?.details?.trim()
  if (message?.includes('už je na tento den uložená aktivní výjimka')) {
    return 'Pro tohoto pracovníka už je na vybraný den uložená výjimka. Otevřete ji a upravte.'
  }
  if (value?.code === '23505' || message?.toLocaleLowerCase('cs').includes('překrývá')) {
    return 'Toto období se překrývá s již uloženým pracovním obdobím. Otevřete existující období a upravte ho.'
  }
  return message || fallback
}
