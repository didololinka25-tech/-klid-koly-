create schema if not exists private;

create table public.cafeteria_orders (
  id uuid primary key default gen_random_uuid(),
  diner_id uuid not null references public.cafeteria_diners(id) on delete restrict,
  meal_day_id uuid not null references public.cafeteria_meal_days(id) on delete restrict,
  meal_variant_id uuid not null references public.cafeteria_meal_variants(id) on delete restrict,
  account_id uuid not null references public.cafeteria_accounts(id) on delete restrict,
  portion_category_id uuid not null references public.cafeteria_portion_categories(id) on delete restrict,
  unit_price numeric(10,2) not null check (unit_price >= 0),
  quantity smallint not null default 1 check (quantity = 1),
  status text not null default 'ordered' check (status in ('ordered','cancelled')),
  ordered_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references public.profiles(id) on delete set null,
  constraint cafeteria_orders_diner_day_unique unique (diner_id, meal_day_id)
);

create table public.cafeteria_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.cafeteria_orders(id) on delete restrict,
  diner_id uuid not null references public.cafeteria_diners(id) on delete restrict,
  meal_day_id uuid not null references public.cafeteria_meal_days(id) on delete restrict,
  meal_variant_id uuid not null references public.cafeteria_meal_variants(id) on delete restrict,
  account_id uuid not null references public.cafeteria_accounts(id) on delete restrict,
  portion_category_id uuid not null references public.cafeteria_portion_categories(id) on delete restrict,
  unit_price numeric(10,2) not null check (unit_price >= 0),
  quantity smallint not null check (quantity = 1),
  status text not null check (status in ('ordered','cancelled')),
  event_type text not null check (event_type in ('ordered','cancelled','reordered','variant_changed','updated')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_source text not null check (actor_source in ('owner','admin','kitchen','user','system')),
  occurred_at timestamptz not null default now()
);

create table public.cafeteria_late_change_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.cafeteria_orders(id) on delete restrict,
  diner_id uuid not null references public.cafeteria_diners(id) on delete restrict,
  meal_day_id uuid not null references public.cafeteria_meal_days(id) on delete restrict,
  request_type text not null check (request_type in ('add','cancel','change_variant')),
  requested_variant_id uuid references public.cafeteria_meal_variants(id) on delete restrict,
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  billing_outcome text check (billing_outcome in ('charged','not_charged','not_applicable')),
  requested_at timestamptz not null default now(),
  requested_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  decision_note text
);

create unique index cafeteria_late_change_one_pending_per_diner_day_idx
  on public.cafeteria_late_change_requests (diner_id, meal_day_id)
  where status = 'pending';

create index cafeteria_orders_day_status_idx on public.cafeteria_orders (meal_day_id, status);
create index cafeteria_orders_diner_idx on public.cafeteria_orders (diner_id);
create index cafeteria_orders_variant_idx on public.cafeteria_orders (meal_variant_id);
create index cafeteria_orders_account_idx on public.cafeteria_orders (account_id);
create index cafeteria_orders_portion_idx on public.cafeteria_orders (portion_category_id);
create index cafeteria_orders_created_by_idx on public.cafeteria_orders (created_by);
create index cafeteria_orders_updated_by_idx on public.cafeteria_orders (updated_by);

create index cafeteria_order_events_order_time_idx on public.cafeteria_order_events (order_id, occurred_at desc);
create index cafeteria_order_events_day_time_idx on public.cafeteria_order_events (meal_day_id, occurred_at desc);
create index cafeteria_order_events_diner_idx on public.cafeteria_order_events (diner_id);
create index cafeteria_order_events_variant_idx on public.cafeteria_order_events (meal_variant_id);
create index cafeteria_order_events_account_idx on public.cafeteria_order_events (account_id);
create index cafeteria_order_events_portion_idx on public.cafeteria_order_events (portion_category_id);
create index cafeteria_order_events_actor_idx on public.cafeteria_order_events (actor_user_id);

