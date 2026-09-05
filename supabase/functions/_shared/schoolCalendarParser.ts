import ICAL from 'ical.js'
import type { SchoolCalendarEvent } from './schoolCalendarTypes.ts'

const MAX_EVENTS = 2_000
const MAX_ITERATIONS = 100_000

export class InvalidIcsError extends Error {
  constructor(message = 'Kalendář neposkytl platná data ICS.') {
    super(message)
    this.name = 'InvalidIcsError'
  }
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole
    const hexadecimal = entity[1]?.toLowerCase() === 'x'
    const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
  })
}

export function sanitizeCalendarText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = decodeHtmlEntities(value)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function dateOnly(time: ICAL.Time) {
  return `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
}

function timeZoneOffsetMs(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const representedAsUtc = Date.UTC(
    Number(value.year), Number(value.month) - 1, Number(value.day),
    Number(value.hour), Number(value.minute), Number(value.second),
  )
  return representedAsUtc - instant.getTime()
}

function normalizedTimeZone(timeZone: string) {
  return timeZone === 'CET' || timeZone === 'CEST' ? 'Europe/Prague' : timeZone
}

function zonedTimeMs(time: ICAL.Time, timeZone: string) {
  const zone = normalizedTimeZone(timeZone)
  const guess = new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second))
  let result = guess.getTime() - timeZoneOffsetMs(guess, zone)
  result = guess.getTime() - timeZoneOffsetMs(new Date(result), zone)
  return result
}

function normalizedTime(time: ICAL.Time, fallbackTimeZone?: string | null) {
  if (time.isDate) return dateOnly(time)
  const isFloating = time.zone === ICAL.Timezone.localTimezone || time.zone?.tzid === 'floating'
  if (isFloating && fallbackTimeZone) return new Date(zonedTimeMs(time, fallbackTimeZone)).toISOString()
  return time.toJSDate().toISOString()
}

function eventTimeZone(event: ICAL.Event) {
  const parameter = event.component.getFirstProperty('dtstart')?.getParameter('tzid')
  if (typeof parameter === 'string') return parameter
  return Array.isArray(parameter) && typeof parameter[0] === 'string' ? parameter[0] : null
}

function pragueMidnightMs(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const guess = new Date(Date.UTC(year, month - 1, day))
  let result = guess.getTime() - timeZoneOffsetMs(guess, 'Europe/Prague')
  // A second pass also covers the rare case where the first correction crosses
  // a daylight-saving boundary.
  result = guess.getTime() - timeZoneOffsetMs(new Date(result), 'Europe/Prague')
  return result
}

function lastModified(event: ICAL.Event) {
  const value = event.component.getFirstPropertyValue('last-modified')
    ?? event.component.getFirstPropertyValue('dtstamp')
  return value instanceof ICAL.Time ? normalizedTime(value) : undefined
}

function overlapsRange(start: ICAL.Time, end: ICAL.Time, from: string, toExclusive: string, timeZone?: string | null) {
  if (start.isDate) return dateOnly(start) < toExclusive && dateOnly(end) > from
  const startMs = new Date(normalizedTime(start, timeZone)).getTime()
  const endMs = new Date(normalizedTime(end, timeZone)).getTime()
  const fromMs = pragueMidnightMs(from)
  const toMs = pragueMidnightMs(toExclusive)
  return startMs < toMs && endMs > fromMs
}

function nextDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + 1))
  return value.toISOString().slice(0, 10)
}

async function stableId(externalId: string, instanceIdentifier: string) {
  const bytes = new TextEncoder().encode(`${externalId}\u0000${instanceIdentifier}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `google-ics-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function normalizeOccurrence(
  event: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  recurrenceId?: ICAL.Time,
): Promise<SchoolCalendarEvent | null> {
  if (String(event.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return null
  const externalId = typeof event.uid === 'string' ? event.uid.trim() : ''
  if (!externalId || externalId.length > 2_048) return null
  const title = sanitizeCalendarText(event.summary, 300) ?? 'Událost bez názvu'
  const description = sanitizeCalendarText(event.description, 5_000)
  const location = sanitizeCalendarText(event.location, 500)
  const timeZone = eventTimeZone(event)
  const instanceIdentifier = recurrenceId ? recurrenceId.toString() : start.toString()
  return {
    id: await stableId(externalId, instanceIdentifier),
    externalId,
    title,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    start: normalizedTime(start, timeZone),
    end: normalizedTime(end, timeZone),
    allDay: start.isDate,
    ...(lastModified(event) ? { updatedAt: lastModified(event) } : {}),
    source: 'google-ics',
    collisionKind: 'none',
  }
}

function registerEmbeddedTimezones(calendar: ICAL.Component) {
  for (const component of calendar.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(component)
  }
}

export async function parseSchoolCalendarIcs(ics: string, from: string, to: string): Promise<SchoolCalendarEvent[]> {
  let calendar: ICAL.Component
  try {
    const root = new ICAL.Component(ICAL.parse(ics))
    const candidate = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar')
    if (!candidate) throw new Error('VCALENDAR chybí.')
    calendar = candidate
    registerEmbeddedTimezones(calendar)
  } catch {
    throw new InvalidIcsError()
  }

  const components = calendar.getAllSubcomponents('vevent')
  const masters = new Map<string, ICAL.Event>()
  const exceptions = new Map<string, ICAL.Event[]>()
  for (const component of components) {
    try {
      // Disable ICAL.js' broad parent scan: a feed can contain recurrence
      // overrides for many UIDs and only matching UIDs may be related.
      const event = new ICAL.Event(component, { strictExceptions: true, exceptions: [] })
      const uid = event.uid
      if (!uid) continue
      if (event.isRecurrenceException()) {
        const list = exceptions.get(uid) ?? []
        list.push(event)
        exceptions.set(uid, list)
      } else {
        masters.set(uid, event)
      }
    } catch {
      throw new InvalidIcsError()
    }
  }

  const toExclusive = nextDate(to)
  const output: SchoolCalendarEvent[] = []
  let iterations = 0
  const append = async (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId?: ICAL.Time) => {
    const timeZone = eventTimeZone(event)
    if (!overlapsRange(start, end, from, toExclusive, timeZone)) return
    const normalized = await normalizeOccurrence(event, start, end, recurrenceId)
    if (normalized) output.push(normalized)
    if (output.length > MAX_EVENTS) throw new InvalidIcsError('Kalendář obsahuje příliš mnoho událostí.')
  }

  for (const [uid, master] of masters) {
    try {
      for (const exception of exceptions.get(uid) ?? []) master.relateException(exception)
      if (!master.isRecurring()) {
        await append(master, master.startDate, master.endDate)
        continue
      }
      const iterator = master.iterator()
      let occurrence: ICAL.Time | null
      while ((occurrence = iterator.next())) {
        iterations += 1
        if (iterations > MAX_ITERATIONS) throw new InvalidIcsError('Opakování událostí je příliš rozsáhlé.')
        const details = master.getOccurrenceDetails(occurrence)
        if (dateOnly(details.startDate) >= toExclusive && details.startDate.toUnixTime() >= master.startDate.toUnixTime()) break
        await append(details.item, details.startDate, details.endDate, details.recurrenceId)
      }
    } catch (error) {
      if (error instanceof InvalidIcsError) throw error
      throw new InvalidIcsError()
    }
  }

  // A detached override without its master is still a valid concrete event.
  for (const [uid, detached] of exceptions) {
    if (masters.has(uid)) continue
    for (const event of detached) await append(event, event.startDate, event.endDate, event.recurrenceId)
  }

  return output.sort((left, right) => left.start.localeCompare(right.start) || left.title.localeCompare(right.title, 'cs'))
}
