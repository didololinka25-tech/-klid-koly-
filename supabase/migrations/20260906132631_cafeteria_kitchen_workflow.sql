begin;

create table if not exists public.cafeteria_order_fulfillments (
  order_id uuid primary key references public.cafeteria_orders(id) on delete restrict,
  status text not null check (status in ('waiting','boxed','issued')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.cafeteria_order_fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.cafeteria_orders(id) on delete restrict,
  status text not null check (status in ('waiting','boxed','issued')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  occurred_at timestamptz not null default now()
);

create index if not exists cafeteria_fulfillment_events_order_time_idx
  on public.cafeteria_order_fulfillment_events (order_id, occurred_at desc);
create index if not exists cafeteria_fulfillment_events_actor_idx
  on public.cafeteria_order_fulfillment_events (actor_user_id);

create or replace function private.cafeteria_normalize_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.order_id := old.order_id;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

revoke all on function private.cafeteria_normalize_fulfillment() from public, anon, authenticated;

drop trigger if exists cafeteria_fulfillments_normalize_before_write on public.cafeteria_order_fulfillments;
create trigger cafeteria_fulfillments_normalize_before_write
before insert or update on public.cafeteria_order_fulfillments
for each row execute function private.cafeteria_normalize_fulfillment();

create or replace function private.cafeteria_log_fulfillment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into public.cafeteria_order_fulfillment_events (
      order_id, status, actor_user_id, occurred_at
    ) values (
      new.order_id, new.status, auth.uid(), now()
    );
  end if;
  return new;
end
$$;

revoke all on function private.cafeteria_log_fulfillment_event() from public, anon, authenticated;

drop trigger if exists cafeteria_fulfillments_log_after_write on public.cafeteria_order_fulfillments;
create trigger cafeteria_fulfillments_log_after_write
after insert or update on public.cafeteria_order_fulfillments
for each row execute function private.cafeteria_log_fulfillment_event();

alter table public.cafeteria_order_fulfillments enable row level security;
alter table public.cafeteria_order_fulfillment_events enable row level security;

revoke all on table public.cafeteria_order_fulfillments from public, anon, authenticated;
revoke all on table public.cafeteria_order_fulfillment_events from public, anon, authenticated;
grant select, insert, update on table public.cafeteria_order_fulfillments to authenticated;
grant select on table public.cafeteria_order_fulfillment_events to authenticated;

drop policy if exists "cafeteria staff read fulfillment" on public.cafeteria_order_fulfillments;
create policy "cafeteria staff read fulfillment"
on public.cafeteria_order_fulfillments for select
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles role
    where role.user_id = (select auth.uid())
      and role.module = 'cafeteria'
      and role.role in ('admin','kitchen')
  )
);

drop policy if exists "cafeteria staff add fulfillment" on public.cafeteria_order_fulfillments;
create policy "cafeteria staff add fulfillment"
on public.cafeteria_order_fulfillments for insert
to authenticated
with check (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles role
    where role.user_id = (select auth.uid())
      and role.module = 'cafeteria'
      and role.role in ('admin','kitchen')
  )
);

drop policy if exists "cafeteria staff update fulfillment" on public.cafeteria_order_fulfillments;
create policy "cafeteria staff update fulfillment"
on public.cafeteria_order_fulfillments for update
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles role
    where role.user_id = (select auth.uid())
      and role.module = 'cafeteria'
      and role.role in ('admin','kitchen')
  )
)
with check (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles role
    where role.user_id = (select auth.uid())
      and role.module = 'cafeteria'
      and role.role in ('admin','kitchen')
  )
);

drop policy if exists "cafeteria staff read fulfillment events" on public.cafeteria_order_fulfillment_events;
create policy "cafeteria staff read fulfillment events"
on public.cafeteria_order_fulfillment_events for select
to authenticated
using (
  (select public.is_owner())
  or exists (
    select 1 from public.user_module_roles role
    where role.user_id = (select auth.uid())
      and role.module = 'cafeteria'
      and role.role in ('admin','kitchen')
  )
);

