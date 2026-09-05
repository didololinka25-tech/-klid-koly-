import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260905004100_least_privilege_public_permissions.sql', import.meta.url),
  'utf8',
)

const frontendRpcNames = [
  ...readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8').matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g),
].map((match) => match[1])

const triggerOnlyFunctions = [
  'set_updated_at',
  'handle_new_user',
  'enforce_mopping_prerequisite',
  'audit_attendance_correction',
  'validate_cleaning_day_exception',
  'apply_room_cleaning_cycle',
  'record_attendance_audit',
  'enforce_attendance_integrity',
  'record_worker_contract_audit',
  'enforce_worker_work_assignment_unambiguous',
  'enforce_worker_schedule_exception_unambiguous',
  'enforce_cleaning_rotation_slot_unambiguous',
  'audit_dynamic_cleaning_schedule_change',
  'invalidate_future_dynamic_cleaning_plan',
  'invalidate_dynamic_plan_after_planning_worker_change',
  'enforce_cleaning_weekly_responsibility_unambiguous',
]

test('04100 is atomic, ACL-only, and does not change data or application schema', () => {
  assert.match(migration, /^--[\s\S]*\nbegin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\s+(?:into\s+|from\s+)?public\./i)
  assert.doesNotMatch(migration, /\b(?:create|alter|drop)\s+table\b/i)
  assert.doesNotMatch(migration, /\bcreate\s+(?:or\s+replace\s+)?function\b/i)
  assert.doesNotMatch(migration, /\bcreate\s+policy\b|\bdrop\s+policy\b/i)
})

test('04100 revokes inherited PUBLIC and direct anon table/function privileges', () => {
  assert.match(migration, /revoke all privileges on table %s from public, anon/i)
  assert.match(migration, /revoke execute on function %s from public, anon, authenticated/i)
  assert.match(migration, /has_table_privilege\('anon',[\s\S]*'TRIGGER'\)/i)
  assert.match(migration, /has_function_privilege\('anon',[\s\S]*'EXECUTE'\)/i)
  assert.match(migration, /aclexplode\([\s\S]*acl\.grantee = 0[\s\S]*acl\.privilege_type = 'EXECUTE'/i)
})

test('every literal frontend RPC remains in the authenticated allowlist', () => {
  assert.ok(frontendRpcNames.length > 20)
  for (const rpcName of new Set(frontendRpcNames)) {
    assert.match(migration, new RegExp(`public\\.${rpcName.replaceAll('_', '\\_')}\\(`))
  }
})

test('RLS authorization helpers retain authenticated execute', () => {
  for (const helper of [
    'current_access_role',
    'is_active_profile',
    'can_view_school_data',
    'can_work_in_app',
    'is_admin',
    'is_owner',
    'is_caretaker',
    'is_active_worker',
    'can_complete_task',
  ]) {
    assert.match(migration, new RegExp(`public\\.${helper}\\(`))
  }
})

test('trigger-only functions are inventoried but are not in authenticated allowlist', () => {
  const allowlistBlock = migration.match(/authenticated_signatures constant text\[\] := array\[([\s\S]*?)\n  \];/)?.[1] ?? ''
  for (const functionName of triggerOnlyFunctions) {
    assert.match(migration, new RegExp(`'${functionName}'`))
    assert.doesNotMatch(allowlistBlock, new RegExp(`public\\.${functionName}\\(`))
  }
})

test('legacy swap RPC is retained but denied to both client roles', () => {
  assert.match(
    migration,
    /revoke execute on function public\.swap_cleaning_work_parts\(\)\s+from public, anon, authenticated/i,
  )
  assert.match(
    migration,
    /has_function_privilege\('authenticated', 'public\.swap_cleaning_work_parts\(\)', 'EXECUTE'\)/i,
  )
  assert.doesNotMatch(migration, /grant execute on function public\.swap_cleaning_work_parts/i)
})

test('self-check requires RLS on every inventoried application table', () => {
  assert.match(migration, /relation\.relrowsecurity/i)
  assert.match(migration, /RLS není zapnuté na tabulce/i)
  assert.match(migration, /authenticated nemůže spustit vyžadovanou funkci/i)
  assert.match(migration, /authenticated má nečekané EXECUTE na interní funkci/i)
})
