import { sanitizeCalendarText } from './schoolCalendarSanitize.ts'
import type { SchoolCalendarEvent } from './schoolCalendarTypes.ts'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars'
const MAX_PAGES = 20
const MAX_EVENTS = 2_000

export class GoogleCalendarConfigurationError extends Error {}
export class GoogleCalendarAuthenticationError extends Error {}
export class GoogleCalendarRemoteError extends Error {}

type SecretName =
  | 'GOOGLE_CALENDAR_CLIENT_ID'
  | 'GOOGLE_CALENDAR_CLIENT_SECRET'
  | 'GOOGLE_CALENDAR_REFRESH_TOKEN'
  | 'SCHOOL_GOOGLE_CALENDAR_ID'

type GoogleEvent = {
  id?: string
  recurringEventId?: string
  summary?: string
  description?: string
  location?: string
  updated?: string
  status?: string
  originalStartTime?: { date?: string; dateTime?: string }
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
}

const shiftDate = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

const pragueDate = (instant: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(instant))

function eventTouchesRange(event: SchoolCalendarEvent, from: string, to: string) {
  if (event.allDay) return event.start.slice(0, 10) <= to && event.end.slice(0, 10) > from
  const start = Date.parse(event.start)
  const end = Date.parse(event.end)
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    && pragueDate(start) <= to && pragueDate(end - 1) >= from
}

function normalizeGoogleEvent(event: GoogleEvent): SchoolCalendarEvent | null {
  if (!event.id || event.status === 'cancelled' || !event.start || !event.end) return null
  const allDay = Boolean(event.start.date)
  const start = allDay ? event.start.date : event.start.dateTime
  const end = allDay ? event.end.date : event.end.dateTime
  if (!start || !end) return null
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)
  if ((!allDay && (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime)) || (allDay && end <= start)) return null
  const title = sanitizeCalendarText(event.summary || 'Školní událost', 300) || 'Školní událost'
  const location = sanitizeCalendarText(event.location, 500)
  // Popis vracíme jen jako čistý omezený text pro budoucí určení prostoru.
  const description = sanitizeCalendarText(event.description, 4_000)
  const instanceKey = event.originalStartTime?.dateTime || event.originalStartTime?.date || start
  const updatedTime = event.updated ? Date.parse(event.updated) : Number.NaN
  return {
    id: `${event.id}|${instanceKey}`,
    externalId: event.id,
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    title,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    start: allDay ? start : new Date(start).toISOString(),
    end: allDay ? end : new Date(end).toISOString(),
    allDay,
    ...(Number.isFinite(updatedTime) ? { updatedAt: new Date(updatedTime).toISOString() } : {}),
    source: 'google-calendar',
    collisionKind: 'none',
  }
}

async function json(response: Response) {
  try { return await response.json() as Record<string, unknown> } catch { return null }
}

export async function loadGoogleCalendarEvents({
  from, to, getSecret, fetch: request,
}: {
  from: string
  to: string
  getSecret: (name: SecretName) => string | undefined
  fetch: typeof fetch
}): Promise<SchoolCalendarEvent[]> {
  const clientId = getSecret('GOOGLE_CALENDAR_CLIENT_ID')?.trim()
  const clientSecret = getSecret('GOOGLE_CALENDAR_CLIENT_SECRET')?.trim()
  const refreshToken = getSecret('GOOGLE_CALENDAR_REFRESH_TOKEN')?.trim()
  const calendarId = getSecret('SCHOOL_GOOGLE_CALENDAR_ID')?.trim()
  if (!clientId || !clientSecret || !refreshToken || !calendarId) {
    throw new GoogleCalendarConfigurationError('Google Calendar není nakonfigurovaný.')
  }

  const tokenResponse = await request(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    redirect: 'error',
  })
  const tokenBody = await json(tokenResponse)
  const accessToken = typeof tokenBody?.access_token === 'string' ? tokenBody.access_token : ''
  if (!tokenResponse.ok || !accessToken) throw new GoogleCalendarAuthenticationError('Google autorizace selhala.')

  const output: SchoolCalendarEvent[] = []
  let pageToken = ''
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('showDeleted', 'false')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('timeZone', 'Europe/Prague')
    // Jednodenní UTC rezerva bezpečně pokryje CET/CEST; finální filtr je v Praze.
    url.searchParams.set('timeMin', `${shiftDate(from, -1)}T00:00:00Z`)
    url.searchParams.set('timeMax', `${shiftDate(to, 2)}T00:00:00Z`)
    url.searchParams.set('maxResults', '250')
    url.searchParams.set('fields', 'items(id,recurringEventId,summary,description,location,updated,status,originalStartTime,start,end),nextPageToken')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await request(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
    })
    const body = await json(response)
    if (!response.ok || !body || !Array.isArray(body.items)) throw new GoogleCalendarRemoteError('Google Calendar není dostupný.')
    for (const item of body.items as GoogleEvent[]) {
      const normalized = normalizeGoogleEvent(item)
      if (normalized && eventTouchesRange(normalized, from, to)) output.push(normalized)
      if (output.length > MAX_EVENTS) throw new GoogleCalendarRemoteError('Rozsah obsahuje příliš mnoho událostí.')
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
    if (!pageToken) break
    if (page === MAX_PAGES - 1) throw new GoogleCalendarRemoteError('Kalendář má příliš mnoho stránek.')
  }
  return [...new Map(output.map((event) => [event.id, event])).values()]
}
