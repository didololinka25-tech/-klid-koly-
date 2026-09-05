import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  normalizeCafeteriaRoles,
  resolveModuleAccess,
  isMissingCafeteriaSchema,
  routeAllowed,
  routeFromHash,
  routeHash,
} from './system/access.ts'

test('oprávnění rozhodují nezávisle o Úklidu a Jídelně', () => {
  const access = resolveModuleAccess({
    profileActive: true,
    cleaningAccessRole: 'cleaning_team',
    moduleRoles: [{ module: 'cafeteria', role: 'parent' }],
    cafeteriaAvailable: true,
  })
  assert.equal(access.cleaning, true)
  assert.equal(access.cafeteria, true)
})

test('uživatel může mít více cafeteria rolí bez ztráty pořadí a duplicit', () => {
  assert.deepEqual(normalizeCafeteriaRoles([
    { module: 'cafeteria', role: 'admin' },
    { module: 'cafeteria', role: 'parent' },
    { module: 'cafeteria', role: 'parent' },
    { module: 'cleaning', role: 'admin' },
  ]), ['parent', 'admin'])
})

test('pending uživatel bez modulové role nemá žádný modul', () => {
  const access = resolveModuleAccess({ profileActive: true, cleaningAccessRole: 'pending', moduleRoles: [], cafeteriaAvailable: true })
  assert.equal(access.cleaning, false)
  assert.equal(access.cafeteria, false)
})

test('chybějící cafeteria migrace je kompatibilní stav, ne pád Úklidu', () => {
  assert.equal(isMissingCafeteriaSchema({ code: '42P01' }), true)
  assert.equal(isMissingCafeteriaSchema({ code: 'PGRST205' }), true)
  assert.equal(isMissingCafeteriaSchema({ code: '42501' }), false)
  const access = resolveModuleAccess({ profileActive: true, cleaningAccessRole: 'admin', moduleRoles: [], cafeteriaAvailable: false })
  assert.equal(access.cleaning, true)
  assert.equal(access.cafeteria, false)
})

test('hash navigace přežije refresh a browser back může vrátit launcher', () => {
  assert.equal(routeFromHash('#/cleaning'), 'cleaning')
  assert.equal(routeFromHash('#/cafeteria'), 'cafeteria')
  assert.equal(routeFromHash(''), 'launcher')
  assert.equal(routeHash('launcher'), '#/')
  assert.equal(routeHash('cleaning'), '#/cleaning')
  const noCafeteria = resolveModuleAccess({ profileActive: true, cleaningAccessRole: 'visitor', moduleRoles: [], cafeteriaAvailable: false })
  assert.equal(routeAllowed('cleaning', noCafeteria), true)
  assert.equal(routeAllowed('cafeteria', noCafeteria), false)
})

test('foundation migrace zachovává identitu, více rolí, owner seed a RLS', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260905192258_cafeteria_foundation.sql', import.meta.url), 'utf8')
  const tables = ['user_module_roles', 'cafeteria_families', 'cafeteria_family_users', 'cafeteria_accounts', 'cafeteria_portion_categories', 'cafeteria_diners', 'cafeteria_price_rules', 'cafeteria_settings', 'cafeteria_meal_days', 'cafeteria_meal_variants']
  for (const table of tables) assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  assert.match(migration, /primary key \(user_id, module, role\)/i)
  assert.match(migration, /user_id uuid not null references public\.profiles\(id\)/i)
  assert.match(migration, /where profile\.active and profile\.is_owner/i)
  assert.match(migration, /on conflict \(user_id, module, role\) do nothing/i)
  assert.doesNotMatch(migration, /raw_user_meta_data|user_metadata|service_role/i)
  assert.doesNotMatch(migration, /70|80|Dítě A|Testovací rodina/i)
})

test('RLS účtů nepřiděluje kuchyni finance a frontend necachuje Supabase data', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260905192258_cafeteria_foundation.sql', import.meta.url), 'utf8')
  const vite = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8')
  const accountPolicy = migration.match(/create policy "cafeteria accounts visible[\s\S]*?;\s*create policy "cafeteria admins add accounts"/i)?.[0] ?? ''
  assert.doesNotMatch(accountPolicy, /kitchen/)
  assert.match(accountPolicy, /cafeteria_family_users/)
  assert.match(accountPolicy, /cafeteria_diners/)
  assert.match(vite, /supabase\\\.co[\s\S]*handler: 'NetworkOnly'/)
})
