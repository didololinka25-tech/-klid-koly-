import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  InvalidIcsError,
  parseSchoolCalendarIcs,
  sanitizeCalendarText,
} from '../supabase/functions/_shared/schoolCalendarParser.ts'
import {
  handleSchoolCalendarRequest,
  SCHOOL_CALENDAR_MAX_RANGE_DAYS,
} from '../supabase/functions/_shared/schoolCalendarHandler.ts'
import { parseSchoolCalendarResponse } from './schoolCalendarApi.ts'

const calendar = (events, timezones = '') => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Klid Koly Test//CS',
  timezones.trim(),
  events.trim(),
  'END:VCALENDAR',
  '',
].filter(Boolean).join('\r\n')

const timed = calendar(`
BEGIN:VEVENT
UID:meeting@example.test
DTSTAMP:20260901T070000Z
DTSTART:20260907T130000Z
DTEND:20260907T143000Z
SUMMARY:Setkání rodičů
DESCRIPTION:<b>Důležité</b><script>alert(1)</script>
LOCATION:Společenská místnost
END:VEVENT`)

test('parser normalizuje jednorázovou událost, lokaci a nedůvěryhodný popis', async () => {
  const events = await parseSchoolCalendarIcs(timed, '2026-09-07', '2026-09-07')
  assert.equal(events.length, 1)
  assert.equal(events[0].externalId, 'meeting@example.test')
  assert.equal(events[0].title, 'Setkání rodičů')
  assert.equal(events[0].location, 'Společenská místnost')
  assert.equal(events[0].start, '2026-09-07T13:00:00.000Z')
  assert.equal(events[0].end, '2026-09-07T14:30:00.000Z')
  assert.equal(events[0].source, 'google-ics')
  assert.equal(events[0].collisionKind, 'none')
  assert.doesNotMatch(events[0].description, /<|>/)
  assert.match(events[0].description, /Důležité/)
})

test('parser zachová kalendářní den celodenní události bez timezone posunu', async () => {
  const ics = calendar(`
BEGIN:VEVENT
UID:holiday@example.test
DTSTART;VALUE=DATE:20260907
DTEND;VALUE=DATE:20260908
SUMMARY:Ředitelské volno
END:VEVENT`)
  const [event] = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-07')
  assert.equal(event.allDay, true)
  assert.equal(event.start, '2026-09-07')
  assert.equal(event.end, '2026-09-08')
})

test('RRULE respektuje EXDATE a RECURRENCE-ID override a používá stabilní instance id', async () => {
  const ics = calendar(`
BEGIN:VEVENT
UID:series@example.test
DTSTART:20260907T100000Z
DTEND:20260907T110000Z
RRULE:FREQ=DAILY;COUNT=4
EXDATE:20260908T100000Z
SUMMARY:Kroužek
END:VEVENT
BEGIN:VEVENT
UID:series@example.test
RECURRENCE-ID:20260909T100000Z
DTSTART:20260909T150000Z
DTEND:20260909T163000Z
SUMMARY:Kroužek přesunutý
END:VEVENT`)
  const first = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-10')
  const second = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-10')
  assert.deepEqual(first.map((item) => item.start), [
    '2026-09-07T10:00:00.000Z',
    '2026-09-09T15:00:00.000Z',
    '2026-09-10T10:00:00.000Z',
  ])
  assert.equal(first[1].title, 'Kroužek přesunutý')
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id))
  assert.equal(new Set(first.map((item) => item.id)).size, 3)
})

test('RECURRENCE-ID override se nikdy nepřiřadí k jiné sérii ve stejném feedu', async () => {
  const ics = calendar(`
BEGIN:VEVENT
UID:first@example.test
DTSTART:20260907T100000Z
DTEND:20260907T110000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:První série
END:VEVENT
BEGIN:VEVENT
UID:second@example.test
DTSTART:20260907T120000Z
DTEND:20260907T130000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Druhá série
END:VEVENT
BEGIN:VEVENT
UID:second@example.test
RECURRENCE-ID:20260908T120000Z
DTSTART:20260908T150000Z
DTEND:20260908T160000Z
SUMMARY:Druhá série přesunutá
END:VEVENT`)
  const events = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-08')
  assert.deepEqual(events.map((item) => `${item.externalId}:${item.start}`), [
    'first@example.test:2026-09-07T10:00:00.000Z',
    'second@example.test:2026-09-07T12:00:00.000Z',
    'first@example.test:2026-09-08T10:00:00.000Z',
    'second@example.test:2026-09-08T15:00:00.000Z',
  ])
})

test('událost bez LOCATION zůstane platná a nemá v odpovědi prázdné pole', async () => {
  const ics = calendar(`
BEGIN:VEVENT
UID:no-location@example.test
DTSTART:20260907T100000Z
DTEND:20260907T110000Z
SUMMARY:Porada
END:VEVENT`)
  const [event] = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-07')
  assert.equal('location' in event, false)
})

