import { InvalidIcsError, parseSchoolCalendarIcs } from './schoolCalendarParser.ts'
import type { SchoolCalendarErrorCode, SchoolCalendarEventsResult } from './schoolCalendarTypes.ts'

export const SCHOOL_CALENDAR_MAX_RANGE_DAYS = 62
export const SCHOOL_CALENDAR_FETCH_TIMEOUT_MS = 8_000
export const SCHOOL_CALENDAR_MAX_ICS_BYTES = 2 * 1024 * 1024
const GOOGLE_CALENDAR_ICS_HOSTS = new Set(['calendar.google.com', 'www.google.com'])

type AuthenticationResult = 'allowed' | 'unauthenticated' | 'forbidden'

export type SchoolCalendarHandlerDependencies = {
  authenticate: (authorizationHeader: string) => Promise<AuthenticationResult>
  getSecret: (name: 'SCHOOL_CALENDAR_ICS_URL') => string | undefined
  fetch: typeof fetch
  timeoutMs?: number
  maxIcsBytes?: number
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

function response(body: SchoolCalendarEventsResult, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

function failure(code: SchoolCalendarErrorCode, message: string, status: number) {
  return response({ ok: false, error: { code, message } }, status)
}

function parseDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

async function readLimitedText(remote: Response, maxBytes: number) {
  const advertisedSize = Number(remote.headers.get('content-length'))
  if (Number.isFinite(advertisedSize) && advertisedSize > maxBytes) throw new InvalidIcsError('Kalendář je příliš velký.')
  if (!remote.body) return ''
  const reader = remote.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new InvalidIcsError('Kalendář je příliš velký.')
    }
    chunks.push(value)
  }
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined)
}

function safeCalendarUrl(raw: string) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || !GOOGLE_CALENDAR_ICS_HOSTS.has(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

export async function handleSchoolCalendarRequest(
  request: Request,
  dependencies: SchoolCalendarHandlerDependencies,
): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') return failure('invalid_range', 'Použijte požadavek POST s rozsahem od–do.', 405)

  const authorization = request.headers.get('authorization')?.trim() ?? ''
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return failure('unauthenticated', 'Pro zobrazení školního kalendáře se přihlaste.', 401)
  }

  let authentication: AuthenticationResult
  try {
    authentication = await dependencies.authenticate(authorization)
  } catch {
    return failure('unauthenticated', 'Přihlášení se nepodařilo ověřit.', 401)
  }
  if (authentication === 'unauthenticated') return failure('unauthenticated', 'Přihlášení se nepodařilo ověřit.', 401)
  if (authentication === 'forbidden') return failure('forbidden', 'Nemáte oprávnění zobrazit školní kalendář.', 403)

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return failure('invalid_range', 'Zadejte platný rozsah kalendáře.', 400)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure('invalid_range', 'Zadejte platný rozsah kalendáře.', 400)
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'from' && key !== 'to')) {
    return failure('invalid_range', 'Povolené jsou pouze hodnoty from a to.', 400)
  }
  const fromDate = parseDate(record.from)
  const toDate = parseDate(record.to)
  if (!fromDate || !toDate || fromDate > toDate) {
    return failure('invalid_range', 'Rozsah kalendáře není platný.', 400)
  }
  const rangeDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1
  if (rangeDays > SCHOOL_CALENDAR_MAX_RANGE_DAYS) {
    return failure('invalid_range', `Kalendář lze načíst nejvýše na ${SCHOOL_CALENDAR_MAX_RANGE_DAYS} dní.`, 400)
  }

  const secret = dependencies.getSecret('SCHOOL_CALENDAR_ICS_URL')?.trim()
  if (!secret) return failure('secret_missing', 'Školní kalendář zatím není připojený.', 503)
  const url = safeCalendarUrl(secret)
  if (!url) return failure('secret_missing', 'Školní kalendář není bezpečně nakonfigurovaný.', 503)

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, dependencies.timeoutMs ?? SCHOOL_CALENDAR_FETCH_TIMEOUT_MS)
  let remote: Response
  try {
    remote = await dependencies.fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/calendar, text/plain;q=0.9' },
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
      return failure('timeout', 'Školní kalendář nyní neodpovídá.', 504)
    }
    return failure('remote_unavailable', 'Školní kalendář nyní není dostupný.', 502)
  }
  if (!remote.ok) {
    clearTimeout(timeout)
    return failure('remote_unavailable', 'Školní kalendář nyní není dostupný.', 502)
  }

  let ics: string
  try {
    ics = await readLimitedText(remote, dependencies.maxIcsBytes ?? SCHOOL_CALENDAR_MAX_ICS_BYTES)
  } catch (error) {
    clearTimeout(timeout)
    if (timedOut) return failure('timeout', 'Školní kalendář nyní neodpovídá.', 504)
    if (error instanceof InvalidIcsError) return failure('invalid_ics', error.message, 502)
    return failure('invalid_ics', 'Kalendář neposkytl čitelná data ICS.', 502)
  }
  clearTimeout(timeout)
  if (!/^BEGIN:VCALENDAR(?:\r?\n|$)/i.test(ics.trimStart())) {
    return failure('invalid_ics', 'Kalendář neposkytl platná data ICS.', 502)
  }

  try {
    const events = await parseSchoolCalendarIcs(ics, record.from as string, record.to as string)
    return response({ ok: true, events }, 200)
  } catch (error) {
    if (error instanceof InvalidIcsError) return failure('invalid_ics', error.message, 502)
    return failure('parser_error', 'Události školního kalendáře se nepodařilo zpracovat.', 502)
  }
}
