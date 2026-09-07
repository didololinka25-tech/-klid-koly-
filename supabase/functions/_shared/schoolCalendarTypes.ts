export type SchoolCalendarEvent = {
  id: string
  externalId: string
  recurringEventId?: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
  updatedAt?: string
  source: 'google-ics' | 'google-calendar'
  affectedBuildingId?: string
  affectedFloorId?: string
  affectedRoomId?: string
  affectedRoomIds?: string[]
  collisionKind: 'none' | 'possible' | 'confirmed'
  collisionReason?: string
}

export type SchoolCalendarErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_range'
  | 'secret_missing'
  | 'remote_unavailable'
  | 'timeout'
  | 'invalid_ics'
  | 'parser_error'
  | 'upstream_auth_error'

export type SchoolCalendarEventsResult =
  | { ok: true; events: SchoolCalendarEvent[] }
  | { ok: false; error: { code: SchoolCalendarErrorCode; message: string } }