create index cafeteria_late_changes_day_status_idx on public.cafeteria_late_change_requests (meal_day_id, status);
create index cafeteria_late_changes_diner_idx on public.cafeteria_late_change_requests (diner_id);
create index cafeteria_late_changes_order_idx on public.cafeteria_late_change_requests (order_id);
create index cafeteria_late_changes_requested_variant_idx on public.cafeteria_late_change_requests (requested_variant_id);
create index cafeteria_late_changes_requested_by_idx on public.cafeteria_late_change_requests (requested_by);
create index cafeteria_late_changes_decided_by_idx on public.cafeteria_late_change_requests (decided_by);

create or replace function private.cafeteria_normalize_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_diner public.cafeteria_diners%rowtype;
  v_day public.cafeteria_meal_days%rowtype;
  v_variant_count integer;
  v_single_variant uuid;
  v_price numeric(10,2);
begin
  if tg_op = 'UPDATE' then
    new.diner_id := old.diner_id;
    new.meal_day_id := old.meal_day_id;
    new.account_id := old.account_id;
    new.portion_category_id := old.portion_category_id;
  end if;

  select * into v_diner
  from public.cafeteria_diners
  where id = new.diner_id;

  if not found or not v_diner.active then
    raise exception 'Strávník není aktivní.';
  end if;

  select * into v_day
  from public.cafeteria_meal_days
  where id = new.meal_day_id;

  if not found or v_day.status <> 'published' then
    raise exception 'Jídelní den není zveřejněný.';
  end if;

  if not (v_diner.valid_from <= v_day.meal_date and (v_diner.valid_to is null or v_diner.valid_to >= v_day.meal_date)) then
    raise exception 'Strávník není pro tento den aktivní.';
  end if;

  if new.status = 'ordered' then
    if new.meal_variant_id is null then
      select count(*), min(id)
        into v_variant_count, v_single_variant
      from public.cafeteria_meal_variants
      where meal_day_id = new.meal_day_id and active;

      if v_variant_count = 1 then
        new.meal_variant_id := v_single_variant;
      elsif v_variant_count = 0 then
        raise exception 'Pro tento den není aktivní žádná varianta jídla.';
      else
        raise exception 'Pro tento den je nutné vybrat variantu jídla.';
      end if;
    end if;

    if not exists (
      select 1 from public.cafeteria_meal_variants
      where id = new.meal_variant_id
        and meal_day_id = new.meal_day_id
        and active
    ) then
      raise exception 'Vybraná varianta nepatří k tomuto jídelnímu dni.';
    end if;
  end if;

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status = 'cancelled' and new.status = 'ordered') then
    new.account_id := v_diner.account_id;
    new.portion_category_id := v_diner.portion_category_id;

    select pr.price
      into v_price
    from public.cafeteria_price_rules pr
    where pr.portion_category_id = v_diner.portion_category_id
      and pr.active
      and pr.valid_from <= v_day.meal_date
      and (pr.valid_to is null or pr.valid_to >= v_day.meal_date)
    order by pr.valid_from desc, pr.created_at desc
    limit 1;

    if v_price is null then
      raise exception 'Pro tuto porci není nastavená platná cena.';
    end if;

    new.unit_price := v_price;
    new.ordered_at := now();
    new.cancelled_at := null;
  elsif tg_op = 'UPDATE' then
    new.unit_price := old.unit_price;
    new.quantity := old.quantity;
  end if;

  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status is distinct from 'cancelled') then
    new.cancelled_at := now();
  elsif new.status = 'ordered' then
    new.cancelled_at := null;
  end if;

  new.quantity := 1;
  new.updated_at := now();
  new.updated_by := auth.uid();

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;

  return new;
end
$$;

revoke all on function private.cafeteria_normalize_order() from public, anon, authenticated;

create trigger cafeteria_orders_normalize_before_write
before insert or update on public.cafeteria_orders
for each row execute function private.cafeteria_normalize_order();

