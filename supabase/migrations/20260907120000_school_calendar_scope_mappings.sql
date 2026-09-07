-- Adminem potvrzené mapování soukromých Google Calendar událostí na prostory školy.
-- Obsah událostí ani OAuth tokeny se do databáze neukládají.
begin;

create table public.school_calendar_event_scope_mappings (
  id uuid primary key default gen_random_uuid(),
  external_event_id text,
  recurring_event_id text,
  scope_type text not null check (scope_type in ('unrestricted','whole_school','building','floor','rooms')),
  building_id uuid references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  check ((external_event_id is not null) <> (recurring_event_id is not null)),
  check (external_event_id is null or length(btrim(external_event_id)) between 1 and 1024),
  check (recurring_event_id is null or length(btrim(recurring_event_id)) between 1 and 1024),
  check (
    (scope_type = 'unrestricted' and building_id is null and floor_id is null)
    or (scope_type in ('whole_school','building') and building_id is not null and floor_id is null)
    or (scope_type = 'floor' and building_id is not null and floor_id is not null)
    or (scope_type = 'rooms' and building_id is not null)
  )
);

create table public.school_calendar_event_scope_rooms (
  mapping_id uuid not null references public.school_calendar_event_scope_mappings(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  primary key (mapping_id, room_id)
);

create table public.school_calendar_location_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null,
  normalized_alias text not null,
  scope_type text not null check (scope_type in ('whole_school','building','floor','rooms')),
  building_id uuid not null references public.buildings(id) on delete restrict,
  floor_id uuid references public.floors(id) on delete restrict,
  room_id uuid references public.rooms(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  check (length(btrim(alias)) between 1 and 200),
  check (length(btrim(normalized_alias)) between 1 and 200),
  check (
    (scope_type in ('whole_school','building') and floor_id is null and room_id is null)
    or (scope_type = 'floor' and floor_id is not null and room_id is null)
    or (scope_type = 'rooms' and room_id is not null)
  )
);

create unique index school_calendar_event_mapping_external_active_uq
  on public.school_calendar_event_scope_mappings(external_event_id) where active and external_event_id is not null;
create unique index school_calendar_event_mapping_recurring_active_uq
  on public.school_calendar_event_scope_mappings(recurring_event_id) where active and recurring_event_id is not null;
create unique index school_calendar_location_alias_active_uq
  on public.school_calendar_location_aliases(normalized_alias) where active;
create index school_calendar_mapping_rooms_room_idx on public.school_calendar_event_scope_rooms(room_id);

alter table public.school_calendar_event_scope_mappings enable row level security;
alter table public.school_calendar_event_scope_rooms enable row level security;
alter table public.school_calendar_location_aliases enable row level security;

create policy "approved users read active calendar mappings"
  on public.school_calendar_event_scope_mappings for select to authenticated
  using (public.can_view_school_data() and (active or public.is_admin()));
create policy "approved users read calendar mapping rooms"
  on public.school_calendar_event_scope_rooms for select to authenticated
  using (public.can_view_school_data() and exists (
    select 1 from public.school_calendar_event_scope_mappings mapping
    where mapping.id = mapping_id and (mapping.active or public.is_admin())
  ));
create policy "approved users read active calendar aliases"
  on public.school_calendar_location_aliases for select to authenticated
  using (public.can_view_school_data() and (active or public.is_admin()));

revoke all on table public.school_calendar_event_scope_mappings from public, anon, authenticated;
revoke all on table public.school_calendar_event_scope_rooms from public, anon, authenticated;
revoke all on table public.school_calendar_location_aliases from public, anon, authenticated;
grant select on table public.school_calendar_event_scope_mappings to authenticated;
grant select on table public.school_calendar_event_scope_rooms to authenticated;
grant select on table public.school_calendar_location_aliases to authenticated;

create function public.admin_save_school_calendar_event_mapping(
  p_id uuid,
  p_external_event_id text,
  p_recurring_event_id text,
  p_scope_type text,
  p_building_id uuid,
  p_floor_id uuid,
  p_room_ids uuid[],
  p_active boolean default true
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  new_id uuid := gen_random_uuid();
  clean_external text := nullif(btrim(p_external_event_id), '');
  clean_recurring text := nullif(btrim(p_recurring_event_id), '');
  room_id uuid;
begin
  if actor is null or not public.is_admin() then raise exception 'Nemáte oprávnění měnit mapování školního kalendáře.'; end if;
  if (clean_external is not null) = (clean_recurring is not null) then raise exception 'Vyberte konkrétní událost nebo celou opakující se sérii.'; end if;
  if p_scope_type not in ('unrestricted','whole_school','building','floor','rooms') then raise exception 'Neplatný rozsah školní akce.'; end if;
  if p_scope_type = 'unrestricted' and (p_building_id is not null or p_floor_id is not null or cardinality(coalesce(p_room_ids, '{}')) > 0) then raise exception 'Bez omezení prostoru nesmí obsahovat konkrétní prostor.'; end if;
  if p_scope_type in ('whole_school','building','floor','rooms') and p_building_id is null then raise exception 'Vyberte pracoviště.'; end if;
  if p_scope_type = 'floor' and p_floor_id is null then raise exception 'Vyberte patro.'; end if;
  if p_scope_type = 'rooms' and cardinality(coalesce(p_room_ids, '{}')) = 0 then raise exception 'Vyberte alespoň jednu místnost.'; end if;
  if p_floor_id is not null and not exists (select 1 from public.floors floor where floor.id = p_floor_id and floor.building_id = p_building_id) then raise exception 'Patro nepatří do vybraného pracoviště.'; end if;
  if exists (
    select 1 from unnest(coalesce(p_room_ids, '{}')) selected(room_id)
    left join public.rooms room on room.id = selected.room_id
    where room.id is null or room.building_id <> p_building_id or (p_floor_id is not null and room.floor_id <> p_floor_id)
  ) then raise exception 'Některá místnost nepatří do vybraného prostoru.'; end if;

  update public.school_calendar_event_scope_mappings mapping
  set active = false, updated_at = now(), updated_by = actor
  where mapping.active and (
    (p_id is not null and mapping.id = p_id)
    or (clean_external is not null and mapping.external_event_id = clean_external)
    or (clean_recurring is not null and mapping.recurring_event_id = clean_recurring)
  );

  insert into public.school_calendar_event_scope_mappings(
    id, external_event_id, recurring_event_id, scope_type, building_id, floor_id,
    active, created_by, updated_by
  ) values (
    new_id, clean_external, clean_recurring, p_scope_type,
    case when p_scope_type = 'unrestricted' then null else p_building_id end,
    case when p_scope_type = 'floor' then p_floor_id else null end,
    p_active, actor, actor
  );

  if p_scope_type = 'rooms' then
    foreach room_id in array coalesce(p_room_ids, '{}') loop
      insert into public.school_calendar_event_scope_rooms(mapping_id, room_id, created_by)
      values (new_id, room_id, actor) on conflict do nothing;
    end loop;
  end if;
  return new_id;
end
$$;

create function public.admin_save_school_calendar_location_alias(
  p_id uuid,
  p_alias text,
  p_scope_type text,
  p_building_id uuid,
  p_floor_id uuid,
  p_room_id uuid,
  p_active boolean default true
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  clean_alias text := btrim(p_alias);
  normalized text := lower(translate(clean_alias, 'ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž', 'ACDEEINORSTUUYZacdeeinorstuuyz'));
  new_id uuid := gen_random_uuid();
begin
  if actor is null or not public.is_admin() then raise exception 'Nemáte oprávnění měnit aliasy školního kalendáře.'; end if;
  if length(clean_alias) < 2 or length(clean_alias) > 200 then raise exception 'Alias musí mít 2 až 200 znaků.'; end if;
  if p_scope_type not in ('whole_school','building','floor','rooms') then raise exception 'Neplatný rozsah aliasu.'; end if;
  if p_building_id is null then raise exception 'Vyberte pracoviště.'; end if;
  if p_scope_type = 'floor' and p_floor_id is null then raise exception 'Vyberte patro.'; end if;
  if p_scope_type = 'rooms' and p_room_id is null then raise exception 'Vyberte místnost.'; end if;
  if p_floor_id is not null and not exists (select 1 from public.floors floor where floor.id = p_floor_id and floor.building_id = p_building_id) then raise exception 'Patro nepatří do vybraného pracoviště.'; end if;
  if p_room_id is not null and not exists (select 1 from public.rooms room where room.id = p_room_id and room.building_id = p_building_id) then raise exception 'Místnost nepatří do vybraného pracoviště.'; end if;

  update public.school_calendar_location_aliases alias
  set active = false, updated_at = now(), updated_by = actor
  where alias.active and ((p_id is not null and alias.id = p_id) or alias.normalized_alias = normalized);
  insert into public.school_calendar_location_aliases(
    id, alias, normalized_alias, scope_type, building_id, floor_id, room_id,
    active, created_by, updated_by
  ) values (
    new_id, clean_alias, normalized, p_scope_type, p_building_id,
    case when p_scope_type = 'floor' then p_floor_id else null end,
    case when p_scope_type = 'rooms' then p_room_id else null end,
    p_active, actor, actor
  );
  return new_id;
end
$$;

revoke all on function public.admin_save_school_calendar_event_mapping(uuid,text,text,text,uuid,uuid,uuid[],boolean) from public, anon;
revoke all on function public.admin_save_school_calendar_location_alias(uuid,text,text,uuid,uuid,uuid,boolean) from public, anon;
grant execute on function public.admin_save_school_calendar_event_mapping(uuid,text,text,text,uuid,uuid,uuid[],boolean) to authenticated;
grant execute on function public.admin_save_school_calendar_location_alias(uuid,text,text,uuid,uuid,uuid,boolean) to authenticated;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.school_calendar_event_scope_mappings'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.school_calendar_event_scope_rooms'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.school_calendar_location_aliases'::regclass) then
    raise exception 'RLS mapování školního kalendáře musí být zapnuté.';
  end if;
  if has_table_privilege('anon', 'public.school_calendar_event_scope_mappings', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon', 'public.school_calendar_event_scope_rooms', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon', 'public.school_calendar_location_aliases', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Anon nesmí přistupovat k mapování školního kalendáře.';
  end if;
  if has_table_privilege('authenticated', 'public.school_calendar_event_scope_mappings', 'INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.school_calendar_event_scope_rooms', 'INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.school_calendar_location_aliases', 'INSERT,UPDATE,DELETE') then
    raise exception 'Mapování školního kalendáře se smí měnit pouze přes admin RPC.';
  end if;
  if has_function_privilege('anon', 'public.admin_save_school_calendar_event_mapping(uuid,text,text,text,uuid,uuid,uuid[],boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_save_school_calendar_location_alias(uuid,text,text,uuid,uuid,uuid,boolean)', 'EXECUTE') then
    raise exception 'Anon nesmí měnit mapování školního kalendáře.';
  end if;
end
$$;

commit;
