-- Spouštět pouze proti lokální/testovací databázi po migraci 20260906132631.
-- Test je read-only a ověřuje RLS, ACL, audit a úzký kitchen povrch.
begin;

do $$
declare
  table_name text;
  table_oid regclass;
  policy_text text;
begin
  foreach table_name in array array['cafeteria_order_fulfillments', 'cafeteria_order_fulfillment_events'] loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null then
      raise exception 'Chybí kitchen tabulka public.%.', table_name;
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

  if has_table_privilege('authenticated', 'public.cafeteria_order_fulfillment_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.cafeteria_order_fulfillment_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.cafeteria_order_fulfillment_events', 'DELETE') then
    raise exception 'Audit fulfillment událostí musí být append-only z klientského pohledu.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.cafeteria_order_fulfillments'::regclass
      and tgname = 'cafeteria_fulfillments_log_after_write'
      and not tgisinternal
  ) then
    raise exception 'Chybí fulfillment audit trigger.';
  end if;

  select string_agg(coalesce(qual, '') || ' ' || coalesce(with_check, ''), ' ')
  into policy_text
  from pg_policies
  where schemaname = 'public'
    and tablename in ('cafeteria_order_fulfillments', 'cafeteria_order_fulfillment_events');

  if policy_text is null or policy_text not ilike '%kitchen%' or policy_text not ilike '%admin%' then
    raise exception 'Fulfillment policies neověřují kitchen/admin roli.';
  end if;
  if policy_text ilike '%parent%' or policy_text ilike '%diner%' then
    raise exception 'Rodič ani diner nesmí získat interní výdej.';
  end if;

  if has_function_privilege('anon', 'public.cafeteria_kitchen_service(date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cafeteria_kitchen_search_diners(text,date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cafeteria_set_order_fulfillment(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cafeteria_kitchen_pending_requests()', 'EXECUTE') then
    raise exception 'anon nesmí spouštět kitchen RPC.';
  end if;

  if not has_function_privilege('authenticated', 'public.cafeteria_kitchen_service(date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.cafeteria_kitchen_search_diners(text,date)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.cafeteria_set_order_fulfillment(uuid,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.cafeteria_kitchen_pending_requests()', 'EXECUTE') then
    raise exception 'authenticated potřebuje kitchen RPC; funkce samy ověřují modulovou roli.';
  end if;
end
$$;

rollback;

