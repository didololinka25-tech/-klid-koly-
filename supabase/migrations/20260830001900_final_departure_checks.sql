begin;

-- Čtyři společné kontroly uzavírají každý skutečný úklidový den. Jsou to
-- běžné canonical cleaning_tasks, takže sdílejí bezpečné completion RPC,
-- realtime, historii i pravidla mimořádných a přesunutých úklidů.
insert into public.cleaning_tasks (
  plan_key, room_id, name, activity_type, frequency, active, sort_order,
  schedule_days, monthly_day, requires_task_id, work_part_id,
  assignment_mode, rotation_anchor_date, rotation_interval_weeks,
  cleaning_cycle_length, cleaning_cycle_offset,
  period_months, period_week, period_anchor_month
)
values
  ('v2026|school|common|final-windows', null, 'Zkontrolovat okna', 'windows', 'cleaning_day', true, 900, '{1,3,5}'::smallint[], null, null, null, 'fixed', null, 1, null, null, null, null, null),
  ('v2026|school|common|final-doors', null, 'Zkontrolovat dveře', 'doors', 'cleaning_day', true, 910, '{1,3,5}'::smallint[], null, null, null, 'fixed', null, 1, null, null, null, null, null),
  ('v2026|school|common|final-soap', null, 'Doplnit mýdlo podle potřeby', 'sink', 'cleaning_day', true, 920, '{1,3,5}'::smallint[], null, null, null, 'fixed', null, 1, null, null, null, null, null),
  ('v2026|school|common|final-tools', null, 'Uklidit úklidové pomůcky', 'other', 'cleaning_day', true, 930, '{1,3,5}'::smallint[], null, null, null, 'fixed', null, 1, null, null, null, null, null)
on conflict (plan_key) where plan_key is not null do update set
  room_id = null,
  name = excluded.name,
  activity_type = excluded.activity_type,
  frequency = excluded.frequency,
  active = true,
  sort_order = excluded.sort_order,
  schedule_days = excluded.schedule_days,
  monthly_day = null,
  requires_task_id = null,
  work_part_id = null,
  assignment_mode = 'fixed',
  rotation_anchor_date = null,
  rotation_interval_weeks = 1,
  cleaning_cycle_length = null,
  cleaning_cycle_offset = null,
  period_months = null,
  period_week = null,
  period_anchor_month = null;

do $$
begin
  if (
    select count(*)
    from public.cleaning_tasks
    where active and plan_key like 'v2026|school|common|final-%'
  ) <> 4 then
    raise exception 'Nevznikly přesně čtyři aktivní závěrečné kontroly.';
  end if;
  if exists (
    select 1 from public.cleaning_tasks
    where plan_key like 'v2026|school|common|final-%'
      and (room_id is not null or work_part_id is not null or assignment_mode <> 'fixed')
  ) then
    raise exception 'Závěrečné kontroly nesmí mít místnost, A/B ani osobní přiřazení.';
  end if;
end;
$$;

commit;
