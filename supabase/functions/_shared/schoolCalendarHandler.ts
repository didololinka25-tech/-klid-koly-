import {
  GoogleCalendarAuthenticationError,
  GoogleCalendarConfigurationError,
  GoogleCalendarRemoteError,
  loadGoogleCalendarEvents,
} from './schoolCalendarGoogle.ts'
import type { SchoolCalendarErrorCode, SchoolCalendarEventsResult } from './schoolCalendarTypes.ts'

export const SCHOOL_CALENDAR_MAX_RANGE_DAYS = 62
export const SCHOOL_CALENDAR_FETCH_TIMEOUT_MS = 8_000

type AuthenticationResult = 'allowed' | 'unauthenticated' | 'forbidden'

export type SchoolCalendarHandlerDependencies = {
  authenticate: (authorizationHeader: string) => Promise<AuthenticationResult>
  getSecret: (name: 'GOOGLE_CALENDAR_CLIENT_ID' | 'GOOGLE_CALENDAR_CLIENT_SECRET' | 'GOOGLE_CALENDAR_REFRESH_TOKEN' | 'SCHOOL_GOOGLE_CALENDAR_ID') => string | undefined
  fetch: typeof fetch
  timeoutMs?: number
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

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, dependencies.timeoutMs ?? SCHOOL_CALENDAR_FETCH_TIMEOUT_MS)
  try {
    const guardedFetch: typeof fetch = (input, init = {}) => dependencies.fetch(input, { ...init, signal: controller.signal })
    const events = await loadGoogleCalendarEvents({
      from: record.from as string,
      to: record.to as string,
      getSecret: dependencies.getSecret,
      fetch: guardedFetch,
    })
    clearTimeout(timeout)
    return response({ ok: true, events }, 200)
  } catch (error) {
    clearTimeout(timeout)
    if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
      return failure('timeout', 'Školní kalendář nyní neodpovídá.', 504)
    }
    if (error instanceof GoogleCalendarConfigurationError) return failure('secret_missing', 'Školní kalendář zatím není připojený.', 503)
    if (error instanceof GoogleCalendarAuthenticationError) return failure('upstream_auth_error', 'Připojení ke školnímu kalendáři je potřeba obnovit.', 502)
    if (error instanceof GoogleCalendarRemoteError) return failure('remote_unavailable', 'Školní kalendář nyní není dostupný.', 502)
    return failure('remote_unavailable', 'Školní kalendář nyní není dostupný.', 502)
  }
}
