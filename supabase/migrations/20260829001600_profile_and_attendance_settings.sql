-- Vlastní zobrazované jméno a jediný globální roční limit DPP.
-- Docházka již od první migrace obsahuje building_id, proto její historii ani
-- strukturu kvůli více pracovištím neměníme.

begin;

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  dpp_annual_limit_hours numeric(7,2) not null default 300
    check (dpp_annual_limit_hours > 0 and dpp_annual_limit_hours <= 10000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.app_settings (id, dpp_annual_limit_hours)
values (true, 300)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists "approved users read app settings" on public.app_settings;
create policy "approved users read app settings"
on public.app_settings for select to authenticated
using (public.can_view_school_data());

-- Zápis je pouze přes ověřené RPC níže.
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

create or replace function public.update_own_profile_name(new_full_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned_name text := btrim(coalesce(new_full_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Nejste přihlášeni.';
  end if;
  if char_length(cleaned_name) < 2 or char_length(cleaned_name) > 100 then
    raise exception 'Zobrazované jméno musí mít 2 až 100 znaků.';
  end if;
  update public.profiles
  set full_name = cleaned_name,
      updated_at = now()
  where id = auth.uid() and active;
  if not found then raise exception 'Aktivní profil nebyl nalezen.'; end if;
  return cleaned_name;
end;
$$;

revoke all on function public.update_own_profile_name(text) from public, anon;
grant execute on function public.update_own_profile_name(text) to authenticated;

create or replace function public.set_dpp_annual_limit(value numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Roční limit DPP může měnit pouze správce.';
  end if;
  if value is null or value <= 0 or value > 10000 then
    raise exception 'Roční limit DPP musí být větší než 0.';
  end if;
  update public.app_settings
  set dpp_annual_limit_hours = value,
      updated_at = now(),
      updated_by = auth.uid()
  where id;
end;
$$;

revoke all on function public.set_dpp_annual_limit(numeric) from public, anon;
grant execute on function public.set_dpp_annual_limit(numeric) to authenticated;

-- Google metadata zůstávají zdrojem jména při prvním přihlášení, ale pozdější
-- aktualizace auth.users už nepřepíše jméno, které si uživatel změnil v aplikaci.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, full_name, role, access_role, active, email,
    first_signed_in_at, last_signed_in_at
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'cleaner',
    'pending',
    true,
    new.email,
    coalesce(new.created_at, now()),
    new.last_sign_in_at
  )
  on conflict (id) do update
  set full_name = coalesce(nullif(profiles.full_name, ''), excluded.full_name),
      email = excluded.email,
      last_signed_in_at = excluded.last_signed_in_at;
  return new;
end;
$$;

comment on table public.app_settings is
  'Globální provozní nastavení aplikace; roční DPP limit je společný napříč pracovišti.';
comment on function public.update_own_profile_name(text) is
  'Mění pouze zobrazované jméno profilu auth.uid(); nemění roli ani oprávnění.';

commit;
