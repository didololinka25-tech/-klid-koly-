-- Historie pracovních vztahů DPP/DPČ bez změny existující docházky.
begin;

alter table public.app_settings
  add column if not exists dpc_weekly_hours_reference numeric(6,2) not null default 20 check (dpc_weekly_hours_reference > 0 and dpc_weekly_hours_reference <= 80),
  add column if not exists dpc_reference_period_weeks smallint not null default 26 check (dpc_reference_period_weeks between 1 and 52);

create table if not exists public.worker_contracts (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id),
  contract_type text not null check (contract_type in ('dpp','dpc','other')),
  valid_from date not null,
  valid_to date,
  note text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create index if not exists worker_contracts_worker_dates_idx
  on public.worker_contracts(worker_id, valid_from, valid_to);

create table if not exists public.worker_contract_audit (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null,
  old_values jsonb,
  new_values jsonb not null,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index if not exists worker_contract_audit_contract_idx
  on public.worker_contract_audit(contract_id, changed_at desc);

create or replace function public.record_worker_contract_audit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.worker_contract_audit(contract_id,old_values,new_values,changed_by)
  values(new.id,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),auth.uid());
  return new;
end $$;
revoke all on function public.record_worker_contract_audit() from public,anon,authenticated;
drop trigger if exists record_worker_contract_audit on public.worker_contracts;
create trigger record_worker_contract_audit after insert or update on public.worker_contracts
for each row execute function public.record_worker_contract_audit();

alter table public.worker_contracts enable row level security;
alter table public.worker_contract_audit enable row level security;
drop policy if exists "workers read own contracts" on public.worker_contracts;
drop policy if exists "admins read all contracts" on public.worker_contracts;
drop policy if exists "admins read contract audit" on public.worker_contract_audit;
create policy "workers read own contracts" on public.worker_contracts for select to authenticated
using (public.can_work_in_app() and worker_id=auth.uid());
create policy "admins read all contracts" on public.worker_contracts for select to authenticated
using (public.is_admin());
create policy "admins read contract audit" on public.worker_contract_audit for select to authenticated
using (public.is_admin());
revoke all on public.worker_contracts,public.worker_contract_audit from anon,authenticated;
grant select on public.worker_contracts,public.worker_contract_audit to authenticated;

create or replace function public.admin_save_worker_contract(
  target_contract_id uuid, target_worker_id uuid, target_contract_type text,
  target_valid_from date, target_valid_to date, target_note text, target_active boolean
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare saved_id uuid; overlap_exists boolean;
begin
  if not public.is_admin() then raise exception 'Pracovní vztahy může měnit pouze správce.'; end if;
  if target_contract_type not in ('dpp','dpc','other') then raise exception 'Neplatný typ pracovního vztahu.'; end if;
  if target_valid_from is null or (target_valid_to is not null and target_valid_to < target_valid_from) then raise exception 'Neplatné období pracovního vztahu.'; end if;
  if not exists(select 1 from public.profiles where id=target_worker_id and active) then raise exception 'Aktivní pracovník nebyl nalezen.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_worker_id::text,2400));
  select exists(select 1 from public.worker_contracts contract
    where contract.worker_id=target_worker_id and contract.active
      and contract.id is distinct from target_contract_id
      and daterange(contract.valid_from,coalesce(contract.valid_to,'infinity'::date),'[]')
        && daterange(target_valid_from,coalesce(target_valid_to,'infinity'::date),'[]')) into overlap_exists;
  if overlap_exists and target_active then raise exception 'Pracovní vztah se překrývá s jiným aktivním obdobím pracovníka.'; end if;
  if target_contract_id is null then
    insert into public.worker_contracts(worker_id,contract_type,valid_from,valid_to,note,active,created_by,updated_by)
    values(target_worker_id,target_contract_type,target_valid_from,target_valid_to,nullif(trim(target_note),''),target_active,auth.uid(),auth.uid()) returning id into saved_id;
  else
    update public.worker_contracts set contract_type=target_contract_type,valid_from=target_valid_from,
      valid_to=target_valid_to,note=nullif(trim(target_note),''),active=target_active,updated_by=auth.uid(),updated_at=now()
    where id=target_contract_id and worker_id=target_worker_id returning id into saved_id;
    if saved_id is null then raise exception 'Pracovní vztah nebyl nalezen.'; end if;
  end if;
  return saved_id;
end $$;
revoke all on function public.admin_save_worker_contract(uuid,uuid,text,date,date,text,boolean) from public,anon,authenticated;
grant execute on function public.admin_save_worker_contract(uuid,uuid,text,date,date,text,boolean) to authenticated;

create or replace function public.set_dpc_settings(weekly_hours numeric,period_weeks smallint)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Nastavení DPČ může měnit pouze správce.'; end if;
  if weekly_hours <= 0 or weekly_hours > 80 or period_weeks not between 1 and 52 then raise exception 'Neplatné nastavení DPČ.'; end if;
  update public.app_settings set dpc_weekly_hours_reference=weekly_hours,
    dpc_reference_period_weeks=period_weeks,updated_at=now(),updated_by=auth.uid() where id;
end $$;
revoke all on function public.set_dpc_settings(numeric,smallint) from public,anon,authenticated;
grant execute on function public.set_dpc_settings(numeric,smallint) to authenticated;

do $$
begin
  if exists(select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('worker_contracts','worker_contract_audit') and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')) then
    raise exception 'Authenticated nesmí přímo měnit historii pracovních vztahů.';
  end if;
end $$;

commit;
