import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySchoolCalendarScope,
  detectCleaningEventCollision,
  mappingForSchoolEvent,
  recommendCollisionResolution,
} from './schoolCalendarCollision.ts'

const event = (overrides = {}) => ({
  id: 'event-1|2026-09-07T15:00:00+02:00',
  externalId: 'event-1',
  recurringEventId: 'series-1',
  title: 'Porada',
  start: '2026-09-07T15:00:00+02:00',
  end: '2026-09-07T17:00:00+02:00',
  allDay: false,
  source: 'google-calendar',
  collisionKind: 'none',
  ...overrides,
})

const task = (id, roomId, room, floorId = 'floor-1', buildingId = 'school') => ({
  id, roomId, room, floorId, floor: '1. patro', floorSort: 1, buildingId, building: 'Škola',
  title: `Uklidit ${room}`, activityType: 'other', frequency: 'týdně', assignedTo: '', done: false,
  dueToday: true, sortOrder: 1, scheduleDays: [1], active: true,
})

const tasks = [task('t-1', 'room-a', 'Společenská místnost'), task('t-2', 'room-b', 'Jídelna')]
const window = { start: '2026-09-07T14:00:00+02:00', end: '2026-09-07T18:00:00+02:00', buildingId: 'school' }

test('událost mimo skutečné časové okno úklidu nemá kolizi', () => {
  const collision = detectCleaningEventCollision({ event: event({ start: '2026-09-07T10:00:00+02:00', end: '2026-09-07T11:00:00+02:00' }), tasks, cleaningWindows: [window] })
  assert.equal(collision.kind, 'NO_CONFLICT')
})

test('částečný i úplný překryv bez omezení prostoru jsou časové kolize', () => {
  const mappings = [{ id: 'm-1', externalEventId: 'event-1', scopeType: 'unrestricted', roomIds: [] }]
  for (const candidate of [event({ start: '2026-09-07T17:30:00+02:00', end: '2026-09-07T18:30:00+02:00' }), event()]) {
    assert.equal(detectCleaningEventCollision({ event: candidate, tasks, mappings, cleaningWindows: [window] }).kind, 'TIME_CONFLICT')
  }
})

test('celodenní událost a událost bez mapování zůstávají poctivě neurčené', () => {
  assert.equal(detectCleaningEventCollision({ event: event({ allDay: true, start: '2026-09-07', end: '2026-09-08' }), tasks }).kind, 'UNKNOWN_SCOPE_CONFLICT')
  assert.equal(detectCleaningEventCollision({ event: event(), tasks }).kind, 'UNKNOWN_SCOPE_CONFLICT')
})

test('mapování místnosti vrátí jen její úkoly a doporučí přesun pouze místnosti', () => {
  const mappings = [{ id: 'm-room', externalEventId: 'event-1', scopeType: 'rooms', buildingId: 'school', roomIds: ['room-a'] }]
  const collision = detectCleaningEventCollision({ event: event(), tasks, mappings, cleaningWindows: [window] })
  assert.equal(collision.kind, 'ROOM_CONFLICT')
  assert.deepEqual(collision.affectedTasks.map((item) => item.id), ['t-1'])
  assert.equal(recommendCollisionResolution(collision, 'pátek').kind, 'move_rooms')
})

test('mapování budovy nebo pracovní části hlásí building conflict', () => {
  const building = [{ id: 'm-building', externalEventId: 'event-1', scopeType: 'building', buildingId: 'school', roomIds: [] }]
  const floor = [{ id: 'm-floor', externalEventId: 'event-1', scopeType: 'floor', buildingId: 'school', floorId: 'floor-1', roomIds: [] }]
  assert.equal(detectCleaningEventCollision({ event: event(), tasks, mappings: building }).kind, 'BUILDING_CONFLICT')
  const collision = detectCleaningEventCollision({ event: event(), tasks, mappings: floor })
  assert.equal(collision.kind, 'BUILDING_CONFLICT')
  assert.equal(recommendCollisionResolution(collision).kind, 'move_scope')
})

test('konkrétní occurrence má přednost před sérií a potvrzený alias funguje bez hádání', () => {
  const mappings = [
    { id: 'series', recurringEventId: 'series-1', scopeType: 'building', buildingId: 'school', roomIds: [] },
    { id: 'instance', externalEventId: 'event-1', scopeType: 'rooms', buildingId: 'school', roomIds: ['room-a'] },
  ]
  assert.equal(mappingForSchoolEvent(event(), mappings, []).id, 'instance')
  const alias = { id: 'alias', alias: 'Tělocvična', scopeType: 'rooms', buildingId: 'school', roomIds: ['room-b'] }
  const mapped = applySchoolCalendarScope(event({ externalId: 'other', recurringEventId: undefined, location: '  tělocvična ' }), [], [alias])
  assert.deepEqual(mapped.affectedRoomIds, ['room-b'])
})

test('dvě události v jednom dni se vyhodnotí samostatně', () => {
  const mapping = { id: 'm-1', recurringEventId: 'series-1', scopeType: 'rooms', buildingId: 'school', roomIds: ['room-a'] }
  const collisions = [event(), event({ id: 'event-2', externalId: 'event-2', start: '2026-09-07T19:00:00+02:00', end: '2026-09-07T20:00:00+02:00' })]
    .map((item) => detectCleaningEventCollision({ event: item, tasks, mappings: [mapping], cleaningWindows: [window] }).kind)
  assert.deepEqual(collisions, ['ROOM_CONFLICT', 'NO_CONFLICT'])
})