test('Europe/Prague VTIMEZONE respektuje přechod z letního na zimní čas', async () => {
  const timezones = `
BEGIN:VTIMEZONE
TZID:Europe/Prague
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
END:STANDARD
END:VTIMEZONE`
  const ics = calendar(`
BEGIN:VEVENT
UID:dst@example.test
DTSTART;TZID=Europe/Prague:20261024T100000
DTEND;TZID=Europe/Prague:20261024T110000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Ranní akce
END:VEVENT`, timezones)
  const events = await parseSchoolCalendarIcs(ics, '2026-10-24', '2026-10-26')
  assert.deepEqual(events.map((item) => item.start), [
    '2026-10-24T08:00:00.000Z',
    '2026-10-25T09:00:00.000Z',
    '2026-10-26T09:00:00.000Z',
  ])
})

test('Europe/Prague a běžné CET/CEST aliasy se neztratí ani bez vložené VTIMEZONE', async () => {
  const ics = calendar(`
BEGIN:VEVENT
UID:prague-no-vtimezone@example.test
DTSTART;TZID=Europe/Prague:20260907T100000
DTEND;TZID=Europe/Prague:20260907T110000
SUMMARY:Pražská událost
END:VEVENT
BEGIN:VEVENT
UID:cest@example.test
DTSTART;TZID=CEST:20260908T100000
DTEND;TZID=CEST:20260908T110000
SUMMARY:Událost CEST
END:VEVENT`)
  const events = await parseSchoolCalendarIcs(ics, '2026-09-07', '2026-09-08')
  assert.deepEqual(events.map((item) => item.start), [
    '2026-09-07T08:00:00.000Z',
    '2026-09-08T08:00:00.000Z',
  ])
})

test('sanitizace omezuje délku a odstraňuje aktivní HTML i řídicí znaky', () => {
  const cleaned = sanitizeCalendarText(`<img src=x onerror=alert(1)>A\u0000${'b'.repeat(400)}`, 30)
  assert.equal(cleaned.length, 30)
  assert.doesNotMatch(cleaned, /<|>|\u0000/)
  assert.equal(sanitizeCalendarText('&lt;script&gt;alert(1)&lt;/script&gt; Text', 100), 'alert(1) Text')
})

test('chybný ICS je odmítnutý kontrolovanou chybou', async () => {
  await assert.rejects(
    parseSchoolCalendarIcs('not a calendar', '2026-09-01', '2026-09-02'),
    InvalidIcsError,
  )
})

const authorizedRequest = (body = { from: '2026-09-01', to: '2026-09-30' }) => new Request(
  'https://project.supabase.co/functions/v1/school-calendar-events',
  {
    method: 'POST',
    headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
)

const handlerDependencies = (overrides = {}) => ({
  authenticate: async () => 'allowed',
  getSecret: (name) => ({
    GOOGLE_CALENDAR_CLIENT_ID: 'test-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'test-secret',
    GOOGLE_CALENDAR_REFRESH_TOKEN: 'test-refresh',
    SCHOOL_GOOGLE_CALENDAR_ID: 'private-school@example.test',
  })[name],
  fetch: async (input) => String(input).includes('oauth2.googleapis.com')
    ? Response.json({ access_token: 'short-lived-token', expires_in: 3600 })
    : Response.json({ items: [{
      id: 'event-1', recurringEventId: 'series-1', summary: 'Setkání rodičů',
      description: '<b>Důležité</b><script>alert(1)</script>', location: 'Společenská místnost',
      originalStartTime: { dateTime: '2026-09-07T15:00:00+02:00' },
      start: { dateTime: '2026-09-07T15:00:00+02:00' }, end: { dateTime: '2026-09-07T16:30:00+02:00' },
    }] }),
  ...overrides,
})

test('Edge handler odmítne nepřihlášený request ještě před fetch', async () => {
  let fetched = false
  const result = await handleSchoolCalendarRequest(new Request('https://example.test', { method: 'POST' }), handlerDependencies({
    fetch: async () => { fetched = true; return new Response(timed) },
  }))
  assert.equal(result.status, 401)
  assert.equal((await result.json()).error.code, 'unauthenticated')
  assert.equal(fetched, false)
})

test('Edge handler vynutí can_view_school_data výsledek', async () => {
  const result = await handleSchoolCalendarRequest(authorizedRequest(), handlerDependencies({ authenticate: async () => 'forbidden' }))
  assert.equal(result.status, 403)
  assert.equal((await result.json()).error.code, 'forbidden')
})

test('Edge handler validuje datum, pořadí, extra parametry a maximální interval', async () => {
  for (const body of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-09-02', to: '2026-09-01' },
    { from: '2026-01-01', to: '2026-04-01' },
    { from: '2026-09-01', to: '2026-09-02', url: 'https://attacker.test/feed.ics' },
  ]) {
    const result = await handleSchoolCalendarRequest(authorizedRequest(body), handlerDependencies())
    assert.equal(result.status, 400)
    assert.equal((await result.json()).error.code, 'invalid_range')
  }
  assert.equal(SCHOOL_CALENDAR_MAX_RANGE_DAYS, 62)
})

