begin;

create table if not exists public.user_module_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  module text not null check (module in ('cafeteria', 'cleaning')),
  role text not null check (length(btrim(role)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  primary key (user_id, module, role)
);

create table if not exists public.cafeteria_families (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid()
);

create table if not exists public.cafeteria_family_users (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.cafeteria_families(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  active boolean not null default true,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  constraint cafeteria_family_users_valid_range check (valid_to is null or valid_to >= valid_from),
  unique (family_id, user_id, valid_from)
);

create table if not exists public.cafeteria_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.cafeteria_families(id) on delete restrict,
  label text not null check (length(btrim(label)) > 0),
  variable_symbol text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  constraint cafeteria_accounts_variable_symbol_format check (variable_symbol is null or variable_symbol ~ '^[0-9]+$')
);

create unique index if not exists cafeteria_accounts_variable_symbol_unique
  on public.cafeteria_accounts (variable_symbol)
  where variable_symbol is not null;

create table if not exists public.cafeteria_portion_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (length(btrim(name)) > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid()
);

create table if not exists public.cafeteria_diners (
  id uuid primary key default gen_random_uuid(),
  diner_type text not null check (diner_type in ('child', 'adult')),
  full_name text not null check (length(btrim(full_name)) > 0),
  profile_id uuid references public.profiles(id) on delete restrict,
  family_id uuid references public.cafeteria_families(id) on delete restrict,
  account_id uuid not null references public.cafeteria_accounts(id) on delete restrict,
  portion_category_id uuid not null references public.cafeteria_portion_categories(id) on delete restrict,
  active boolean not null default true,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  constraint cafeteria_diners_valid_range check (valid_to is null or valid_to >= valid_from),
  constraint cafeteria_diners_identity_shape check (
    (diner_type = 'child' and profile_id is null and family_id is not null)
    or diner_type = 'adult'
  )
);

create unique index if not exists cafeteria_diners_active_profile_unique
  on public.cafeteria_diners (profile_id)
  where profile_id is not null and active;

create table if not exists public.cafeteria_price_rules (
  id uuid primary key default gen_random_uuid(),
  portion_category_id uuid not null references public.cafeteria_portion_categories(id) on delete restrict,
  valid_from date not null,
  valid_to date,
  price numeric(10,2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  constraint cafeteria_price_rules_valid_range check (valid_to is null or valid_to >= valid_from),
  unique (portion_category_id, valid_from)
);

create table if not exists public.cafeteria_settings (
  id boolean primary key default true check (id),
  cutoff_days_before integer not null default 1 check (cutoff_days_before >= 0),
  cutoff_time time not null default '12:00',
  payment_mode text not null default 'mixed' check (payment_mode in ('credit', 'postpaid', 'mixed')),
  allow_negative_balance boolean not null default true,
  negative_balance_limit numeric(12,2),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.cafeteria_meal_days (
  id uuid primary key default gen_random_uuid(),
  meal_date date not null unique,
  cutoff_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.cafeteria_meal_variants (
  id uuid primary key default gen_random_uuid(),
  meal_day_id uuid not null references public.cafeteria_meal_days(id) on delete restrict,
  name text not null check (length(btrim(name)) > 0),
  note text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  unique (meal_day_id, name)
);

create index if not exists cafeteria_family_users_user_active_idx on public.cafeteria_family_users (user_id, family_id) where active;
create index if not exists cafeteria_family_users_family_active_idx on public.cafeteria_family_users (family_id, user_id) where active;
create index if not exists cafeteria_accounts_family_active_idx on public.cafeteria_accounts (family_id) where active;
create index if not exists cafeteria_diners_family_active_idx on public.cafeteria_diners (family_id) where active;
create index if not exists cafeteria_diners_account_idx on public.cafeteria_diners (account_id);
create index if not exists cafeteria_diners_portion_idx on public.cafeteria_diners (portion_category_id);
create index if not exists cafeteria_price_rules_portion_dates_idx on public.cafeteria_price_rules (portion_category_id, valid_from desc);
create index if not exists cafeteria_meal_variants_day_active_idx on public.cafeteria_meal_variants (meal_day_id, sort_order) where active;
create index if not exists user_module_roles_module_role_idx on public.user_module_roles (module, role, user_id);
create index if not exists user_module_roles_created_by_idx on public.user_module_roles (created_by);
create index if not exists cafeteria_families_created_by_idx on public.cafeteria_families (created_by);
create index if not exists cafeteria_family_users_created_by_idx on public.cafeteria_family_users (created_by);
create index if not exists cafeteria_accounts_created_by_idx on public.cafeteria_accounts (created_by);
create index if not exists cafeteria_portion_categories_created_by_idx on public.cafeteria_portion_categories (created_by);
create index if not exists cafeteria_diners_created_by_idx on public.cafeteria_diners (created_by);
create index if not exists cafeteria_price_rules_created_by_idx on public.cafeteria_price_rules (created_by);
create index if not exists cafeteria_settings_updated_by_idx on public.cafeteria_settings (updated_by);
create index if not exists cafeteria_meal_days_created_by_idx on public.cafeteria_meal_days (created_by);
create index if not exists cafeteria_meal_days_updated_by_idx on public.cafeteria_meal_days (updated_by);
create index if not exists cafeteria_meal_variants_created_by_idx on public.cafeteria_meal_variants (created_by);
create index if not exists cafeteria_meal_variants_updated_by_idx on public.cafeteria_meal_variants (updated_by);

drop trigger if exists cafeteria_settings_set_updated_at on public.cafeteria_settings;
create trigger cafeteria_settings_set_updated_at before update on public.cafeteria_settings
for each row execute function public.set_updated_at();
drop trigger if exists cafeteria_meal_days_set_updated_at on public.cafeteria_meal_days;
create trigger cafeteria_meal_days_set_updated_at before update on public.cafeteria_meal_days
for each row execute function public.set_updated_at();
drop trigger if exists cafeteria_meal_variants_set_updated_at on public.cafeteria_meal_variants;
create trigger cafeteria_meal_variants_set_updated_at before update on public.cafeteria_meal_variants
for each row execute function public.set_updated_at();

insert into public.cafeteria_portion_categories (code, name, sort_order)
values ('small', 'Malá porce', 10), ('large', 'Velká porce', 20)
on conflict (code) do nothing;

insert into public.cafeteria_settings (id, cutoff_days_before, cutoff_time, payment_mode, allow_negative_balance)
values (true, 1, '12:00', 'mixed', true)
on conflict (id) do nothing;

insert into public.user_module_roles (user_id, module, role, created_by)
select profile.id, 'cafeteria', 'admin', profile.id
from public.profiles profile
where profile.active and profile.is_owner
on conflict (user_id, module, role) do nothing;

alter table public.user_module_roles enable row level security;
alter table public.cafeteria_families enable row level security;
alter table public.cafeteria_family_users enable row level security;
alter table public.cafeteria_accounts enable row level security;
alter table public.cafeteria_portion_categories enable row level security;
alter table public.cafeteria_diners enable row level security;
alter table public.cafeteria_price_rules enable row level security;
alter table public.cafeteria_settings enable row level security;
alter table public.cafeteria_meal_days enable row level security;
alter table public.cafeteria_meal_variants enable row level security;

revoke all on public.user_module_roles, public.cafeteria_families, public.cafeteria_family_users,
  public.cafeteria_accounts, public.cafeteria_portion_categories, public.cafeteria_diners,
  public.cafeteria_price_rules, public.cafeteria_settings, public.cafeteria_meal_days,
  public.cafeteria_meal_variants from public, anon, authenticated;

grant select on public.user_module_roles, public.cafeteria_families, public.cafeteria_family_users,
  public.cafeteria_accounts, public.cafeteria_portion_categories, public.cafeteria_diners,
  public.cafeteria_price_rules, public.cafeteria_settings, public.cafeteria_meal_days,
  public.cafeteria_meal_variants to authenticated;
grant insert, delete on public.user_module_roles to authenticated;
grant insert, update on public.cafeteria_families, public.cafeteria_family_users,
  public.cafeteria_accounts, public.cafeteria_portion_categories, public.cafeteria_diners,
  public.cafeteria_price_rules, public.cafeteria_meal_days, public.cafeteria_meal_variants to authenticated;
grant update on public.cafeteria_settings to authenticated;

drop policy if exists "users read own module roles and owner reads all" on public.user_module_roles;
drop policy if exists "owner adds module roles" on public.user_module_roles;
drop policy if exists "owner removes module roles" on public.user_module_roles;
drop policy if exists "cafeteria families visible to members and admins" on public.cafeteria_families;
drop policy if exists "cafeteria admins add families" on public.cafeteria_families;
drop policy if exists "cafeteria admins update families" on public.cafeteria_families;
drop policy if exists "family users visible to self and admins" on public.cafeteria_family_users;
drop policy if exists "cafeteria admins add family users" on public.cafeteria_family_users;
drop policy if exists "cafeteria admins update family users" on public.cafeteria_family_users;
drop policy if exists "cafeteria accounts visible to family diner and admins" on public.cafeteria_accounts;
drop policy if exists "cafeteria admins add accounts" on public.cafeteria_accounts;
drop policy if exists "cafeteria admins update accounts" on public.cafeteria_accounts;
drop policy if exists "cafeteria users read portion categories" on public.cafeteria_portion_categories;
drop policy if exists "cafeteria admins add portion categories" on public.cafeteria_portion_categories;
drop policy if exists "cafeteria admins update portion categories" on public.cafeteria_portion_categories;
drop policy if exists "cafeteria diners visible to family self and admins" on public.cafeteria_diners;
drop policy if exists "cafeteria admins add diners" on public.cafeteria_diners;
drop policy if exists "cafeteria admins update diners" on public.cafeteria_diners;
drop policy if exists "cafeteria admins read price rules" on public.cafeteria_price_rules;
drop policy if exists "cafeteria admins add price rules" on public.cafeteria_price_rules;
drop policy if exists "cafeteria admins update price rules" on public.cafeteria_price_rules;
drop policy if exists "cafeteria admins read settings" on public.cafeteria_settings;
drop policy if exists "cafeteria admins update settings" on public.cafeteria_settings;
drop policy if exists "cafeteria users read published meal days" on public.cafeteria_meal_days;
drop policy if exists "cafeteria admins add meal days" on public.cafeteria_meal_days;
drop policy if exists "cafeteria admins update meal days" on public.cafeteria_meal_days;
drop policy if exists "cafeteria users read published meal variants" on public.cafeteria_meal_variants;
drop policy if exists "cafeteria admins add meal variants" on public.cafeteria_meal_variants;
drop policy if exists "cafeteria admins update meal variants" on public.cafeteria_meal_variants;

create policy "users read own module roles and owner reads all" on public.user_module_roles
for select to authenticated using (user_id = (select auth.uid()) or (select public.is_owner()));
create policy "owner adds module roles" on public.user_module_roles
for insert to authenticated with check ((select public.is_owner()));
create policy "owner removes module roles" on public.user_module_roles
for delete to authenticated using ((select public.is_owner()));

create policy "cafeteria families visible to members and admins" on public.cafeteria_families
for select to authenticated using (
  (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
  or exists (select 1 from public.cafeteria_family_users link where link.family_id = cafeteria_families.id and link.user_id = (select auth.uid()) and link.active and link.valid_from <= current_date and (link.valid_to is null or link.valid_to >= current_date))
);
create policy "cafeteria admins add families" on public.cafeteria_families for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update families" on public.cafeteria_families for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "family users visible to self and admins" on public.cafeteria_family_users
for select to authenticated using (
  user_id = (select auth.uid()) or (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins add family users" on public.cafeteria_family_users for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update family users" on public.cafeteria_family_users for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria accounts visible to family diner and admins" on public.cafeteria_accounts
for select to authenticated using (
  (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
  or exists (select 1 from public.cafeteria_family_users link where link.family_id = cafeteria_accounts.family_id and link.user_id = (select auth.uid()) and link.active and link.valid_from <= current_date and (link.valid_to is null or link.valid_to >= current_date))
  or exists (select 1 from public.cafeteria_diners diner where diner.account_id = cafeteria_accounts.id and diner.profile_id = (select auth.uid()) and diner.active and diner.valid_from <= current_date and (diner.valid_to is null or diner.valid_to >= current_date))
);
create policy "cafeteria admins add accounts" on public.cafeteria_accounts for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update accounts" on public.cafeteria_accounts for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria users read portion categories" on public.cafeteria_portion_categories
for select to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria')
);
create policy "cafeteria admins add portion categories" on public.cafeteria_portion_categories for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update portion categories" on public.cafeteria_portion_categories for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria diners visible to family self and admins" on public.cafeteria_diners
for select to authenticated using (
  profile_id = (select auth.uid()) or (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
  or exists (select 1 from public.cafeteria_family_users link where link.family_id = cafeteria_diners.family_id and link.user_id = (select auth.uid()) and link.active and link.valid_from <= current_date and (link.valid_to is null or link.valid_to >= current_date))
);
create policy "cafeteria admins add diners" on public.cafeteria_diners for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update diners" on public.cafeteria_diners for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria admins read price rules" on public.cafeteria_price_rules for select to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins add price rules" on public.cafeteria_price_rules for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update price rules" on public.cafeteria_price_rules for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria admins read settings" on public.cafeteria_settings for select to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update settings" on public.cafeteria_settings for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  id and ((select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin'))
);

create policy "cafeteria users read published meal days" on public.cafeteria_meal_days
for select to authenticated using (
  (status = 'published' and exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria'))
  or (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins add meal days" on public.cafeteria_meal_days for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update meal days" on public.cafeteria_meal_days for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

create policy "cafeteria users read published meal variants" on public.cafeteria_meal_variants
for select to authenticated using (
  (active and exists (select 1 from public.cafeteria_meal_days day where day.id = meal_day_id and day.status = 'published')
    and exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria'))
  or (select public.is_owner())
  or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins add meal variants" on public.cafeteria_meal_variants for insert to authenticated with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);
create policy "cafeteria admins update meal variants" on public.cafeteria_meal_variants for update to authenticated using (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
) with check (
  (select public.is_owner()) or exists (select 1 from public.user_module_roles role where role.user_id = (select auth.uid()) and role.module = 'cafeteria' and role.role = 'admin')
);

commit;
