begin;

alter table public.cafeteria_orders
  drop constraint if exists cafeteria_orders_quantity_check;
alter table public.cafeteria_orders
  add constraint cafeteria_orders_quantity_range_check check (quantity between 1 and 10);

alter table public.cafeteria_order_events
  drop constraint if exists cafeteria_order_events_quantity_check;
alter table public.cafeteria_order_events
  add constraint cafeteria_order_events_quantity_range_check check (quantity between 1 and 10);

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
  else
    new.quantity := coalesce(new.quantity, 1);
  end if;

  select * into v_diner from public.cafeteria_diners where id = new.diner_id;
  if not found or not v_diner.active then raise exception 'Strávník není aktivní.'; end if;

  select * into v_day from public.cafeteria_meal_days where id = new.meal_day_id;
  if not found or v_day.status <> 'published' then raise exception 'Jídelní den není zveřejněný.'; end if;
  if not (v_diner.valid_from <= v_day.meal_date and (v_diner.valid_to is null or v_diner.valid_to >= v_day.meal_date)) then
    raise exception 'Strávník není pro tento den aktivní.';
  end if;

  if new.status = 'ordered' then
    if new.meal_variant_id is null then
      select count(*), min(id) into v_variant_count, v_single_variant
      from public.cafeteria_meal_variants where meal_day_id = new.meal_day_id and active;
      if v_variant_count = 1 then new.meal_variant_id := v_single_variant;
      elsif v_variant_count = 0 then raise exception 'Pro tento den není aktivní žádná varianta jídla.';
      else raise exception 'Pro tento den je nutné vybrat variantu jídla.';
      end if;
    end if;
    if not exists (
      select 1 from public.cafeteria_meal_variants
      where id = new.meal_variant_id and meal_day_id = new.meal_day_id and active
    ) then raise exception 'Vybraná varianta nepatří k tomuto jídelnímu dni.'; end if;
  end if;

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status = 'cancelled' and new.status = 'ordered') then
    new.account_id := v_diner.account_id;
    new.portion_category_id := v_diner.portion_category_id;
    select pr.price into v_price
    from public.cafeteria_price_rules pr
    where pr.portion_category_id = v_diner.portion_category_id
      and pr.active and pr.valid_from <= v_day.meal_date
      and (pr.valid_to is null or pr.valid_to >= v_day.meal_date)
    order by pr.valid_from desc, pr.created_at desc limit 1;
    if v_price is null then raise exception 'Pro tuto porci není nastavená platná cena.'; end if;
    new.unit_price := v_price;
    new.ordered_at := now();
    new.cancelled_at := null;
  elsif tg_op = 'UPDATE' then
    new.unit_price := old.unit_price;
    new.quantity := old.quantity;
  end if;

  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status is distinct from 'cancelled') then
    new.cancelled_at := now();
  elsif new.status = 'ordered' then new.cancelled_at := null;
  end if;

  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end
$$;

revoke all on function private.cafeteria_normalize_order() from public, anon, authenticated;

create or replace view public.cafeteria_kitchen_order_counts
with (security_invoker = true)
as
with cutoff_last as (
  select distinct on (e.order_id) e.order_id, e.meal_day_id, e.meal_variant_id,
    e.portion_category_id, e.status, e.quantity
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days md on md.id = e.meal_day_id
  where e.occurred_at <= md.cutoff_at
  order by e.order_id, e.occurred_at desc, e.id desc
), cutoff_counts as (
  select meal_day_id, meal_variant_id, portion_category_id, sum(quantity)::integer as cutoff_count
  from cutoff_last where status = 'ordered' group by meal_day_id, meal_variant_id, portion_category_id
), current_counts as (
  select meal_day_id, meal_variant_id, portion_category_id, sum(quantity)::integer as current_count
  from public.cafeteria_orders where status = 'ordered' group by meal_day_id, meal_variant_id, portion_category_id
), combined as (
  select coalesce(cu.meal_day_id, co.meal_day_id) as meal_day_id,
    coalesce(cu.meal_variant_id, co.meal_variant_id) as meal_variant_id,
    coalesce(cu.portion_category_id, co.portion_category_id) as portion_category_id,
    coalesce(co.cutoff_count, 0) as cutoff_count, coalesce(cu.current_count, 0) as current_count
  from current_counts cu full join cutoff_counts co
    on co.meal_day_id = cu.meal_day_id and co.meal_variant_id = cu.meal_variant_id
   and co.portion_category_id = cu.portion_category_id
)
select c.meal_day_id, md.meal_date, md.cutoff_at, c.meal_variant_id,
  mv.name as meal_variant_name, c.portion_category_id, pc.code as portion_code,
  pc.name as portion_name, c.cutoff_count, c.current_count,
  (c.current_count - c.cutoff_count) as late_delta
from combined c
join public.cafeteria_meal_days md on md.id = c.meal_day_id
join public.cafeteria_meal_variants mv on mv.id = c.meal_variant_id
join public.cafeteria_portion_categories pc on pc.id = c.portion_category_id;

revoke all on table public.cafeteria_kitchen_order_counts from public, anon, authenticated;
grant select on table public.cafeteria_kitchen_order_counts to authenticated;

drop function if exists public.cafeteria_kitchen_service(date);
create function public.cafeteria_kitchen_service(target_date date default (now() at time zone 'Europe/Prague')::date)
returns table (
  order_id uuid, diner_id uuid, diner_name text, quantity smallint,
  portion_code text, portion_name text, variant_id uuid, variant_name text,
  fulfillment_status text
)
language plpgsql security definer set search_path = '' stable
as $$
begin
  if auth.uid() is null or not (
    public.is_owner() or exists (
      select 1 from public.user_module_roles role
      where role.user_id = auth.uid() and role.module = 'cafeteria' and role.role in ('admin','kitchen')
    )
  ) then raise exception 'Nemáte oprávnění pro výdej obědů.' using errcode = '42501'; end if;
  return query
  select orders.id, diner.id, diner.full_name, orders.quantity, portion.code, portion.name,
    variant.id, variant.name, coalesce(fulfillment.status, 'waiting')
  from public.cafeteria_orders orders
  join public.cafeteria_meal_days day on day.id = orders.meal_day_id
  join public.cafeteria_diners diner on diner.id = orders.diner_id
  join public.cafeteria_portion_categories portion on portion.id = orders.portion_category_id
  join public.cafeteria_meal_variants variant on variant.id = orders.meal_variant_id
  left join public.cafeteria_order_fulfillments fulfillment on fulfillment.order_id = orders.id
  where day.meal_date = target_date and day.status = 'published' and orders.status = 'ordered'
  order by case coalesce(fulfillment.status, 'waiting') when 'waiting' then 1 when 'boxed' then 2 else 3 end,
    diner.full_name, diner.id;
end
$$;

revoke all on function public.cafeteria_kitchen_service(date) from public, anon, authenticated;
grant execute on function public.cafeteria_kitchen_service(date) to authenticated;

commit;
