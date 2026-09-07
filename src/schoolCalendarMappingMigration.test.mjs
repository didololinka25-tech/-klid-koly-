import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations/20260907120000_school_calendar_scope_mappings.sql', import.meta.url)

test('calendar mapping migrace je additive, RLS-only a bez ukládání obsahu Google událostí', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /^--[\s\S]*\bbegin;/i)
  assert.match(sql, /commit;\s*$/i)
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i)
  assert.doesNotMatch(sql, /cleaning_tasks|cleaning_completions|attendance/i)
  assert.doesNotMatch(sql, /access_token|refresh_token|client_secret|event_title|description/i)
  for (const table of ['school_calendar_event_scope_mappings', 'school_calendar_event_scope_rooms', 'school_calendar_location_aliases']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'))
  }
})

test('calendar mapping migrace podporuje occurrence, sérii, alias a admin-only zápis', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /external_event_id/)
  assert.match(sql, /recurring_event_id/)
  assert.match(sql, /normalized_alias/)
  assert.match(sql, /admin_save_school_calendar_event_mapping/)
  assert.match(sql, /admin_save_school_calendar_location_alias/)
  assert.match(sql, /not public\.is_admin\(\)/)
  assert.match(sql, /revoke all on function[\s\S]+from public, anon/i)
  assert.match(sql, /grant execute on function[\s\S]+to authenticated/i)
})