create or replace function public.cafeteria_kitchen_service(target_date date default (now() at time zone 'Europe/Prague')::date)
returns table (
  order_id uuid,
  diner_id uuid,
  diner_name text,
  portion_code text,
  portion_name text,
  variant_id uuid,
  variant_name text,
  fulfillment_status text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not (
    public.is_owner()
    or exists (
      select 1 from public.user_module_roles role
      where role.user_id = auth.uid()
        and role.module = 'cafeteria'
        and role.role in ('admin','kitchen')
    )
  ) then
    raise exception 'Nemáte oprávnění pro výdej obědů.' using errcode = '42501';
  end if;

  return query
  select
    orders.id,
    diner.id,
    diner.full_name,
    portion.code,
    portion.name,
    variant.id,
    variant.name,
    coalesce(fulfillment.status, 'waiting')
  from public.cafeteria_orders orders
  join public.cafeteria_meal_days day on day.id = orders.meal_day_id
  join public.cafeteria_diners diner on diner.id = orders.diner_id
  join public.cafeteria_portion_categories portion on portion.id = orders.portion_category_id
  join public.cafeteria_meal_variants variant on variant.id = orders.meal_variant_id
  left join public.cafeteria_order_fulfillments fulfillment on fulfillment.order_id = orders.id
  where day.meal_date = target_date
    and day.status = 'published'
    and orders.status = 'ordered'
  order by
    case coalesce(fulfillment.status, 'waiting') when 'waiting' then 1 when 'boxed' then 2 else 3 end,
    diner.full_name,
    diner.id;
end
$$;

revoke all on function public.cafeteria_kitchen_service(date) from public, anon, authenticated;
grant execute on function public.cafeteria_kitchen_service(date) to authenticated;

create or replace function public.cafeteria_kitchen_search_diners(
  search_text text default '',
  target_date date default (now() at time zone 'Europe/Prague')::date
)
returns table (
  diner_id uuid,
  diner_name text,
  portion_category_id uuid,
  portion_code text,
  portion_name text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not (
    public.is_owner()
    or exists (
      select 1 from public.user_module_roles role
      where role.user_id = auth.uid()
        and role.module = 'cafeteria'
        and role.role in ('admin','kitchen')
    )
  ) then
    raise exception 'Nemáte oprávnění hledat strávníky.' using errcode = '42501';
  end if;

  return query
  select diner.id, diner.full_name, diner.portion_category_id, portion.code, portion.name
  from public.cafeteria_diners diner
  join public.cafeteria_portion_categories portion on portion.id = diner.portion_category_id
  where diner.active
    and diner.valid_from <= target_date
    and (diner.valid_to is null or diner.valid_to >= target_date)
    and (nullif(trim(search_text), '') is null or diner.full_name ilike '%' || trim(search_text) || '%')
  order by diner.full_name, diner.id
  limit 50;
end
$$;

revoke all on function public.cafeteria_kitchen_search_diners(text,date) from public, anon, authenticated;
grant execute on function public.cafeteria_kitchen_search_diners(text,date) to authenticated;

create or replace function public.cafeteria_set_order_fulfillment(
  target_order_id uuid,
  target_status text
)
returns public.cafeteria_order_fulfillments
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.cafeteria_order_fulfillments%rowtype;
begin
  if auth.uid() is null or not (
    public.is_owner()
    or exists (
      select 1 from public.user_module_roles role
      where role.user_id = auth.uid()
        and role.module = 'cafeteria'
        and role.role in ('admin','kitchen')
    )
  ) then
    raise exception 'Nemáte oprávnění měnit stav výdeje.' using errcode = '42501';
  end if;

  if target_status not in ('waiting','boxed','issued') then
    raise exception 'Neplatný stav výdeje.';
  end if;

  if not exists (
    select 1
    from public.cafeteria_orders orders
    join public.cafeteria_meal_days day on day.id = orders.meal_day_id
    where orders.id = target_order_id
      and orders.status = 'ordered'
      and day.meal_date = (now() at time zone 'Europe/Prague')::date
  ) then
    raise exception 'Aktivní dnešní objednávka nebyla nalezena.';
  end if;

  insert into public.cafeteria_order_fulfillments (order_id, status, updated_by)
  values (target_order_id, target_status, auth.uid())
  on conflict (order_id) do update
    set status = excluded.status,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into result;

  return result;
end
$$;

revoke all on function public.cafeteria_set_order_fulfillment(uuid,text) from public, anon, authenticated;
grant execute on function public.cafeteria_set_order_fulfillment(uuid,text) to authenticated;

create or replace function public.cafeteria_kitchen_pending_requests()
returns table (
  request_id uuid,
  request_type text,
  requested_at timestamptz,
  meal_day_id uuid,
  meal_date date,
  diner_id uuid,
  diner_name text,
  portion_name text,
  order_id uuid,
  current_variant_id uuid,
  current_variant_name text,
  requested_variant_id uuid,
  requested_variant_name text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not (
    public.is_owner()
    or exists (
      select 1 from public.user_module_roles role
      where role.user_id = auth.uid()
        and role.module = 'cafeteria'
        and role.role in ('admin','kitchen')
    )
  ) then
    raise exception 'Nemáte oprávnění číst pozdní žádosti.' using errcode = '42501';
  end if;

  return query
  select
    request.id,
    request.request_type,
    request.requested_at,
    day.id,
    day.meal_date,
    diner.id,
    diner.full_name,
    portion.name,
    orders.id,
    current_variant.id,
    current_variant.name,
    requested_variant.id,
    requested_variant.name
  from public.cafeteria_late_change_requests request
  join public.cafeteria_meal_days day on day.id = request.meal_day_id
  join public.cafeteria_diners diner on diner.id = request.diner_id
  join public.cafeteria_portion_categories portion on portion.id = diner.portion_category_id
  left join public.cafeteria_orders orders on orders.id = request.order_id
  left join public.cafeteria_meal_variants current_variant on current_variant.id = orders.meal_variant_id
  left join public.cafeteria_meal_variants requested_variant on requested_variant.id = request.requested_variant_id
  where request.status = 'pending'
  order by day.meal_date, request.requested_at, diner.full_name;
end
$$;

revoke all on function public.cafeteria_kitchen_pending_requests() from public, anon, authenticated;
grant execute on function public.cafeteria_kitchen_pending_requests() to authenticated;

commit;
