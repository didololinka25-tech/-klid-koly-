import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBulkUndo, bulkTasks, findUndoableRoomAction, isBulkCompletableTask, orderTasksByDependency } from './cleaningBulk.ts'

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

test('undo vrátí přesně pět úkolů vytvořených bulk akcí', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task(`bulk-${index}`, { done: true, completedBy: 'Didi' }))
  const result = applyBulkUndo(tasks, tasks.map((item) => item.id))
  assert.equal(result.filter((item) => item.done).length, 0)
})

test('undo zachová dva dříve hotové úkoly i jejich autory', () => {
  const earlier = [task('earlier-dana', { done: true, completedBy: 'Dana' }), task('earlier-martina', { done: true, completedBy: 'Martina' })]
  const bulk = Array.from({ length: 5 }, (_, index) => task(`bulk-${index}`, { done: true, completedBy: 'Didi' }))
  const result = applyBulkUndo([...earlier, ...bulk], bulk.map((item) => item.id))
  assert.deepEqual(result.filter((item) => item.done).map((item) => item.completedBy), ['Dana', 'Martina'])
})

test('progress místnosti po undo odpovídá pouze zbývajícím completion', () => {
  const prior = task('prior', { done: true, completedBy: 'Dana' })
  const bulk = [task('vacuum', { done: true }), task('mop', { done: true, prerequisite: 'vacuum' })]
  const result = applyBulkUndo([prior, ...bulk], ['vacuum', 'mop'])
  assert.equal(result.filter((item) => item.done).length, 1)
})

test('dokončená místnost s jednou auditovanou bulk akcí nabídne správné undo', () => {
  const tasks = [task('prior', { done: true }), task('bulk-1', { done: true }), task('bulk-2', { done: true })]
  const action = { id: 'action-028', roomId: 'room-1', taskIds: ['bulk-1', 'bulk-2'], canUndo: true }
  assert.equal(findUndoableRoomAction(tasks, [action])?.id, 'action-028')
})

test('stará bulk completion bez identity nenabídne undo', () => {
  assert.equal(findUndoableRoomAction([task('old', { done: true })], []), undefined)
})

test('při více vratných akcích stejné místnosti UI žádnou akci nehádá', () => {
  const tasks = [task('one', { done: true }), task('two', { done: true })]
  const actions = [
    { id: 'first', roomId: 'room-1', taskIds: ['one'], canUndo: true },
    { id: 'second', roomId: 'room-1', taskIds: ['two'], canUndo: true },
  ]
  assert.equal(findUndoableRoomAction(tasks, actions), undefined)
})
