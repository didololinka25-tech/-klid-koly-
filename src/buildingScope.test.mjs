import test from 'node:test'
import assert from 'node:assert/strict'
import { attendanceStartValues, forBuilding, roomForBuilding, selectedBuildingId } from './buildingScope.ts'

const school = { id: 'school', name: 'Škola', active: true }
const kindergarten = { id: 'kindergarten', name: 'Školka', active: true }
const rooms = [
  ...Array.from({ length: 5 }, (_, index) => ({ id: `school-${index}`, buildingId: school.id })),
  ...Array.from({ length: 11 }, (_, index) => ({ id: `kindergarten-${index}`, buildingId: kindergarten.id })),
]
const tasks = [
  ...Array.from({ length: 217 }, (_, index) => ({ id: `school-task-${index}`, buildingId: school.id })),
  ...Array.from({ length: 43 }, (_, index) => ({ id: `kindergarten-task-${index}`, buildingId: kindergarten.id })),
]

test('změna Škola na Školka skutečně změní vybrané buildingId', () => {
  assert.equal(selectedBuildingId('kindergarten', [school, kindergarten]), 'kindergarten')
  assert.equal(selectedBuildingId('missing', [school, kindergarten]), 'school')
})

test('Příchod předá do DB přesný building_id Školky', () => {
  assert.deepEqual(attendanceStartValues('worker', 'kindergarten', '2026-09-01T14:00:00Z', '2026-09-01'), {
    worker_id: 'worker', building_id: 'kindergarten', started_at: '2026-09-01T14:00:00Z', attendance_date: '2026-09-01',
  })
})

test('Správa filtruje 11 místností a 43 úkolů Školky podle buildingId', () => {
  assert.equal(forBuilding(rooms, 'kindergarten').length, 11)
  assert.equal(forBuilding(tasks, 'kindergarten').length, 43)
})

test('Provoz nepřijme room_id z jiné budovy', () => {
  assert.equal(roomForBuilding(rooms, 'school-1', 'kindergarten'), null)
  assert.equal(roomForBuilding(rooms, 'kindergarten-1', 'kindergarten'), 'kindergarten-1')
})
