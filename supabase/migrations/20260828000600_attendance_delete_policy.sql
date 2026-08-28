-- Povolit fyzické smazání pouze vlastní směny nebo caretakerovi.
-- Ostatní tabulky ani data tato migrace nemění.
drop policy if exists "delete own attendance" on public.attendance;

create policy "delete own attendance"
on public.attendance
for delete
to authenticated
using (worker_id = auth.uid() or public.is_caretaker());

