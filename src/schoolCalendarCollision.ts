import type { CalendarSchoolEvent } from './schoolCalendarApi.ts'
import type { Task } from './types.ts'

export type SchoolCalendarScopeType = 'unrestricted' | 'whole_school' | 'building' | 'floor' | 'rooms'

export type SchoolCalendarScopeMapping = {
  id: string
  externalEventId?: string
  recurringEventId?: string
  scopeType: SchoolCalendarScopeType
  buildingId?: string
  floorId?: string
  roomIds: string[]
}

export type SchoolCalendarLocationAlias = {
  id: string
  alias: string
  scopeType: Exclude<SchoolCalendarScopeType, 'unrestricted'>
  buildingId?: string
  floorId?: string
  roomIds: string[]
}

export type CleaningTimeWindow = { start: string; end: string; buildingId?: string }
export type CalendarCollisionKind = 'NO_CONFLICT' | 'TIME_CONFLICT' | 'ROOM_CONFLICT' | 'BUILDING_CONFLICT' | 'UNKNOWN_SCOPE_CONFLICT'

export type CalendarCollision = {
  kind: CalendarCollisionKind
  reason: string
  event: CalendarSchoolEvent
  affectedTasks: Task[]
  mapping?: SchoolCalendarScopeMapping | SchoolCalendarLocationAlias
}

const normalized = (value: string) => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').trim().toLocaleLowerCase('cs-CZ')

export function mappingForSchoolEvent(
  event: CalendarSchoolEvent,
  mappings: SchoolCalendarScopeMapping[],
  aliases: SchoolCalendarLocationAlias[],
) {
  const eventMapping = mappings.find((item) => item.externalEventId === event.externalId)
  if (eventMapping) return eventMapping
  const seriesMapping = event.recurringEventId
    ? mappings.find((item) => item.recurringEventId === event.recurringEventId)
    : undefined
  if (seriesMapping) return seriesMapping
  if (!event.location) return undefined
  const location = normalized(event.location)
  return aliases.find((item) => normalized(item.alias) === location)
}

function mappingFromEventScope(event: CalendarSchoolEvent): SchoolCalendarScopeMapping | undefined {
  if (event.affectedRoomIds?.length || event.affectedRoomId) return {
    id: `event:${event.id}`, scopeType: 'rooms', buildingId: event.affectedBuildingId,
    floorId: event.affectedFloorId, roomIds: event.affectedRoomIds ?? [event.affectedRoomId!],
  }
  if (event.affectedFloorId) return { id: `event:${event.id}`, scopeType: 'floor', buildingId: event.affectedBuildingId, floorId: event.affectedFloorId, roomIds: [] }
  if (event.affectedBuildingId) return { id: `event:${event.id}`, scopeType: 'building', buildingId: event.affectedBuildingId, roomIds: [] }
  return undefined
}

export function applySchoolCalendarScope(
  event: CalendarSchoolEvent,
  mappings: SchoolCalendarScopeMapping[],
  aliases: SchoolCalendarLocationAlias[],
): CalendarSchoolEvent {
  const mapping = mappingForSchoolEvent(event, mappings, aliases) ?? mappingFromEventScope(event)
  if (!mapping) return event
  return {
    ...event,
    affectedBuildingId: mapping.buildingId,
    affectedFloorId: mapping.floorId,
    affectedRoomId: mapping.roomIds[0],
    affectedRoomIds: mapping.roomIds,
  }
}

function overlaps(event: CalendarSchoolEvent, window: CleaningTimeWindow) {
  if (event.allDay) return true
  const eventStart = Date.parse(event.start)
  const eventEnd = Date.parse(event.end)
  const cleaningStart = Date.parse(window.start)
  const cleaningEnd = Date.parse(window.end)
  return [eventStart, eventEnd, cleaningStart, cleaningEnd].every(Number.isFinite)
    && eventStart < cleaningEnd && eventEnd > cleaningStart
}

