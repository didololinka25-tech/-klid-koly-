-- Historické hodinové sazby a konfigurovatelná měsíční hranice DPČ.

begin;

alter table public.worker_contracts
  add column if not exists hourly_rate numeric(10,2);

alter table public.app_settings
  add column if not exists dpc_monthly_insurance_threshold numeric(10,2) not null default 4500;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.worker_contracts'::regclass
      and conname = 'worker_contracts_hourly_rate_valid'
  ) then
    alter table public.worker_contracts
      add constraint worker_contracts_hourly_rate_valid
      check (hourly_rate is null or (hourly_rate > 0 and hourly_rate <= 100000));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_settings'::regclass
      and conname = 'app_settings_dpc_monthly_threshold_valid'
  ) then
    alter table public.app_settings
      add constraint app_settings_dpc_monthly_threshold_valid
      check (dpc_monthly_insurance_threshold > 0 and dpc_monthly_insurance_threshold <= 1000000);
  end if;
end
$$;

comment on column public.worker_contracts.hourly_rate is
  'Historická hrubá hodinová sazba v Kč platná pouze v období daného pracovního vztahu.';
comment on column public.app_settings.dpc_monthly_insurance_threshold is
  'Konfigurovatelný rozhodný měsíční příjem DPČ používaný pouze pro evidenční odhad.';

-- Nová signatura záměrně vyžaduje sazbu. Starší sedmiparametrová varianta
-- zůstává kvůli kompatibilitě schématu, ale klient ji již nesmí volat.
create or replace function public.admin_save_worker_contract(
  target_contract_id uuid,
  target_worker_id uuid,
  target_contract_type text,
  target_valid_from date,
  target_valid_to date,
  target_hourly_rate numeric,
  target_note text,
  target_active boolean
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_id uuid;
  overlap_exists boolean;
begin
  if not public.is_admin() then
    raise exception 'Pracovní vztahy může měnit pouze správce.';
  end if;
  if target_contract_type not in ('dpp', 'dpc', 'other') then
    raise exception 'Neplatný typ pracovního vztahu.';
  end if;
  if target_valid_from is null
     or (target_valid_to is not null and target_valid_to < target_valid_from) then
    raise exception 'Neplatné období pracovního vztahu.';
  end if;
  if target_active and (target_hourly_rate is null or target_hourly_rate <= 0 or target_hourly_rate > 100000) then
    raise exception 'U aktivního pracovního vztahu zadejte platnou hodinovou sazbu.';
  end if;
  if not exists (
    select 1 from public.profiles where id = target_worker_id and active
  ) then
    raise exception 'Aktivní pracovník nebyl nalezen.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_worker_id::text, 3000));

  select exists (
    select 1
    from public.worker_contracts contract
    where contract.worker_id = target_worker_id
      and contract.active
      and contract.id is distinct from target_contract_id
      and daterange(contract.valid_from, coalesce(contract.valid_to, 'infinity'::date), '[]')
        && daterange(target_valid_from, coalesce(target_valid_to, 'infinity'::date), '[]')
  ) into overlap_exists;

  if overlap_exists and target_active then
    raise exception 'Pracovní vztah se překrývá s jiným aktivním obdobím pracovníka.';
  end if;

  if target_contract_id is null then
    insert into public.worker_contracts(
      worker_id, contract_type, valid_from, valid_to, hourly_rate,
      note, active, created_by, updated_by
    ) values (
      target_worker_id, target_contract_type, target_valid_from, target_valid_to,
      target_hourly_rate, nullif(trim(target_note), ''), target_active,
      auth.uid(), auth.uid()
    ) returning id into saved_id;
  else
    update public.worker_contracts
    set contract_type = target_contract_type,
        valid_from = target_valid_from,
        valid_to = target_valid_to,
        hourly_rate = target_hourly_rate,
        note = nullif(trim(target_note), ''),
        active = target_active,
        updated_by = auth.uid(),
        updated_at = now()
    where id = target_contract_id and worker_id = target_worker_id
    returning id into saved_id;

    if saved_id is null then
      raise exception 'Pracovní vztah nebyl nalezen.';
    end if;
  end if;

  return saved_id;
end;
$$;

revoke all on function public.admin_save_worker_contract(uuid,uuid,text,date,date,text,boolean)
  from public, anon, authenticated;
revoke all on function public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)
  from public, anon, authenticated;
grant execute on function public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)
  to authenticated;

create or replace function public.set_dpc_settings(
  weekly_hours numeric,
  period_weeks smallint,
  monthly_threshold numeric
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Nastavení DPČ může měnit pouze správce.';
  end if;
  if weekly_hours is null or weekly_hours <= 0 or weekly_hours > 80
     or period_weeks is null or period_weeks not between 1 and 52 then
    raise exception 'Neplatný referenční rozsah DPČ.';
  end if;
  if monthly_threshold is null or monthly_threshold <= 0 or monthly_threshold > 1000000 then
    raise exception 'Rozhodný měsíční příjem musí být větší než 0.';
  end if;

  update public.app_settings
  set dpc_weekly_hours_reference = weekly_hours,
      dpc_reference_period_weeks = period_weeks,
      dpc_monthly_insurance_threshold = monthly_threshold,
      updated_at = now(),
      updated_by = auth.uid()
  where id;

  if not found then
    raise exception 'Nastavení aplikace nebylo nalezeno.';
  end if;
end;
$$;

revoke all on function public.set_dpc_settings(numeric,smallint)
  from public, anon, authenticated;
revoke all on function public.set_dpc_settings(numeric,smallint,numeric)
  from public, anon, authenticated;
grant execute on function public.set_dpc_settings(numeric,smallint,numeric)
  to authenticated;

-- Citlivé údaje zůstávají čitelné pouze podle existujících RLS:
-- pracovník vlastní vztahy, admin všechny, visitor a pending žádné.
alter table public.worker_contracts enable row level security;
alter table public.worker_contract_audit enable row level security;
revoke insert, update, delete on public.worker_contracts, public.worker_contract_audit
  from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'worker_contracts'
      and column_name = 'hourly_rate' and data_type = 'numeric'
  ) then
    raise exception 'worker_contracts.hourly_rate nebyla vytvořena.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_settings'
      and column_name = 'dpc_monthly_insurance_threshold'
      and data_type = 'numeric' and is_nullable = 'NO'
  ) then
    raise exception 'Chybí dpc_monthly_insurance_threshold.';
  end if;
  if exists (
    select 1 from public.app_settings
    where dpc_monthly_insurance_threshold <= 0
  ) then
    raise exception 'Rozhodný příjem DPČ není platný.';
  end if;
  if to_regprocedure('public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)') is null
     or not has_function_privilege(
       'authenticated',
       'public.admin_save_worker_contract(uuid,uuid,text,date,date,numeric,text,boolean)',
       'EXECUTE'
     ) then
    raise exception 'Nové RPC pracovních vztahů není dostupné.';
  end if;
  if has_function_privilege(
       'authenticated',
       'public.admin_save_worker_contract(uuid,uuid,text,date,date,text,boolean)',
       'EXECUTE'
     ) then
    raise exception 'Staré RPC bez hodinové sazby nesmí zůstat dostupné klientu.';
  end if;
  if not has_function_privilege(
       'authenticated',
       'public.set_dpc_settings(numeric,smallint,numeric)',
       'EXECUTE'
     ) then
    raise exception 'RPC nastavení DPČ není dostupné.';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('worker_contracts', 'worker_contract_audit')
      and grantee = 'authenticated'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'Authenticated nesmí přímo měnit historii pracovních vztahů.';
  end if;
end
$$;

commit;
