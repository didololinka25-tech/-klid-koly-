import test from 'node:test'
import assert from 'node:assert/strict'
import { bulkTasks, isBulkCompletableTask, orderTasksByDependency } from './cleaningBulk.ts'

const task = (id, overrides = {}) => ({
  id, roomId: 'room-1', room: 'Jídelna', floor: '1. patro', floorSort: 1,
  building: 'Škola', title: id, activityType: 'other', frequency: 'denně',
  assignedTo: 'Úklidový tým', done: false, dueToday: true, sortOrder: 10,
  scheduleDays: [1, 3, 5], active: true, roomActive: true, bulkCompletable: true,
  ...overrides,
})

test('rychlé dokončení zahrne běžné úkoly a vynechá speciální práce', () => {
  const routine = task('koš', { activityType: 'trash' })
  const windows = task('okna', { activityType: 'windows', frequency: 'měsíčně', periodMonths: 1 })
  const laundry = task('praní', { activityType: 'laundry' })
  const extraordinary = task('mimořádný', { frequency: 'mimořádně' })
  assert.deepEqual(bulkTasks([routine, windows, laundry, extraordinary]).map((item) => item.id), ['koš'])
  assert.equal(isBulkCompletableTask(windows), false, 'ani chybné explicitní true nesmí povolit okna')
})

test('hromadné dokončení seřadí zametení před vytřením', () => {
  const vacuum = task('vacuum', { activityType: 'vacuum', sortOrder: 20 })
  const mop = task('mop', { activityType: 'mop', prerequisite: 'vacuum', sortOrder: 10 })
  assert.deepEqual(orderTasksByDependency([mop, vacuum]).map((item) => item.id), ['vacuum', 'mop'])
})

test('již hotový úkol se znovu neposílá a jeho autor se tím nepřepisuje', () => {
  const done = task('koš', { done: true, completedBy: 'Dana' })
  const remaining = task('podlaha', { activityType: 'vacuum' })
  assert.deepEqual(orderTasksByDependency([done, remaining]).map((item) => item.id), ['podlaha'])
})

test('neplatná chybějící závislost je srozumitelně odmítnuta', () => {
  const mop = task('mop', { activityType: 'mop', prerequisite: 'vacuum' })
  assert.throws(() => orderTasksByDependency([mop]), /Nejdříve dokončete/)
})
