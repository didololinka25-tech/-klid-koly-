-- Přiřazení nákupních položek ke konkrétnímu pracovišti.
-- Historické položky bez building_id zůstávají zachované jako společné.

begin;

alter table public.stock_items
  add column if not exists building_id uuid references public.buildings(id) on delete restrict;

create index if not exists stock_items_building_status_idx
  on public.stock_items(building_id, active, status);

comment on column public.stock_items.building_id is
  'Pracoviště nové nákupní položky; NULL označuje zachovanou historickou společnou položku.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='stock_items'
      and column_name='building_id' and data_type='uuid'
  ) then
    raise exception 'stock_items.building_id nebylo vytvořeno.';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.stock_items'::regclass) then
    raise exception 'RLS na stock_items musí zůstat zapnuté.';
  end if;
  if exists (
    select 1 from public.stock_items item
    where item.building_id is not null
      and not exists(select 1 from public.buildings building where building.id=item.building_id)
  ) then
    raise exception 'Nákupní položka odkazuje na neexistující pracoviště.';
  end if;
end $$;

commit;
