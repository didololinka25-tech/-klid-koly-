import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isAwaitingAccessApproval } from './system/access.ts'

const migrationUrl = new URL('../supabase/migrations/20260907052755_school_access_approval_workflow.sql', import.meta.url)

test('nový aktivní profile bez cleaning nebo module role je pending', () => {
  assert.equal(isAwaitingAccessApproval({ active: true, role: 'pending', hasModuleAccess: false }), true)
  assert.equal(isAwaitingAccessApproval({ active: true, role: 'pending', hasModuleAccess: true }), false)
  assert.equal(isAwaitingAccessApproval({ active: true, role: 'visitor', hasModuleAccess: false }), false)
})

test('approval RPC je owner-only, zakazuje self approval a validuje moduly i role', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /actor\.active[\s\S]*actor\.is_owner[\s\S]*actor\.access_role = 'admin'/i)
  assert.match(sql, /target_user_id = actor_id[\s\S]*Sami sebe/i)
  assert.match(sql, /assignment_module = 'cafeteria'[\s\S]*'parent', 'diner', 'kitchen', 'admin'/i)
  assert.match(sql, /assignment_module = 'cleaning'[\s\S]*'cleaning_team', 'visitor', 'admin'/i)
  assert.doesNotMatch(sql, /service_role/i)
  assert.match(sql, /revoke insert, delete on table public\.user_module_roles from authenticated/i)
  assert.match(sql, /Nový účet schvalte přes auditovaný schvalovací formulář/i)
})

test('schválení je atomické, přiřadí parent family a vytvoří audit', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /^--[\s\S]*\nbegin;/i)
  assert.match(sql, /insert into public\.user_module_roles/i)
  assert.match(sql, /insert into public\.cafeteria_family_users/i)
  assert.match(sql, /assignment_role = 'parent' and assignment_family_id is not null/i)
  assert.match(sql, /insert into public\.user_access_approval_events/i)
  assert.match(sql, /commit;\s*$/i)
})

test('audit má RLS, anon nemá přístup a poslední owner je chráněný', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /alter table public\.user_access_approval_events enable row level security/i)
  assert.match(sql, /revoke all on table public\.user_access_approval_events from public, anon, authenticated/i)
  assert.match(sql, /owner reads access approval audit[\s\S]*public\.is_owner/i)
  assert.match(sql, /private\.prevent_last_active_owner/i)
  assert.match(sql, /Posledního hlavního správce nelze odebrat ani deaktivovat/i)
  assert.match(sql, /revoke all on function public\.school_approve_user_access\(uuid, jsonb\) from public, anon, authenticated/i)
})

test('admin UI nabízí více rolí, rodinu a odděluje pending od schválených', async () => {
  const [component, app, repository] = await Promise.all([
    readFile(new URL('./system/AccessApprovalPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./system/accessApprovalRepository.ts', import.meta.url), 'utf8'),
  ])
  assert.match(component, /Čekají na schválení/)
  assert.match(component, /Přidat další roli/)
  assert.match(component, /Rodina \(volitelné\)/)
  assert.match(component, /Potvrdit schválení/)
  assert.match(app, /approvedUsers = users\.filter\(\(user\) => !isAwaitingAccessApproval\(user\)\)/)
  assert.match(repository, /rpc\('school_approve_user_access'/)
  assert.match(repository, /family_id: assignment\.familyId/)
})

test('uživatel bez přístupu vidí přesnou neutrální zprávu', async () => {
  const launcher = await readFile(new URL('./system/SystemLauncher.tsx', import.meta.url), 'utf8')
  assert.match(launcher, /Přístup čeká na schválení správcem\./)
})
