import type { Attendance } from './types'

export const ATTENDANCE_TIME_ZONE = 'Europe/Prague'

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function parts(date: Date) {
  const values = Object.fromEntries(
    dateTimeFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second,
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

export function pragueDateKey(value: Date | string = new Date()) {
  const current = typeof value === 'string' ? new Date(value) : value
  const local = parts(current)
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`
}

export function pragueDateTimeInput(value: Date | string) {
  const current = typeof value === 'string' ? new Date(value) : value
  const local = parts(current)
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`
}

export function attendanceEditorStartValue(start: string, attendanceDate: string) {
  return `${attendanceDate}T${pragueDateTimeInput(start).slice(11)}`
}

function offsetAt(instant: Date) {
  const local = parts(instant)
  const representedAsUtc = Date.UTC(
    local.year, local.month - 1, local.day,
    local.hour, local.minute, local.second,
  )
  return representedAsUtc - Math.floor(instant.getTime() / 1000) * 1000
}

export function parsePragueDateTimeInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) throw new Error('Zkontrolujte datum a čas směny.')
    return parsed
  }
  const [, year, month, day, hour, minute] = match.map(Number)
  const wallTime = Date.UTC(year, month - 1, day, hour, minute)
  let instant = new Date(wallTime)
  instant = new Date(wallTime - offsetAt(instant))
  instant = new Date(wallTime - offsetAt(instant))
  if (pragueDateTimeInput(instant) !== value) {
    throw new Error('Tento místní čas v Europe/Prague neexistuje kvůli změně času.')
  }
  return instant
}

export function attendanceIntervalsOverlap(
  records: Pick<Attendance, 'id' | 'start' | 'end'>[],
  start: Date,
  end: Date | null,
  excludedId?: string,
) {
  const startMs = start.getTime()
  const endMs = end?.getTime() ?? Number.POSITIVE_INFINITY
  return records.some((record) => {
    if (record.id === excludedId) return false
    const recordStart = new Date(record.start).getTime()
    const recordEnd = record.end ? new Date(record.end).getTime() : Number.POSITIVE_INFINITY
    return startMs < recordEnd && recordStart < endMs
  })
}

export function validateAttendanceInterval(
  records: Pick<Attendance, 'id' | 'start' | 'end'>[],
  startValue: string,
  endValue?: string,
  excludedId?: string,
) {
  const start = parsePragueDateTimeInput(startValue)
  const end = endValue ? parsePragueDateTimeInput(endValue) : null
  if (end && end < start) throw new Error('Odchod nesmí být před příchodem.')
  if (attendanceIntervalsOverlap(records, start, end, excludedId)) {
    throw new Error('Směna se překrývá s jinou evidovanou směnou tohoto pracovníka.')
  }
  return { start, end, attendanceDate: pragueDateKey(start) }
}
