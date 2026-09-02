import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildTodayWorkBlocks,
  incompleteWorkBlockTasksByRoom,
  mandatoryWorkBlockProgress,
  undoableWorkBlockActions,
  workBlockIsComplete,
} from './todayWorkBlocks.ts'
import { applyBulkUndo } from './cleaningBulk.ts'

const task = (id, room, floor, overrides = {}) => ({
  id,
  roomId: `room-${room}`,
  room,
  floorId: `floor-${floor}`,
  floor,
  floorSort: Number.parseInt(floor, 10) || 10,
  buildingId: 'school',
  building: 'Škola',
  title: 'Zamést / vysát podlahu',
  activityType: 'vacuum',
  frequency: 'denně',
  assignedTo: '',
  done: false,
  canComplete: true,
  dueToday: true,
  sortOrder: 10,
  scheduleDays: [1, 3, 5],
  active: true,
  roomActive: true,
  bulkCompletable: true,
  plannerReason: 'routine',
  ...overrides,
})

test('solo směna vytvoří jednu povinnou Podlahy 1F a nepovinnou WC frontu odspodu', () => {
  const plan = buildTodayWorkBlocks([
    task('floor', 'Kuchyň', '1. patro'),
    task('wc1', 'WC ženy', '1. patro', { plannerReason: 'wc-queue', activityType: 'toilet' }),
    task('wc2', 'WC dospělí', '2. patro', { plannerReason: 'wc-queue', activityType: 'toilet' }),
    task('wc3', 'WC / sprcha', '3. patro', { plannerReason: 'wc-queue', activityType: 'toilet' }),
  ])
  assert.deepEqual(plan[0].blocks.map((block) => block.title), ['Podlahy – 1. patro'])
  assert.equal(plan[0].wcQueue?.title, 'WC – otevřená fronta')
  assert.deepEqual(plan[0].wcQueue?.rooms.map((room) => room.floor), ['1. patro', '2. patro', '3. patro'])
  assert.deepEqual(mandatoryWorkBlockProgress(plan), { total: 1, done: 0 })
})

test('dvě pracovnice vidí 1F, celou školu WC a rotační patro jako tři celky', () => {
  const plan = buildTodayWorkBlocks([
    task('f1', 'Kuchyň', '1. patro'),
    task('wc1', 'WC ženy', '1. patro', { activityType: 'toilet' }),
    task('wc2', 'WC dospělí', '2. patro', { activityType: 'toilet' }),
    task('f2', 'Učebna 1', '2. patro'),
  ])
  assert.deepEqual(plan[0].blocks.map((block) => block.title), [
    'Podlahy – 1. patro',
    'Podlahy – 2. patro',
    'WC – celá škola',
  ])
  assert.equal(mandatoryWorkBlockProgress(plan).total, 3)
})

test('tři a více pracovníků vidí podlahy 1F/2F/3F a všechna WC', () => {
  const plan = buildTodayWorkBlocks([
    task('f1', 'Kuchyň', '1. patro'),
    task('f2', 'Učebna 1', '2. patro'),
    task('f3', 'Ateliér', '3. patro'),
    task('wc1', 'WC ženy', '1. patro', { activityType: 'toilet' }),
    task('wc3', 'WC holky', '3. patro', { activityType: 'toilet' }),
  ])
  assert.deepEqual(plan[0].blocks.map((block) => block.title), [
    'Podlahy – 1. patro',
    'Podlahy – 2. patro',
    'Podlahy – 3. patro',
    'WC – celá škola',
  ])
})

test('bulk celku posílá jen nedokončené tasky po místnostech a chrání cizí hotovou práci', () => {
  const plan = buildTodayWorkBlocks([
    task('old', 'Kuchyň', '1. patro', { done: true, completedById: 'other-worker' }),
    task('new-1', 'Kuchyň', '1. patro', { activityType: 'mop', prerequisite: 'old' }),
    task('new-2', 'Jídelna', '1. patro'),
  ])
  assert.deepEqual(incompleteWorkBlockTasksByRoom(plan[0].blocks[0]).map((items) => items.map((item) => item.id)).sort(), [
    ['new-1'],
    ['new-2'],
  ].sort())
})

test('work block je hotový až po všech běžných tasks a nabídne jen auditované room actions', () => {
  const plan = buildTodayWorkBlocks([
    task('old', 'Kuchyň', '1. patro', { done: true, completedById: 'other-worker' }),
    task('bulk', 'Kuchyň', '1. patro', { done: true, activityType: 'mop' }),
  ])
  const block = plan[0].blocks[0]
  assert.equal(workBlockIsComplete(block), true)
  const actions = undoableWorkBlockActions(block, [{ id: 'action', roomId: 'room-Kuchyň', taskIds: ['bulk'], canUndo: true }])
  assert.deepEqual(actions.map((action) => action.id), ['action'])
  assert.equal(actions[0].taskIds.includes('old'), false)

  const afterUndo = applyBulkUndo(block.tasks, actions[0].taskIds)
  const refreshed = buildTodayWorkBlocks(afterUndo)
  assert.deepEqual(mandatoryWorkBlockProgress(refreshed), { total: 1, done: 0 })
  assert.equal(afterUndo.find((item) => item.id === 'old')?.done, true)
})

test('podrobnosti zachovají jednotlivé místnosti a tasky', () => {
  const plan = buildTodayWorkBlocks([
    task('k1', 'Kuchyň', '1. patro'),
    task('k2', 'Kuchyň', '1. patro', { activityType: 'mop', title: 'Vytřít podlahu' }),
    task('j1', 'Jídelna', '1. patro'),
  ])
  assert.deepEqual(plan[0].blocks[0].rooms.map((room) => [room.name, room.tasks.length]), [['Jídelna', 1], ['Kuchyň', 2]])
})

test('mobilní work block layout nemá pevnou šířku ani horizontální overflow', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.work-block-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+116px/)
  assert.match(css, /\.work-block-card\s*\{[^}]*min-width:\s*0/)
  assert.doesNotMatch(css, /\.work-block-card\s*\{[^}]*width:\s*\d{3,}px/)
})
