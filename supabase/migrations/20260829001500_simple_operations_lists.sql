-- Provoz jako sdílený nákupní seznam a evidence závad.
-- Historické množství zásob zůstává zachované, ale nové UI je nepoužívá.

begin;

alter table public.stock_items
  add column if not exists note text,
  add column if not exists status text not null default 'needed',
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.profiles(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'stock_items_status_check'
      and conrelid = 'public.stock_items'::regclass
  ) then
    alter table public.stock_items
      add constraint stock_items_status_check
      check (status in ('needed', 'resolved'));
  end if;
end $$;

alter table public.incidents
  add column if not exists title text,
  add column if not exists note text,
  add column if not exists active boolean not null default true,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.profiles(id);

update public.incidents
set title = description
where title is null;

alter table public.incidents alter column title set not null;

drop policy if exists "approved users read stock" on public.stock_items;
drop policy if exists "admins manage stock" on public.stock_items;
drop policy if exists "approved users read operations purchases" on public.stock_items;
drop policy if exists "team creates operations purchases" on public.stock_items;
drop policy if exists "authors update operations purchases" on public.stock_items;
drop policy if exists "admins update operations purchases" on public.stock_items;

create policy "approved users read operations purchases"
on public.stock_items for select to authenticated
using (public.can_view_school_data());

create policy "team creates operations purchases"
on public.stock_items for insert to authenticated
with check (public.can_work_in_app() and created_by = auth.uid());

create policy "authors update operations purchases"
on public.stock_items for update to authenticated
using (public.can_work_in_app() and created_by = auth.uid())
with check (public.can_work_in_app() and created_by = auth.uid());

create policy "admins update operations purchases"
on public.stock_items for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "approved users read incidents" on public.incidents;
drop policy if exists "team reports incidents" on public.incidents;
drop policy if exists "admins manage incidents" on public.incidents;
drop policy if exists "approved users read operations incidents" on public.incidents;
drop policy if exists "team creates operations incidents" on public.incidents;
drop policy if exists "authors update operations incidents" on public.incidents;
drop policy if exists "admins update operations incidents" on public.incidents;

create policy "approved users read operations incidents"
on public.incidents for select to authenticated
using (public.can_view_school_data());

create policy "team creates operations incidents"
on public.incidents for insert to authenticated
with check (public.can_work_in_app() and worker_id = auth.uid());

create policy "authors update operations incidents"
on public.incidents for update to authenticated
using (public.can_work_in_app() and worker_id = auth.uid())
with check (public.can_work_in_app() and worker_id = auth.uid());

create policy "admins update operations incidents"
on public.incidents for update to authenticated
using (public.is_admin())
with check (public.is_admin());

-- DELETE zůstává bez policy: historie se pouze řeší nebo skrývá.
revoke delete on public.stock_items, public.incidents from authenticated;

-- Realtime je idempotentně zapnutý pro okamžité sdílení změn.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_items'
  ) then
    alter publication supabase_realtime add table public.stock_items;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'incidents'
  ) then
    alter publication supabase_realtime add table public.incidents;
  end if;
end $$;

commit;