test('Edge handler vrátí kontrolovanou chybu při chybějícím secretu', async () => {
  const result = await handleSchoolCalendarRequest(authorizedRequest(), handlerDependencies({ getSecret: () => undefined }))
  assert.equal(result.status, 503)
  assert.deepEqual(await result.json(), {
    ok: false,
    error: { code: 'secret_missing', message: 'Školní kalendář zatím není připojený.' },
  })
})

test('Edge handler rozliší timeout, nedostupný zdroj a Google auth chybu bez úniku secrets', async () => {
  const secret = 'SUPER-SECRET'
  const cases = [
    {
      expected: 'timeout',
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException(secret, 'AbortError')))),
      timeoutMs: 1,
    },
    { expected: 'remote_unavailable', fetch: async () => { throw new Error(secret) } },
    { expected: 'upstream_auth_error', fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) },
  ]
  for (const item of cases) {
    const result = await handleSchoolCalendarRequest(authorizedRequest(), handlerDependencies({
      getSecret: () => secret,
      fetch: item.fetch,
      timeoutMs: item.timeoutMs,
    }))
    const text = await result.text()
    assert.equal(JSON.parse(text).error.code, item.expected)
    assert.doesNotMatch(text, /SUPER-SECRET|oauth2\.googleapis\.com|private-school/)
  }
})

test('Edge handler vrátí normalizované Google occurrence a nikdy token ani calendar id', async () => {
  const result = await handleSchoolCalendarRequest(authorizedRequest({ from: '2026-09-07', to: '2026-09-07' }), handlerDependencies())
  const text = await result.text()
  const parsed = parseSchoolCalendarResponse(JSON.parse(text))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].source, 'google-calendar')
  assert.equal(parsed.events[0].externalId, 'event-1')
  assert.equal(parsed.events[0].recurringEventId, 'series-1')
  assert.doesNotMatch(parsed.events[0].description, /<|>/)
  assert.doesNotMatch(text, /short-lived-token|test-refresh|test-secret|private-school/)
})

test('Google API request používá read-only serverový events.list, rozbalené occurrence a pražské pásmo', async () => {
  const requests = []
  const result = await handleSchoolCalendarRequest(authorizedRequest({ from: '2026-10-24', to: '2026-10-26' }), handlerDependencies({
    fetch: async (input, init) => {
      requests.push({ url: String(input), authorization: init?.headers?.Authorization })
      return String(input).includes('oauth2.googleapis.com')
        ? Response.json({ access_token: 'short-lived-token' })
        : Response.json({ items: [{ id: 'holiday', summary: 'Prázdniny', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } }] })
    },
  }))
  assert.equal(result.status, 200)
  const api = new URL(requests[1].url)
  assert.equal(api.searchParams.get('singleEvents'), 'true')
  assert.equal(api.searchParams.get('showDeleted'), 'false')
  assert.equal(api.searchParams.get('timeZone'), 'Europe/Prague')
  assert.match(api.searchParams.get('fields'), /recurringEventId/)
  assert.equal(requests[1].authorization, 'Bearer short-lived-token')
  const body = await result.json()
  assert.equal(body.events[0].allDay, true)
  assert.equal(body.events[0].start, '2026-10-25')
})

test('produkční Edge entrypoint ověřuje Supabase usera a can_view_school_data bez service role', async () => {
  const source = await readFile(new URL('../supabase/functions/school-calendar-events/index.ts', import.meta.url), 'utf8')
  assert.match(source, /auth\.getUser\(token\)/)
  assert.match(source, /rpc\('can_view_school_data'\)/)
  assert.doesNotMatch(source, /SERVICE_ROLE|provider_token|provider_refresh_token|calendar\.google/)
})

test('frontend repository drží Google Edge Function oddělenou od planneru', async () => {
  const repository = await readFile(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
  const calendarModel = await readFile(new URL('./cleaningCalendar.ts', import.meta.url), 'utf8')
  const method = repository.match(/getSchoolCalendarEvents:[\s\S]*?\n  },/)?.[0] ?? ''
  assert.match(method, /functions\.invoke\('school-calendar-events'/)
  assert.match(method, /body:\s*\{ from, to \}/)
  assert.doesNotMatch(method, /\bload\(|planner|cleaning_tasks|completion/i)
  assert.match(calendarModel, /schoolEvents: schoolEvents\.filter/)
  assert.doesNotMatch(calendarModel, /getSchoolCalendarEvents/)
})
