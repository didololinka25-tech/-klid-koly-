import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260831002900_restore_own_profile_name_rpc.sql', import.meta.url), 'utf8')
const preservationMigration = readFileSync(new URL('../supabase/migrations/20260901003200_preserve_profile_display_name.sql', import.meta.url), 'utf8')
const repository = readFileSync(new URL('./schoolRepository.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const rpcBody = migration.match(/create or replace function public\.update_own_profile_name[\s\S]*?\n\$\$;/i)?.[0] ?? ''

test('změna zobrazovaného jména přijímá pouze text a identitu bere z auth.uid', () => {
  assert.match(rpcBody, /update_own_profile_name\(new_full_name text\)/i)
  assert.match(rpcBody, /actor_id uuid := auth\.uid\(\)/i)
  assert.match(rpcBody, /where id = actor_id/i)
  assert.doesNotMatch(rpcBody, /target_user|user_id/i)
})

test('RPC mění pouze vlastní full_name a updated_at, nikoli autorizační údaje', () => {
  assert.match(rpcBody, /set full_name = cleaned_name,\s*updated_at = now\(\)/i)
  assert.doesNotMatch(rpcBody, /access_role\s*=|is_owner\s*=|\brole\s*=|email\s*=/i)
  assert.match(migration, /revoke insert, update, delete on public\.profiles from anon, authenticated/i)
})

test('pending a neaktivní profil nemohou jméno změnit, schválené role ano', () => {
  assert.match(rpcBody, /public\.can_view_school_data\(\)/i)
  assert.match(rpcBody, /and active\s+and access_role in \('cleaning_team', 'admin', 'visitor'\)/i)
})

test('prázdné, příliš dlouhé a řídicí znaky jsou odmítnuty na klientu i serveru', () => {
  assert.match(repository, /cleanedName\.length < 2 \|\| cleanedName\.length > 100/)
  assert.match(repository, /\\u0000-\\u001f/)
  assert.match(rpcBody, /char_length\(cleaned_name\) < 2 or char_length\(cleaned_name\) > 100/i)
  assert.match(rpcBody, /\[\[:cntrl:\]\]/i)
})

test('UI po úspěchu aktualizuje profil i odvozená jména bez reloadu', () => {
  assert.match(app, /setProfile\([\s\S]*full_name: savedName/)
  assert.match(app, /setAttendanceWorkers\([\s\S]*name: savedName/)
  assert.match(app, /setUsers\([\s\S]*fullName: savedName/)
  assert.match(app, /setTasks\([\s\S]*completedBy: savedName/)
  assert.match(app, /setBulkActions\([\s\S]*workerName: savedName/)
  assert.match(app, /setNotice\("Profil byl uložen\."\)/)
  assert.match(repository, /from\('profiles'\)\.select\('id,full_name/)
})

test('chyba RPC zůstane uživateli čitelná a formulář se zavře jen po úspěchu', () => {
  assert.match(repository, /if \(error\) throw new Error\(error\.message/)
  assert.match(app, /const savedName = await schoolRepository\.updateOwnProfileName\(fullName\);[\s\S]*closeProfileEditor\(\)/)
  assert.match(app, /catch \(error\)[\s\S]*error instanceof Error \? error\.message/)
})

test('auth refresh a další Google login zachovají uživatelem uložené full_name', () => {
  assert.match(preservationMigration, /create or replace function public\.handle_new_user\(\)/i)
  assert.match(preservationMigration, /coalesce\(nullif\(btrim\(profiles\.full_name\), ''\), excluded\.full_name\)/i)
  assert.doesNotMatch(preservationMigration, /set full_name = excluded\.full_name,/i)
  assert.match(preservationMigration, /after update of email, last_sign_in_at, raw_user_meta_data on auth\.users/i)
})

test('oprava auth synchronizace nemění role, owner ani existující profily hromadným updatem', () => {
  assert.doesNotMatch(preservationMigration, /update public\.profiles\s+set/i)
  assert.doesNotMatch(preservationMigration, /is_owner\s*=/i)
  assert.doesNotMatch(preservationMigration, /access_role\s*=\s*excluded/i)
  assert.match(preservationMigration, /revoke all on function public\.handle_new_user\(\) from public, anon, authenticated/i)
})