create or replace function private.cafeteria_log_order_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_type text;
  v_actor_source text;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'ordered';
  elsif old.status = 'ordered' and new.status = 'cancelled' then
    v_event_type := 'cancelled';
  elsif old.status = 'cancelled' and new.status = 'ordered' then
    v_event_type := 'reordered';
  elsif old.meal_variant_id is distinct from new.meal_variant_id then
    v_event_type := 'variant_changed';
  else
    v_event_type := 'updated';
  end if;

  if auth.uid() is null then
    v_actor_source := 'system';
  elsif public.is_owner() then
    v_actor_source := 'owner';
  elsif exists (
    select 1 from public.user_module_roles r
    where r.user_id = auth.uid() and r.module = 'cafeteria' and r.role = 'admin'
  ) then
    v_actor_source := 'admin';
  elsif exists (
    select 1 from public.user_module_roles r
    where r.user_id = auth.uid() and r.module = 'cafeteria' and r.role = 'kitchen'
  ) then
    v_actor_source := 'kitchen';
  else
    v_actor_source := 'user';
  end if;

  insert into public.cafeteria_order_events (
    order_id, diner_id, meal_day_id, meal_variant_id, account_id,
    portion_category_id, unit_price, quantity, status, event_type,
    actor_user_id, actor_source, occurred_at
  ) values (
    new.id, new.diner_id, new.meal_day_id, new.meal_variant_id, new.account_id,
    new.portion_category_id, new.unit_price, new.quantity, new.status, v_event_type,
    auth.uid(), v_actor_source, now()
  );

  return new;
end
$$;

revoke all on function private.cafeteria_log_order_event() from public, anon, authenticated;

create trigger cafeteria_orders_log_after_write
after insert or update on public.cafeteria_orders
for each row execute function private.cafeteria_log_order_event();

create or replace function private.cafeteria_normalize_late_change_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day public.cafeteria_meal_days%rowtype;
  v_existing_order public.cafeteria_orders%rowtype;
  v_variant_count integer;
  v_single_variant uuid;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select * into v_day
  from public.cafeteria_meal_days
  where id = new.meal_day_id;

  if not found or v_day.status <> 'published' then
    raise exception 'Jídelní den není zveřejněný.';
  end if;

  if now() < v_day.cutoff_at then
    raise exception 'Uzávěrka ještě neproběhla; použijte běžnou změnu objednávky.';
  end if;

  if not exists (
    select 1 from public.cafeteria_diners d
    where d.id = new.diner_id
      and d.active
      and d.valid_from <= v_day.meal_date
      and (d.valid_to is null or d.valid_to >= v_day.meal_date)
  ) then
    raise exception 'Strávník není pro tento den aktivní.';
  end if;

  select * into v_existing_order
  from public.cafeteria_orders
  where diner_id = new.diner_id and meal_day_id = new.meal_day_id;

  if found then
    new.order_id := v_existing_order.id;
  else
    new.order_id := null;
  end if;

  if new.request_type = 'cancel' then
    if new.order_id is null or v_existing_order.status <> 'ordered' then
      raise exception 'Není aktivní objednávka, kterou lze pozdě zrušit.';
    end if;
    new.requested_variant_id := null;
  elsif new.request_type = 'change_variant' then
    if new.order_id is null or v_existing_order.status <> 'ordered' then
      raise exception 'Není aktivní objednávka, u které lze změnit variantu.';
    end if;
  elsif new.request_type = 'add' then
    if new.order_id is not null and v_existing_order.status = 'ordered' then
      raise exception 'Oběd už je objednaný.';
    end if;
  end if;

  if new.request_type in ('add','change_variant') then
    if new.requested_variant_id is null then
      select count(*), min(id)
        into v_variant_count, v_single_variant
      from public.cafeteria_meal_variants
      where meal_day_id = new.meal_day_id and active;

      if v_variant_count = 1 then
        new.requested_variant_id := v_single_variant;
      elsif v_variant_count = 0 then
        raise exception 'Pro tento den není aktivní žádná varianta jídla.';
      else
        raise exception 'Je nutné vybrat variantu jídla.';
      end if;
    end if;

    if not exists (
      select 1 from public.cafeteria_meal_variants
      where id = new.requested_variant_id
        and meal_day_id = new.meal_day_id
        and active
    ) then
      raise exception 'Vybraná varianta nepatří k tomuto jídelnímu dni.';
    end if;
  end if;

  new.status := 'pending';
  new.billing_outcome := null;
  new.requested_at := now();
  new.requested_by := auth.uid();
  new.decided_at := null;
  new.decided_by := null;
  new.decision_note := null;

  return new;
