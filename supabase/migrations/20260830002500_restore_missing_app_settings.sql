-- Obnova chybějícího singletonu provozních nastavení.
-- Migrace je kompatibilní jak s DB bez app_settings, tak s DB, kde tabulka
-- již existuje. Existující DPP limit ani jiné hodnoty nepřepisuje.

begin;

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  dpp_annual_limit_hours numeric(7,2) not null default 300
    check (dpp_annual_limit_hours > 0 and dpp_annual_limit_hours <= 10000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Doplnění jednotlivých sloupců chrání i nestandardní databázi, ve které
-- tabulka existuje jen částečně. DEFAULT 300 se použije pouze při doplnění
-- chybějícího sloupce nebo při vložení chybějícího singleton řádku.
alter table public.app_settings
  add column if not exists id boolean default true,
  add column if not exists dpp_annual_limit_hours numeric(7,2) default 300,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.app_settings
  alter column id set default true,
  alter column id set not null,
  alter column dpp_annual_limit_hours set default 300,
  alter column dpp_annual_limit_hours set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_settings'::regclass and contype = 'p'
  ) then
    alter table public.app_settings
      add constraint app_settings_pkey primary key (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_settings'::regclass
      and conname = 'app_settings_id_must_be_true'
  ) then
    alter table public.app_settings
      add constraint app_settings_id_must_be_true check (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_settings'::regclass
      and conname = 'app_settings_dpp_limit_valid'
  ) then
    alter table public.app_settings
      add constraint app_settings_dpp_limit_valid
      check (dpp_annual_limit_hours > 0 and dpp_annual_limit_hours <= 10000);
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    join pg_attribute attribute_row
      on attribute_row.attrelid = constraint_row.conrelid
     and attribute_row.attnum = any (constraint_row.conkey)
    where constraint_row.conrelid = 'public.app_settings'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.profiles'::regclass
      and attribute_row.attname = 'updated_by'
  ) then
    alter table public.app_settings
      add constraint app_settings_updated_by_fkey
      foreign key (updated_by) references public.profiles(id) on delete set null;
  end if;
end
$$;

insert into public.app_settings (id, dpp_annual_limit_hours)
select true, 300
where not exists (select 1 from public.app_settings where id);

alter table public.app_settings enable row level security;

drop policy if exists "approved users read app settings" on public.app_settings;
create policy "approved users read app settings"
on public.app_settings for select to authenticated
using (public.can_view_school_data());

-- Přímý zápis z klienta není povolen; změna limitu vede pouze přes RPC.
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

create or replace function public.set_dpp_annual_limit(value numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Roční limit DPP může měnit pouze správce.';
  end if;
  if value is null or value <= 0 or value > 10000 then
    raise exception 'Roční limit DPP musí být větší než 0 a nejvýše 10000 hodin.';
  end if;

  update public.app_settings
  set dpp_annual_limit_hours = value,
      updated_at = now(),
      updated_by = auth.uid()
  where id;

  if not found then
    raise exception 'Nastavení aplikace nebylo nalezeno.';
  end if;
end;
$$;

revoke all on function public.set_dpp_annual_limit(numeric) from public, anon, authenticated;
grant execute on function public.set_dpp_annual_limit(numeric) to authenticated;

comment on table public.app_settings is
  'Globální provozní nastavení aplikace; roční DPP limit je společný napříč pracovišti.';

-- Safety checks: schéma, singleton, RLS, práva a RPC musí být kompletní.
do $$
declare
  expected_columns integer;
begin
  if to_regclass('public.app_settings') is null then
    raise exception 'Tabulka public.app_settings nebyla vytvořena.';
  end if;

  select count(*) into expected_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'app_settings'
    and (
      (column_name = 'id' and data_type = 'boolean' and is_nullable = 'NO')
      or (column_name = 'dpp_annual_limit_hours' and data_type = 'numeric' and is_nullable = 'NO')
      or (column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
      or (column_name = 'updated_by' and data_type = 'uuid')
    );
  if expected_columns <> 4 then
    raise exception 'Tabulce app_settings chybí některý povinný sloupec.';
  end if;

  if (select count(*) from public.app_settings where id) <> 1
     or (select count(*) from public.app_settings) <> 1 then
    raise exception 'app_settings musí obsahovat právě jeden singleton řádek.';
  end if;

  if exists (
    select 1 from public.app_settings
    where dpp_annual_limit_hours <= 0 or dpp_annual_limit_hours > 10000
  ) then
    raise exception 'Roční limit DPP v app_settings není platný.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass) then
    raise exception 'RLS na app_settings není zapnuté.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_settings'
      and policyname = 'approved users read app settings'
      and cmd = 'SELECT'
  ) then
    raise exception 'Chybí SELECT policy pro app_settings.';
  end if;

  if not has_table_privilege('authenticated', 'public.app_settings', 'SELECT')
     or has_table_privilege('authenticated', 'public.app_settings', 'INSERT')
     or has_table_privilege('authenticated', 'public.app_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.app_settings', 'DELETE') then
    raise exception 'Tabulková oprávnění app_settings nejsou bezpečná.';
  end if;

  if to_regprocedure('public.set_dpp_annual_limit(numeric)') is null
     or not has_function_privilege('authenticated', 'public.set_dpp_annual_limit(numeric)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_dpp_annual_limit(numeric)', 'EXECUTE') then
    raise exception 'Oprávnění RPC set_dpp_annual_limit nejsou bezpečná.';
  end if;
end
$$;

commit;
