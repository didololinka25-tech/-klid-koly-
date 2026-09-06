begin;

create extension if not exists btree_gist with schema extensions;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cafeteria_accounts_id_family_unique'
      and conrelid = 'public.cafeteria_accounts'::regclass
  ) then
    alter table public.cafeteria_accounts
      add constraint cafeteria_accounts_id_family_unique
      unique (id, family_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cafeteria_diners_account_family_fkey'
      and conrelid = 'public.cafeteria_diners'::regclass
  ) then
    alter table public.cafeteria_diners
      add constraint cafeteria_diners_account_family_fkey
      foreign key (account_id, family_id)
      references public.cafeteria_accounts(id, family_id)
      on delete restrict;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cafeteria_price_rules_no_active_overlap'
      and conrelid = 'public.cafeteria_price_rules'::regclass
  ) then
    alter table public.cafeteria_price_rules
      add constraint cafeteria_price_rules_no_active_overlap
      exclude using gist (
        portion_category_id with =,
        daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
      )
      where (active);
  end if;
end
$$;

commit;