end
$$;

revoke all on function private.cafeteria_normalize_late_change_request() from public, anon, authenticated;

create trigger cafeteria_late_change_normalize_before_insert
before insert on public.cafeteria_late_change_requests
for each row execute function private.cafeteria_normalize_late_change_request();

alter table public.cafeteria_orders enable row level security;
alter table public.cafeteria_order_events enable row level security;
alter table public.cafeteria_late_change_requests enable row level security;

revoke all on table public.cafeteria_orders from public, anon, authenticated;
revoke all on table public.cafeteria_order_events from public, anon, authenticated;
revoke all on table public.cafeteria_late_change_requests from public, anon, authenticated;

grant select, insert, update on table public.cafeteria_orders to authenticated;
grant select on table public.cafeteria_order_events to authenticated;
grant select, insert, update on table public.cafeteria_late_change_requests to authenticated;

create policy "cafeteria orders visible to family self and staff"
on public.cafeteria_orders for select
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles r
    where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
  )
  or exists (
    select 1 from public.cafeteria_diners d
    where d.id = cafeteria_orders.diner_id and d.profile_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.cafeteria_diners d
    join public.cafeteria_family_users fu on fu.family_id = d.family_id
    where d.id = cafeteria_orders.diner_id
      and fu.user_id = (select auth.uid())
      and fu.active
      and fu.valid_from <= current_date
      and (fu.valid_to is null or fu.valid_to >= current_date)
  )
);

create policy "cafeteria users place orders before cutoff and staff anytime"
on public.cafeteria_orders for insert
to authenticated
with check (
  (
    (select public.is_owner())
    or exists (
      select 1 from public.user_module_roles r
      where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
    )
  )
  or (
    status = 'ordered'
    and exists (
      select 1 from public.cafeteria_meal_days md
      where md.id = cafeteria_orders.meal_day_id
        and md.status = 'published'
        and now() < md.cutoff_at
    )
    and (
      exists (
        select 1 from public.cafeteria_diners d
        where d.id = cafeteria_orders.diner_id and d.profile_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.cafeteria_diners d
        join public.cafeteria_family_users fu on fu.family_id = d.family_id
        where d.id = cafeteria_orders.diner_id
          and fu.user_id = (select auth.uid())
          and fu.active
          and fu.valid_from <= current_date
          and (fu.valid_to is null or fu.valid_to >= current_date)
      )
    )
  )
);

create policy "cafeteria users change orders before cutoff and staff anytime"
on public.cafeteria_orders for update
to authenticated
using (
  (
    (select public.is_owner())
    or exists (
      select 1 from public.user_module_roles r
      where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
    )
  )
  or (
    exists (
      select 1 from public.cafeteria_meal_days md
      where md.id = cafeteria_orders.meal_day_id and now() < md.cutoff_at
    )
    and (
      exists (
        select 1 from public.cafeteria_diners d
        where d.id = cafeteria_orders.diner_id and d.profile_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.cafeteria_diners d
        join public.cafeteria_family_users fu on fu.family_id = d.family_id
        where d.id = cafeteria_orders.diner_id
          and fu.user_id = (select auth.uid())
          and fu.active
          and fu.valid_from <= current_date
          and (fu.valid_to is null or fu.valid_to >= current_date)
      )
    )
  )
)
with check (
  (
    (select public.is_owner())
    or exists (
      select 1 from public.user_module_roles r
      where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
    )
  )
  or (
    status in ('ordered','cancelled')
    and exists (
      select 1 from public.cafeteria_meal_days md
      where md.id = cafeteria_orders.meal_day_id
        and md.status = 'published'
        and now() < md.cutoff_at
    )
    and (
      exists (
        select 1 from public.cafeteria_diners d
        where d.id = cafeteria_orders.diner_id and d.profile_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.cafeteria_diners d
        join public.cafeteria_family_users fu on fu.family_id = d.family_id
        where d.id = cafeteria_orders.diner_id
          and fu.user_id = (select auth.uid())
          and fu.active
          and fu.valid_from <= current_date
          and (fu.valid_to is null or fu.valid_to >= current_date)
      )
    )
  )
);

