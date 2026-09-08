import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260908144827_manual_attendance_backfill.sql', import.meta.url), 'utf8')

test('Docházka nabízí mobilní zpětné doplnění všech požadovaných údajů', () => {
  assert.match(app, /Doplnit chybějící docházku/)
  assert.match(app, /type="date"[\s\S]*type="time"[\s\S]*type="time"/)
  assert.match(app, /Pracoviště[\s\S]*Poznámka/)
  assert.match(app, /Doplněno zpětně/)
})

test('repository používá omezené RPC a po zápisu vrací databázový záznam', () => {
  const method = repository.match(/createManualAttendance:[\s\S]*?deleteAttendance:/)?.[0] ?? ''
  assert.match(method, /rpc\('create_manual_attendance'/)
  assert.match(method, /target_worker_id: draft\.workerId/)
  assert.match(method, /target_building_id: draft\.buildingId/)
  assert.match(method, /entry_source/)
})

test('migrace vynucuje vlastní identitu, audit, immutable původ a overlap ochranu', () => {
  assert.match(migration, /target_worker_id <> actor_id and not public\.is_admin\(\)/i)
  assert.match(migration, /entry_source[\s\S]*manual_backfill/i)
  assert.match(migration, /record_manual_attendance_creation/i)
  assert.match(migration, /manual_creation/i)
  assert.match(migration, /protect_attendance_entry_origin/i)
  assert.match(migration, /when exclusion_violation[\s\S]*23P01/i)
  assert.match(migration, /revoke execute[\s\S]*from public, anon/i)
  assert.doesNotMatch(migration, /delete\s+from\s+public\.attendance/i)
})