function scopedTasks(tasks: Task[], mapping: SchoolCalendarScopeMapping | SchoolCalendarLocationAlias) {
  if (mapping.scopeType === 'unrestricted') return tasks
  if (mapping.scopeType === 'rooms') {
    const rooms = new Set(mapping.roomIds)
    return tasks.filter((task) => Boolean(task.roomId && rooms.has(task.roomId)))
  }
  if (mapping.scopeType === 'floor') return tasks.filter((task) => task.floorId === mapping.floorId)
  if (mapping.scopeType === 'building' || mapping.scopeType === 'whole_school') {
    return tasks.filter((task) => task.buildingId === mapping.buildingId)
  }
  return []
}

export function detectCleaningEventCollision({
  event, tasks, mappings = [], aliases = [], cleaningWindows = [],
}: {
  event: CalendarSchoolEvent
  tasks: Task[]
  mappings?: SchoolCalendarScopeMapping[]
  aliases?: SchoolCalendarLocationAlias[]
  cleaningWindows?: CleaningTimeWindow[]
}): CalendarCollision {
  if (!tasks.length) return { kind: 'NO_CONFLICT', reason: 'Tento den není naplánovaný úklid.', event, affectedTasks: [] }
  const mapping = mappingForSchoolEvent(event, mappings, aliases) ?? mappingFromEventScope(event)
  const relevantWindows = cleaningWindows.filter((window) => !window.buildingId || tasks.some((task) => task.buildingId === window.buildingId))
  if (!event.allDay && relevantWindows.length > 0 && !relevantWindows.some((window) => overlaps(event, window))) {
    return { kind: 'NO_CONFLICT', reason: 'Událost je mimo plánovaný čas úklidu.', event, affectedTasks: [], ...(mapping ? { mapping } : {}) }
  }
  if (!mapping) {
    return { kind: 'UNKNOWN_SCOPE_CONFLICT', reason: event.allDay ? 'Celodenní akce nemá určený prostor.' : relevantWindows.length ? 'Časy se překrývají, ale prostor akce není určený.' : 'Čas nebo prostor úklidu není určený.', event, affectedTasks: tasks }
  }
  const affectedTasks = scopedTasks(tasks, mapping)
  if (!affectedTasks.length) return { kind: 'NO_CONFLICT', reason: 'Akce se netýká plánovaných prostorů.', event, affectedTasks: [], mapping }
  if (mapping.scopeType === 'rooms') return { kind: 'ROOM_CONFLICT', reason: 'Akce blokuje konkrétní místnost.', event, affectedTasks, mapping }
  if (mapping.scopeType === 'unrestricted') return { kind: 'TIME_CONFLICT', reason: 'Akce se časově překrývá s úklidem.', event, affectedTasks, mapping }
  return { kind: 'BUILDING_CONFLICT', reason: mapping.scopeType === 'floor' ? 'Akce blokuje část budovy.' : 'Akce blokuje pracoviště.', event, affectedTasks, mapping }
}

export function recommendCollisionResolution(collision: CalendarCollision, nextSuitableDate?: string) {
  const rooms = [...new Set(collision.affectedTasks.map((task) => task.room).filter(Boolean))]
  if (collision.kind === 'ROOM_CONFLICT') return {
    kind: 'move_rooms' as const,
    affectedTaskIds: collision.affectedTasks.map((task) => task.id),
    message: nextSuitableDate
      ? `Ostatní úklid ponechat. ${rooms.join(', ')} přesunout na ${nextSuitableDate}.`
      : `Ostatní úklid ponechat. Pro ${rooms.join(', ')} vybrat náhradní termín.`,
  }
  if (collision.kind === 'BUILDING_CONFLICT') return {
    kind: 'move_scope' as const,
    affectedTaskIds: collision.affectedTasks.map((task) => task.id),
    message: nextSuitableDate ? `Dotčenou část úklidu přesunout na ${nextSuitableDate}.` : 'Pro dotčenou část úklidu vybrat náhradní termín.',
  }
  if (collision.kind === 'TIME_CONFLICT') return {
    kind: 'review_time' as const, affectedTaskIds: collision.affectedTasks.map((task) => task.id), message: 'Prověřit jiný čas úklidu; plán se automaticky nemění.',
  }
  return { kind: 'review_scope' as const, affectedTaskIds: [] as string[], message: 'Nejdřív určit prostor akce. Plán se automaticky nemění.' }
}
