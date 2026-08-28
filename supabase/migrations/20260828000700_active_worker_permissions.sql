-- Jednoduché společné oprávnění pro všechny aktivní přihlášené pracovníky.
-- RLS zůstává zapnuté; anonymní a neaktivní účty nezískají přístup.
create or replace function public.is_active_worker()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and active
  );
$$;

revoke all on function public.is_active_worker() from public;
grant execute on function public.is_active_worker() to authenticated;

-- Aktivní pracovníci potřebují vidět kolegy ve výběru docházky a rotací.
drop policy if exists "profiles own or caretaker" on public.profiles;
drop policy if exists "active workers read profiles" on public.profiles;
create policy "active workers read profiles"
on public.profiles for select to authenticated
using (public.is_active_worker());

-- Příchod smí vždy vzniknout jen přihlášenému uživateli.
-- Následnou opravu nebo smazání konkrétní směny může udělat každý aktivní pracovník.
drop policy if exists "read own attendance" on public.attendance;
drop policy if exists "start own attendance" on public.attendance;
drop policy if exists "update own attendance" on public.attendance;
drop policy if exists "delete own attendance" on public.attendance;
drop policy if exists "active workers read attendance" on public.attendance;
drop policy if exists "active worker starts own attendance" on public.attendance;
drop policy if exists "active workers update attendance" on public.attendance;
drop policy if exists "active workers delete attendance" on public.attendance;

create policy "active workers read attendance"
on public.attendance for select to authenticated
using (public.is_active_worker());

create policy "active worker starts own attendance"
on public.attendance for insert to authenticated
with check (public.is_active_worker() and worker_id = auth.uid());

create policy "active workers update attendance"
on public.attendance for update to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

create policy "active workers delete attendance"
on public.attendance for delete to authenticated
using (public.is_active_worker());

-- Místnosti mohou spravovat všichni aktivní pracovníci.
drop policy if exists "manage rooms" on public.rooms;
drop policy if exists "active workers manage rooms" on public.rooms;
create policy "active workers manage rooms"
on public.rooms for all to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

-- Celý plán včetně neaktivních úkolů a rotačních přiřazení je společně spravovatelný.
drop policy if exists "read tasks" on public.cleaning_tasks;
drop policy if exists "manage tasks" on public.cleaning_tasks;
drop policy if exists "active workers read tasks" on public.cleaning_tasks;
drop policy if exists "active workers manage tasks" on public.cleaning_tasks;
create policy "active workers read tasks"
on public.cleaning_tasks for select to authenticated
using (public.is_active_worker());
create policy "active workers manage tasks"
on public.cleaning_tasks for all to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

drop policy if exists "read own assignments" on public.task_assignments;
drop policy if exists "manage assignments" on public.task_assignments;
drop policy if exists "active workers read task assignments" on public.task_assignments;
drop policy if exists "active workers manage task assignments" on public.task_assignments;
create policy "active workers read task assignments"
on public.task_assignments for select to authenticated
using (public.is_active_worker());
create policy "active workers manage task assignments"
on public.task_assignments for all to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

drop policy if exists "manage work parts" on public.cleaning_work_parts;
drop policy if exists "active workers manage work parts" on public.cleaning_work_parts;
create policy "active workers manage work parts"
on public.cleaning_work_parts for all to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

drop policy if exists "manage work part assignments" on public.work_part_assignments;
drop policy if exists "active workers manage work part assignments" on public.work_part_assignments;
create policy "active workers manage work part assignments"
on public.work_part_assignments for all to authenticated
using (public.is_active_worker())
with check (public.is_active_worker());

create or replace function public.swap_cleaning_work_parts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  worker_a uuid;
  worker_b uuid;
  part_a uuid;
  part_b uuid;
begin
  if not public.is_active_worker() then
    raise exception 'Pouze aktivní pracovník může prohodit pracovní části.';
  end if;
  select id into part_a from public.cleaning_work_parts where code = 'A' and active limit 1;
  select id into part_b from public.cleaning_work_parts where code = 'B' and active limit 1;
  select worker_id into worker_a from public.work_part_assignments where work_part_id = part_a and active;
  select worker_id into worker_b from public.work_part_assignments where work_part_id = part_b and active;
  if worker_a is null or worker_b is null then
    raise exception 'Obě pracovní části musí mít aktuálního pracovníka.';
  end if;
  update public.work_part_assignments
  set active = false, ends_on = current_date
  where active and work_part_id in (part_a, part_b);
  insert into public.work_part_assignments (work_part_id, worker_id, starts_on)
  values (part_a, worker_b, current_date), (part_b, worker_a, current_date);
end;
$$;

revoke all on function public.swap_cleaning_work_parts() from public;
grant execute on function public.swap_cleaning_work_parts() to authenticated;
