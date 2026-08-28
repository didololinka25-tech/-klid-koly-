-- Role-based oprávnění pro aktivní přihlášené pracovníky.
-- RLS zůstává zapnuté. Identita je vždy auth.uid(); jméno se pro oprávnění nepoužívá.
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

-- Profily: cleaner vidí sebe, caretaker všechny profily.
drop policy if exists "profiles own or caretaker" on public.profiles;
drop policy if exists "active workers read profiles" on public.profiles;
create policy "profiles own or caretaker"
on public.profiles for select to authenticated
using (
  public.is_active_worker()
  and (id = auth.uid() or public.is_caretaker())
);

-- Docházka:
-- cleaner SELECT/UPDATE/DELETE pouze worker_id = auth.uid();
-- caretaker SELECT/UPDATE/DELETE všechny řádky;
-- INSERT je pro obě role vždy pouze worker_id = auth.uid().
drop policy if exists "read own attendance" on public.attendance;
drop policy if exists "start own attendance" on public.attendance;
drop policy if exists "update own attendance" on public.attendance;
drop policy if exists "delete own attendance" on public.attendance;
drop policy if exists "active workers read attendance" on public.attendance;
drop policy if exists "active worker starts own attendance" on public.attendance;
drop policy if exists "active workers update attendance" on public.attendance;
drop policy if exists "active workers delete attendance" on public.attendance;

create policy "read own attendance"
on public.attendance for select to authenticated
using (
  public.is_active_worker()
  and (worker_id = auth.uid() or public.is_caretaker())
);

create policy "start own attendance"
on public.attendance for insert to authenticated
with check (
  public.is_active_worker()
  and worker_id = auth.uid()
);

create policy "update own attendance"
on public.attendance for update to authenticated
using (
  public.is_active_worker()
  and (worker_id = auth.uid() or public.is_caretaker())
)
with check (
  public.is_active_worker()
  and (worker_id = auth.uid() or public.is_caretaker())
);

create policy "delete own attendance"
on public.attendance for delete to authenticated
using (
  public.is_active_worker()
  and (worker_id = auth.uid() or public.is_caretaker())
);

-- Společná struktura je čitelná aktivním pracovníkům, měnit ji smí jen caretaker.
drop policy if exists "read buildings" on public.buildings;
create policy "read buildings"
on public.buildings for select to authenticated
using (public.is_active_worker());

drop policy if exists "read floors" on public.floors;
create policy "read floors"
on public.floors for select to authenticated
using (public.is_active_worker());

drop policy if exists "read rooms" on public.rooms;
drop policy if exists "manage rooms" on public.rooms;
drop policy if exists "active workers manage rooms" on public.rooms;
create policy "read rooms"
on public.rooms for select to authenticated
using (public.is_active_worker());
create policy "manage rooms"
on public.rooms for all to authenticated
using (public.is_caretaker())
with check (public.is_caretaker());

-- Cleaner čte aktivní plán; caretaker vidí i neaktivní záznamy a jediný je spravuje.
drop policy if exists "read tasks" on public.cleaning_tasks;
drop policy if exists "manage tasks" on public.cleaning_tasks;
drop policy if exists "active workers read tasks" on public.cleaning_tasks;
drop policy if exists "active workers manage tasks" on public.cleaning_tasks;
create policy "read tasks"
on public.cleaning_tasks for select to authenticated
using (public.is_active_worker() and (active or public.is_caretaker()));
create policy "manage tasks"
on public.cleaning_tasks for all to authenticated
using (public.is_caretaker())
with check (public.is_caretaker());

-- Cleaner čte pouze svoje konkrétní task assignments; caretaker je spravuje všechny.
drop policy if exists "read own assignments" on public.task_assignments;
drop policy if exists "manage assignments" on public.task_assignments;
drop policy if exists "active workers read task assignments" on public.task_assignments;
drop policy if exists "active workers manage task assignments" on public.task_assignments;
create policy "read own assignments"
on public.task_assignments for select to authenticated
using (
  public.is_active_worker()
  and (worker_id = auth.uid() or public.is_caretaker())
);
create policy "manage assignments"
on public.task_assignments for all to authenticated
using (public.is_caretaker())
with check (public.is_caretaker());

-- Pracovní části a jejich aktuální držitelé jsou potřebná sdílená data.
drop policy if exists "read work parts" on public.cleaning_work_parts;
drop policy if exists "manage work parts" on public.cleaning_work_parts;
drop policy if exists "active workers manage work parts" on public.cleaning_work_parts;
create policy "read work parts"
on public.cleaning_work_parts for select to authenticated
using (public.is_active_worker());
create policy "manage work parts"
on public.cleaning_work_parts for all to authenticated
using (public.is_caretaker())
with check (public.is_caretaker());

drop policy if exists "read work part assignments" on public.work_part_assignments;
drop policy if exists "manage work part assignments" on public.work_part_assignments;
drop policy if exists "active workers manage work part assignments" on public.work_part_assignments;
create policy "read work part assignments"
on public.work_part_assignments for select to authenticated
using (public.is_active_worker());
create policy "manage work part assignments"
on public.work_part_assignments for all to authenticated
using (public.is_caretaker())
with check (public.is_caretaker());

-- Střídání A/B je správcovská operace a nepoužívá zobrazované jméno.
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
  if not public.is_caretaker() then
    raise exception 'Pouze správce může prohodit pracovní části.';
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