create policy "cafeteria order events visible with order"
on public.cafeteria_order_events for select
to authenticated
using (
  exists (
    select 1 from public.cafeteria_orders o
    where o.id = cafeteria_order_events.order_id
  )
);

create policy "cafeteria late requests visible to family self and staff"
on public.cafeteria_late_change_requests for select
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles r
    where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
  )
  or exists (
    select 1 from public.cafeteria_diners d
    where d.id = cafeteria_late_change_requests.diner_id and d.profile_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.cafeteria_diners d
    join public.cafeteria_family_users fu on fu.family_id = d.family_id
    where d.id = cafeteria_late_change_requests.diner_id
      and fu.user_id = (select auth.uid())
      and fu.active
      and fu.valid_from <= current_date
      and (fu.valid_to is null or fu.valid_to >= current_date)
  )
);

create policy "cafeteria users request late changes after cutoff"
on public.cafeteria_late_change_requests for insert
to authenticated
with check (
  status = 'pending'
  and requested_by = (select auth.uid())
  and exists (
    select 1 from public.cafeteria_meal_days md
    where md.id = cafeteria_late_change_requests.meal_day_id
      and md.status = 'published'
      and now() >= md.cutoff_at
  )
  and (
    exists (
      select 1 from public.cafeteria_diners d
      where d.id = cafeteria_late_change_requests.diner_id and d.profile_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.cafeteria_diners d
      join public.cafeteria_family_users fu on fu.family_id = d.family_id
      where d.id = cafeteria_late_change_requests.diner_id
        and fu.user_id = (select auth.uid())
        and fu.active
        and fu.valid_from <= current_date
        and (fu.valid_to is null or fu.valid_to >= current_date)
    )
  )
);

create policy "cafeteria staff decide late changes"
on public.cafeteria_late_change_requests for update
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles r
    where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
  )
)
with check (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles r
    where r.user_id = (select auth.uid()) and r.module = 'cafeteria' and r.role in ('admin','kitchen')
  )
);

create or replace function public.cafeteria_decide_late_change(
  target_request_id uuid,
  target_decision text,
  target_billing_outcome text default null,
  target_note text default null
)
returns public.cafeteria_late_change_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.cafeteria_late_change_requests%rowtype;
  v_outcome text;
begin
  if not (
    public.is_owner()
    or exists (
      select 1 from public.user_module_roles r
      where r.user_id = auth.uid() and r.module = 'cafeteria' and r.role in ('admin','kitchen')
    )
  ) then
    raise exception 'Nemáte oprávnění rozhodovat pozdní změny.';
  end if;

  if target_decision not in ('approved','denied') then
    raise exception 'Neplatné rozhodnutí.';
  end if;

  select * into v_request
  from public.cafeteria_late_change_requests
  where id = target_request_id
  for update;

  if not found then
    raise exception 'Žádost nebyla nalezena.';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'O této žádosti už bylo rozhodnuto.';
  end if;

  if target_decision = 'denied' then
    v_outcome := 'not_applicable';

    update public.cafeteria_late_change_requests
    set status = 'denied', billing_outcome = v_outcome,
        decided_at = now(), decided_by = auth.uid(), decision_note = target_note
    where id = target_request_id
    returning * into v_request;

    return v_request;
  end if;

  if v_request.request_type = 'cancel' then
    if target_billing_outcome not in ('charged','not_charged') then
      raise exception 'U pozdního zrušení je nutné určit, zda se oběd účtuje.';
    end if;
    v_outcome := target_billing_outcome;

    update public.cafeteria_orders
    set status = 'cancelled'
    where id = v_request.order_id;

  elsif v_request.request_type = 'add' then
    v_outcome := 'not_applicable';

    insert into public.cafeteria_orders (diner_id, meal_day_id, meal_variant_id, status)
    values (v_request.diner_id, v_request.meal_day_id, v_request.requested_variant_id, 'ordered')
    on conflict (diner_id, meal_day_id)
    do update set status = 'ordered', meal_variant_id = excluded.meal_variant_id;

  elsif v_request.request_type = 'change_variant' then
    v_outcome := 'not_applicable';

    update public.cafeteria_orders
    set meal_variant_id = v_request.requested_variant_id, status = 'ordered'
    where id = v_request.order_id;
  end if;

  update public.cafeteria_late_change_requests
  set status = 'approved', billing_outcome = v_outcome,
      decided_at = now(), decided_by = auth.uid(), decision_note = target_note
  where id = target_request_id
  returning * into v_request;

  return v_request;
