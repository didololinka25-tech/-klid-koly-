import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const ids = {
  owner: '00000000-0000-0000-0000-000000000001',
  ordinary: '00000000-0000-0000-0000-000000000002',
  pending: '00000000-0000-0000-0000-000000000003',
  invalid: '00000000-0000-0000-0000-000000000004',
  family: '00000000-0000-0000-0000-000000000005',
}

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create schema private;
  create type public.app_role as enum ('cleaner', 'caretaker');

  create function auth.uid()
  returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.profiles (
    id uuid primary key,
    full_name text not null,
    role public.app_role not null default 'cleaner',
    access_role text not null default 'pending',
    active boolean not null default true,
    is_owner boolean not null default false,
    email text,
    first_signed_in_at timestamptz not null default now()
  );
  create table public.user_module_roles (
    user_id uuid not null references public.profiles(id),
    module text not null,
    role text not null,
    created_by uuid references public.profiles(id),
    created_at timestamptz not null default now(),
    primary key (user_id, module, role)
  );
  create table public.cafeteria_families (
    id uuid primary key,
    display_name text not null,
    active boolean not null default true
  );
  create table public.cafeteria_family_users (
    id uuid primary key default gen_random_uuid(),
    family_id uuid not null references public.cafeteria_families(id),
    user_id uuid not null references public.profiles(id),
    active boolean not null default true,
    valid_from date not null default current_date,
    valid_to date,
    created_by uuid references public.profiles(id),
    unique (family_id, user_id, valid_from)
  );

  create function public.is_owner()
  returns boolean
  language sql
  security definer
  set search_path = ''
  stable
  as $$
    select exists (
      select 1 from public.profiles
      where id = auth.uid() and active and is_owner and access_role = 'admin'
    )
  $$;

  insert into public.profiles (id, full_name, access_role, role, is_owner, email) values
    ('${ids.owner}', 'Hlavní správce', 'admin', 'caretaker', true, 'owner@example.test'),
    ('${ids.ordinary}', 'Běžný uživatel', 'visitor', 'cleaner', false, 'user@example.test'),
    ('${ids.pending}', 'Čekající rodič', 'pending', 'cleaner', false, 'parent@example.test'),
    ('${ids.invalid}', 'Čekající druhý', 'pending', 'cleaner', false, 'second@example.test');
  insert into public.cafeteria_families values ('${ids.family}', 'Testovací rodina', true);
`)

const migration = await readFile(
  new URL('../supabase/migrations/20260907052755_school_access_approval_workflow.sql', import.meta.url),
  'utf8',
)
await db.exec(migration)

async function asRole(role, userId, callback) {
  await db.exec(`set role ${role}`)
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
  try {
    return await callback()
  } finally {
    await db.exec('reset role')
  }
}

await assert.rejects(
  asRole('authenticated', ids.ordinary, () => db.query('select * from public.school_pending_access_users()')),
  /pouze hlavní správce/i,
)

await assert.rejects(
  asRole('authenticated', ids.owner, () => db.query(
    'select public.school_approve_user_access($1, $2::jsonb)',
    [ids.owner, JSON.stringify([{ module: 'cafeteria', role: 'admin' }])],
  )),
  /sami sebe/i,
)

const pendingBefore = await asRole('authenticated', ids.owner, () =>
  db.query('select user_id, full_name, email from public.school_pending_access_users() order by user_id'))
assert.equal(pendingBefore.rows.length, 2)
assert.deepEqual(pendingBefore.rows[0], {
  user_id: ids.pending,
  full_name: 'Čekající rodič',
  email: 'parent@example.test',
})

await assert.rejects(
  asRole('authenticated', ids.owner, () => db.query(
    'select public.owner_set_user_access($1, $2, $3)',
    [ids.pending, 'visitor', true],
  )),
  /auditovaný schvalovací formulář/i,
)

await asRole('authenticated', ids.owner, () => db.query(
  'select public.school_approve_user_access($1, $2::jsonb)',
  [ids.pending, JSON.stringify([
    { module: 'cafeteria', role: 'parent', family_id: ids.family },
    { module: 'cafeteria', role: 'diner' },
    { module: 'cleaning', role: 'cleaning_team' },
  ])],
))

const roles = await db.query(
  'select module, role, created_by from public.user_module_roles where user_id = $1 order by role',
  [ids.pending],
)
assert.deepEqual(roles.rows, [
  { module: 'cafeteria', role: 'diner', created_by: ids.owner },
  { module: 'cafeteria', role: 'parent', created_by: ids.owner },
])
assert.equal((await db.query('select access_role from public.profiles where id = $1', [ids.pending])).rows[0].access_role, 'cleaning_team')
assert.equal((await db.query('select count(*)::integer count from public.cafeteria_family_users where family_id = $1 and user_id = $2 and active', [ids.family, ids.pending])).rows[0].count, 1)
const audit = (await db.query('select target_user_id, approved_by, assignments from public.user_access_approval_events where target_user_id = $1', [ids.pending])).rows[0]
assert.equal(audit.target_user_id, ids.pending)
assert.equal(audit.approved_by, ids.owner)
assert.equal(audit.assignments.length, 3)

const pendingAfter = await asRole('authenticated', ids.owner, () =>
  db.query('select user_id from public.school_pending_access_users()'))
assert.deepEqual(pendingAfter.rows, [{ user_id: ids.invalid }])

await assert.rejects(
  asRole('authenticated', ids.owner, () => db.query(
    'select public.school_approve_user_access($1, $2::jsonb)',
    [ids.invalid, JSON.stringify([
      { module: 'cafeteria', role: 'parent', family_id: ids.family },
      { module: 'cleaning', role: 'owner' },
    ])],
  )),
  /neplatná role Úklidu/i,
)
assert.equal((await db.query('select count(*)::integer count from public.user_module_roles where user_id = $1', [ids.invalid])).rows[0].count, 0)
assert.equal((await db.query('select count(*)::integer count from public.cafeteria_family_users where user_id = $1', [ids.invalid])).rows[0].count, 0)
assert.equal((await db.query('select count(*)::integer count from public.user_access_approval_events where target_user_id = $1', [ids.invalid])).rows[0].count, 0)

await assert.rejects(
  asRole('authenticated', ids.owner, () => db.query(
    'select public.school_approve_user_access($1, $2::jsonb)',
    [ids.invalid, JSON.stringify([{ module: 'unknown', role: 'admin' }])],
  )),
  /neplatný modul/i,
)

await assert.rejects(
  asRole('anon', ids.ordinary, () => db.query('select * from public.school_pending_access_users()')),
  /permission denied/i,
)
await assert.rejects(
  asRole('anon', ids.ordinary, () => db.query('select * from public.user_access_approval_events')),
  /permission denied/i,
)
await assert.rejects(
  asRole('authenticated', ids.owner, () => db.query(
    "insert into public.user_module_roles (user_id, module, role, created_by) values ($1, 'cafeteria', 'admin', $2)",
    [ids.invalid, ids.owner],
  )),
  /permission denied/i,
)

await assert.rejects(
  db.query('update public.profiles set is_owner = false where id = $1', [ids.owner]),
  /posledního hlavního správce/i,
)

console.log('school access approval SQL integration: OK')
await db.close()
