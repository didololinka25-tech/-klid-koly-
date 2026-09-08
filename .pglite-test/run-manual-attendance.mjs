import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const ids = {
  worker: '00000000-0000-0000-0000-000000000001',
  other: '00000000-0000-0000-0000-000000000002',
  admin: '00000000-0000-0000-0000-000000000003',
  school: '10000000-0000-0000-0000-000000000001',
  kindergarten: '10000000-0000-0000-0000-000000000002',
}

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;

  create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.profiles (
    id uuid primary key,
    full_name text not null,
    access_role text not null,
    active boolean not null default true
  );
  create table public.buildings (
    id uuid primary key,
    name text not null,
    active boolean not null default true
  );
  create table public.attendance (
    id uuid primary key default gen_random_uuid(),
    worker_id uuid not null references public.profiles(id),
    building_id uuid not null references public.buildings(id),
    attendance_date date not null,
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    note text,
    created_at timestamptz not null default now(),
    check (ended_at is null or ended_at >= started_at)
  );
  create table public.attendance_audit (
    id uuid primary key default gen_random_uuid(),
    attendance_id uuid not null,
    old_attendance_date date not null,
    old_started_at timestamptz not null,
    old_ended_at timestamptz,
    new_attendance_date date not null,
    new_started_at timestamptz not null,
    new_ended_at timestamptz,
    changed_by uuid references public.profiles(id),
    changed_by_name text not null,
    changed_at timestamptz not null default now(),
    change_kind text not null check (change_kind in ('clock_out', 'correction'))
  );

  create function public.can_work_in_app() returns boolean language sql security definer set search_path = '' stable
  as $$ select exists(select 1 from public.profiles where id = auth.uid() and active and access_role in ('cleaning_team','admin')) $$;
  create function public.is_admin() returns boolean language sql security definer set search_path = '' stable
  as $$ select exists(select 1 from public.profiles where id = auth.uid() and active and access_role = 'admin') $$;

  create function public.enforce_attendance_integrity() returns trigger language plpgsql security invoker set search_path = '' as $$
  begin
    perform pg_advisory_xact_lock(hashtextextended(new.worker_id::text, 2100));
    if new.ended_at is not null and new.ended_at < new.started_at then
      raise exception using errcode = '22007', message = 'Odchod nesmí být před příchodem.';
    end if;
    new.attendance_date := (new.started_at at time zone 'Europe/Prague')::date;
    if exists (
      select 1 from public.attendance existing
      where existing.worker_id = new.worker_id and existing.id <> new.id
        and tstzrange(existing.started_at, coalesce(existing.ended_at, 'infinity'::timestamptz), '[)')
          && tstzrange(new.started_at, coalesce(new.ended_at, 'infinity'::timestamptz), '[)')
    ) then
      raise exception using errcode = '23P01', message = 'Směna se překrývá s jinou evidovanou směnou tohoto pracovníka.';
    end if;
    return new;
  end $$;
  create trigger enforce_attendance_integrity before insert or update of worker_id, started_at, ended_at
    on public.attendance for each row execute procedure public.enforce_attendance_integrity();

  alter table public.attendance enable row level security;
  alter table public.attendance_audit enable row level security;
  create policy "team starts own attendance" on public.attendance for insert to authenticated
    with check (public.can_work_in_app() and worker_id = auth.uid());
  create policy "team reads attendance" on public.attendance for select to authenticated
    using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
  create policy "team updates attendance" on public.attendance for update to authenticated
    using (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()))
    with check (public.can_work_in_app() and (worker_id = auth.uid() or public.is_admin()));
  grant select, insert, update, delete on public.attendance to authenticated;
  grant select on public.attendance_audit to authenticated;

  insert into public.profiles values
    ('${ids.worker}', 'Dana', 'cleaning_team', true),
    ('${ids.other}', 'Martina', 'cleaning_team', true),
    ('${ids.admin}', 'Správce', 'admin', true);
  insert into public.buildings values
    ('${ids.school}', 'Škola', true),
    ('${ids.kindergarten}', 'Školka', true);
`)

const migration = await readFile(new URL('../supabase/migrations/20260908120000_manual_attendance_backfill.sql', import.meta.url), 'utf8')
await db.exec(migration)
await db.exec(migration)

async function asUser(userId, callback) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
  try { return await callback() } finally { await db.exec('reset role') }
}

const created = await asUser(ids.worker, () => db.query(
  "select (public.create_manual_attendance($1,$2,$3,$4,$5,$6)).id id",
  [ids.worker, ids.school, '2026-09-01', '15:00', '17:30', 'Doplněno po směně'],
))
const createdId = created.rows[0].id
const row = (await db.query("select worker_id, building_id, to_char(attendance_date, 'YYYY-MM-DD') attendance_date, entry_source, entry_created_by, note from public.attendance where id=$1", [createdId])).rows[0]
assert.deepEqual(row, {
  worker_id: ids.worker,
  building_id: ids.school,
  attendance_date: '2026-09-01',
  entry_source: 'manual_backfill',
  entry_created_by: ids.worker,
  note: 'Doplněno po směně',
})

const audit = (await db.query('select change_kind, changed_by, old_started_at, new_started_at from public.attendance_audit where attendance_id=$1', [createdId])).rows[0]
assert.equal(audit.change_kind, 'manual_creation')
assert.equal(audit.changed_by, ids.worker)
assert.equal(audit.old_started_at, null)
assert.ok(audit.new_started_at)

await assert.rejects(
  asUser(ids.worker, () => db.query(
    'select public.create_manual_attendance($1,$2,$3,$4,$5,$6)',
    [ids.worker, ids.school, '2026-09-01', '17:00', '18:00', null],
  )),
  /překrývá/i,
)
assert.equal((await db.query('select count(*)::integer count from public.attendance')).rows[0].count, 1)

await assert.rejects(
  asUser(ids.worker, () => db.query(
    'select public.create_manual_attendance($1,$2,$3,$4,$5,$6)',
    [ids.other, ids.school, '2026-09-02', '15:00', '17:00', null],
  )),
  /pouze svoji/i,
)

const adminCreated = await asUser(ids.admin, () => db.query(
  'select (public.create_manual_attendance($1,$2,$3,$4,$5,$6)).id id',
  [ids.other, ids.kindergarten, '2026-09-02', '14:00', '16:00', null],
))
assert.ok(adminCreated.rows[0].id)

await assert.rejects(
  asUser(ids.worker, () => db.query(
    "insert into public.attendance(worker_id,building_id,attendance_date,started_at,ended_at,entry_source,entry_created_by) values($1,$2,'2026-09-03','2026-09-03 15:00+02','2026-09-03 17:00+02','manual_backfill',$1)",
    [ids.worker, ids.school],
  )),
  /row-level security/i,
)
await assert.rejects(
  asUser(ids.worker, () => db.query("update public.attendance set entry_source='clock' where id=$1", [createdId])),
  /původ záznamu/i,
)

console.log('manual attendance SQL integration: OK')
await db.close()
