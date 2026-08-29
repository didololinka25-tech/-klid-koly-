import test from 'node:test'
import assert from 'node:assert/strict'
import { isSameTaskDefinition } from './taskValidation.ts'

const entranceWindows = {
  roomId: 'room-entrance',
  title: 'Mytí oken',
  frequency: 'týdně',
  scheduleDays: [1],
  monthlyDay: null,
}

test('stejný název Mytí oken je platný v různých místnostech', () => {
  const kitchenWindows = { ...entranceWindows, roomId: 'room-kitchen' }
  assert.equal(isSameTaskDefinition(entranceWindows, kitchenWindows), false)
})

test('stejný úkol a harmonogram ve stejné místnosti je duplicita', () => {
  const reorderedDays = { ...entranceWindows, scheduleDays: [1, 1] }
  assert.equal(isSameTaskDefinition(entranceWindows, reorderedDays), true)
})

test('stejný název ve stejné místnosti s jiným harmonogramem není duplicita', () => {
  const monthlyWindows = { ...entranceWindows, frequency: 'měsíčně', scheduleDays: [], monthlyDay: 1 }
  assert.equal(isSameTaskDefinition(entranceWindows, monthlyWindows), false)
})

test('schedule_days jsou součástí identity harmonogramu bez závislosti na pořadí', () => {
  const first = { ...entranceWindows, scheduleDays: [5, 1, 3] }
  const second = { ...entranceWindows, scheduleDays: [1, 3, 5] }
  assert.equal(isSameTaskDefinition(first, second), true)
})
