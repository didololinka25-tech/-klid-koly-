import type {
  SchoolCalendarErrorCode,
  SchoolCalendarEvent,
  SchoolCalendarEventsResult,
} from '../supabase/functions/_shared/schoolCalendarTypes'

const knownErrorCodes = new Set<SchoolCalendarErrorCode>([
  'unauthenticated', 'forbidden', 'invalid_range', 'secret_missing',
  'remote_unavailable', 'timeout', 'invalid_ics', 'parser_error',
])

function isEvent(value: unknown): value is SchoolCalendarEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return typeof event.id === 'string'
    && typeof event.externalId === 'string'
    && typeof event.title === 'string'
    && typeof event.start === 'string'
    && typeof event.end === 'string'
    && typeof event.allDay === 'boolean'
    && event.source === 'google-ics'
    && ['none', 'possible', 'confirmed'].includes(String(event.collisionKind))
}

export function parseSchoolCalendarResponse(value: unknown): SchoolCalendarEventsResult {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.ok === true && Array.isArray(record.events) && record.events.every(isEvent)) {
      return { ok: true, events: record.events }
    }
    if (record.ok === false && record.error && typeof record.error === 'object') {
      const error = record.error as Record<string, unknown>
      if (knownErrorCodes.has(error.code as SchoolCalendarErrorCode) && typeof error.message === 'string') {
        return { ok: false, error: { code: error.code as SchoolCalendarErrorCode, message: error.message } }
      }
    }
  }
  return {
    ok: false,
    error: { code: 'parser_error', message: 'Odpověď školního kalendáře není platná.' },
  }
}

export async function calendarInvokeFailure(error: unknown): Promise<SchoolCalendarEventsResult> {
  const context = error && typeof error === 'object' && 'context' in error
    ? (error as { context?: unknown }).context
    : null
  if (context instanceof Response) {
    try {
      return parseSchoolCalendarResponse(await context.clone().json())
    } catch {
      // The function may be temporarily unavailable before it can return JSON.
    }
  }
  return {
    ok: false,
    error: { code: 'remote_unavailable', message: 'Školní kalendář nyní není dostupný.' },
  }
}

export type { SchoolCalendarEvent, SchoolCalendarEventsResult }