end
$$;

revoke all on function public.cafeteria_decide_late_change(uuid,text,text,text) from public, anon;
grant execute on function public.cafeteria_decide_late_change(uuid,text,text,text) to authenticated;

create or replace view public.cafeteria_kitchen_order_counts
with (security_invoker = true)
as
with cutoff_last as (
  select distinct on (e.order_id)
    e.order_id,
    e.meal_day_id,
    e.meal_variant_id,
    e.portion_category_id,
    e.status,
    e.quantity
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days md on md.id = e.meal_day_id
  where e.occurred_at <= md.cutoff_at
  order by e.order_id, e.occurred_at desc, e.id desc
),
cutoff_counts as (
  select meal_day_id, meal_variant_id, portion_category_id,
         sum(quantity)::integer as cutoff_count
  from cutoff_last
  where status = 'ordered'
  group by meal_day_id, meal_variant_id, portion_category_id
),
current_counts as (
  select meal_day_id, meal_variant_id, portion_category_id,
         sum(quantity)::integer as current_count
  from public.cafeteria_orders
  where status = 'ordered'
  group by meal_day_id, meal_variant_id, portion_category_id
),
combined as (
  select
    coalesce(cu.meal_day_id, co.meal_day_id) as meal_day_id,
    coalesce(cu.meal_variant_id, co.meal_variant_id) as meal_variant_id,
    coalesce(cu.portion_category_id, co.portion_category_id) as portion_category_id,
    coalesce(co.cutoff_count, 0) as cutoff_count,
    coalesce(cu.current_count, 0) as current_count
  from current_counts cu
  full join cutoff_counts co
    on co.meal_day_id = cu.meal_day_id
   and co.meal_variant_id = cu.meal_variant_id
   and co.portion_category_id = cu.portion_category_id
)
select
  c.meal_day_id,
  md.meal_date,
  md.cutoff_at,
  c.meal_variant_id,
  mv.name as meal_variant_name,
  c.portion_category_id,
  pc.code as portion_code,
  pc.name as portion_name,
  c.cutoff_count,
  c.current_count,
  (c.current_count - c.cutoff_count) as late_delta
from combined c
join public.cafeteria_meal_days md on md.id = c.meal_day_id
join public.cafeteria_meal_variants mv on mv.id = c.meal_variant_id
join public.cafeteria_portion_categories pc on pc.id = c.portion_category_id;

revoke all on table public.cafeteria_kitchen_order_counts from public, anon, authenticated;
grant select on table public.cafeteria_kitchen_order_counts to authenticated;

create policy "cafeteria users read active price rules"
on public.cafeteria_price_rules for select
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles r
    where r.user_id = (select auth.uid()) and r.module = 'cafeteria'
  )
);

insert into public.cafeteria_price_rules (portion_category_id, valid_from, price, active)
select pc.id, date '2026-09-01',
       case pc.code when 'small' then 70.00 when 'large' then 80.00 end,
       true
from public.cafeteria_portion_categories pc
where pc.code in ('small','large')
  and not exists (
    select 1 from public.cafeteria_price_rules pr
    where pr.portion_category_id = pc.id
      and pr.valid_from = date '2026-09-01'
      and pr.active
  );
