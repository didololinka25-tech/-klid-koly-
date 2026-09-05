-- Spouštět pouze proti lokální/testovací databázi po cafeteria foundation migraci.
-- Test je read-only: ověřuje RLS, ACL a klíčové oddělení financí od kuchyně.
begin;

do $$
declare
  cafeteria_tables constant text[] := array[
    'user_module_roles', 'cafeteria_families', 'cafeteria_family_users',
    'cafeteria_accounts', 'cafeteria_portion_categories', 'cafeteria_diners',
    'cafeteria_price_rules', 'cafeteria_settings', 'cafeteria_meal_days',
    'cafeteria_meal_variants'
  ];
  table_name text;
  table_oid regclass;
  account_policy text;
begin
  foreach table_name in array cafeteria_tables loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null then
      raise exception 'Chybí cafeteria tabulka public.%.', table_name;
    end if;
    if not (select relrowsecurity from pg_class where oid = table_oid) then
      raise exception 'RLS není zapnuté na %.', table_oid;
    end if;
    if has_table_privilege('anon', table_oid, 'SELECT')
       or has_table_privilege('anon', table_oid, 'INSERT')
       or has_table_privilege('anon', table_oid, 'UPDATE')
       or has_table_privilege('anon', table_oid, 'DELETE') then
      raise exception 'anon má neočekávané oprávnění k %.', table_oid;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_module_roles'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, module, role)'
  ) then
    raise exception 'user_module_roles nemá složený primární klíč.';
  end if;

  select coalesce(qual, '') into account_policy
  from pg_policies
  where schemaname = 'public'
    and tablename = 'cafeteria_accounts'
    and policyname = 'cafeteria accounts visible to family diner and admins';

  if account_policy is null then
    raise exception 'Chybí SELECT policy účtů.';
  end if;
  if account_policy ilike '%kitchen%' then
    raise exception 'Kuchyně nesmí získat přístup k rodinným účtům.';
  end if;
  if account_policy not ilike '%cafeteria_family_users%'
     or account_policy not ilike '%cafeteria_diners%' then
    raise exception 'Účty nejsou omezené na rodinu nebo vlastní diner profil.';
  end if;
end
$$;

rollback;
