begin;

-- Databázově řízený obsah Manuálu. Provozní texty lze měnit bez deploye.
create table if not exists public.manual_entries (
  id uuid primary key default gen_random_uuid(),
  entry_key text unique,
  entry_type text not null,
  title text not null,
  category text not null default 'Ostatní',
  body text,
  supplies text,
  steps text,
  warnings text,
  school_note text,
  marker_color text,
  activity_types text[] not null default '{}',
  featured boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_entries_type_valid check (entry_type in ('guide', 'practical', 'arrival')),
  constraint manual_entries_marker_color_valid check (marker_color is null or marker_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint manual_entries_title_present check (length(btrim(title)) > 0)
);

drop trigger if exists manual_entries_updated_at on public.manual_entries;
create trigger manual_entries_updated_at before update on public.manual_entries
for each row execute procedure public.set_updated_at();

alter table public.manual_entries enable row level security;
drop policy if exists "approved users read active manual" on public.manual_entries;
drop policy if exists "admins create manual" on public.manual_entries;
drop policy if exists "admins update manual" on public.manual_entries;
create policy "approved users read active manual" on public.manual_entries
for select to authenticated
using (public.can_view_school_data() and (active or public.is_admin()));
create policy "admins create manual" on public.manual_entries
for insert to authenticated with check (public.is_admin());
create policy "admins update manual" on public.manual_entries
for update to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.manual_entries to authenticated;
revoke delete on public.manual_entries from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'manual_entries'
  ) then
    alter publication supabase_realtime add table public.manual_entries;
  end if;
end $$;

-- Bezpečný obecný základ; škola jej může celý upravit v aplikaci.
insert into public.manual_entries
  (entry_key, entry_type, title, category, supplies, steps, warnings, school_note, activity_types, featured, active, sort_order)
values
  ('guide-toilet','guide','WC','Hygiena','Rukavice, hadr určený pro WC a prostředek schválený školou.','Odstraňte nečistoty, očistěte WC shora dolů a nakonec ukliďte okolí. Použitý hadr odložte k vyprání.','Nekombinujte různé čisticí prostředky.','Žlutý hadr je určený pro záchody / WC.','{toilet}',true,true,10),
  ('guide-sink','guide','Umyvadla a baterie','Hygiena','Čistý hadr a prostředek určený školou.','Očistěte umyvadlo, baterii a okolní plochu. Nakonec povrch setřete beze šmouh.','Dávejte pozor na věci ponechané u umyvadla.',null,'{sink}',false,true,20),
  ('guide-drain','guide','Výlevky','Hygiena','Rukavice, určený hadr a prostředek školy.','Odstraňte hrubé nečistoty, umyjte vnitřek i okraj a opláchněte.','Nepoužívejte společně neznámé prostředky.',null,'{sink}',false,true,30),
  ('guide-mirror','guide','Zrcadla','Skla','Modrý hadr a prostředek na skla schválený školou.','Setřete nečistoty a vyleštěte suchou stranou hadru beze šmouh.','Nestříkejte přímo na elektrické prvky.','Modrý hadr je určený pro okna a zrcadla.','{mirror}',false,true,40),
  ('guide-windows','guide','Okna a skla','Skla','Modrý hadr, stěrka a prostředek schválený školou.','Umyjte rám a sklo, stáhněte vodu a zkontrolujte šmouhy.','Na výškově obtížná místa používejte jen bezpečné vybavení školy.','Modrý hadr je určený pro okna a zrcadla.','{windows}',true,true,50),
  ('guide-doors','guide','Dveře','Povrchy','Čistý hadr a prostředek vhodný pro daný povrch.','Otřete plochu dveří, hrany a viditelné nečistoty.','Nezamáčejte zámky ani elektrické prvky.',null,'{doors}',false,true,60),
  ('guide-floors','guide','Podlahy','Podlahy','Koště nebo vysavač, mop a prostředek určený škole.','Nejdříve podlahu zameťte nebo vysajte. Teprve potom ji vytřete směrem k východu.','Vytírání nikdy nezačínejte před odstraněním suchých nečistot.',null,'{vacuum,mop}',true,true,70),
  ('guide-carpet','guide','Koberce','Podlahy','Vysavač a vhodný nástavec.','Odstraňte věci z cesty a koberec vysajte pomalými překrývajícími se tahy.','Kabel veďte tak, aby nepřekážel v cestě.',null,'{vacuum}',false,true,80),
  ('guide-deep-clean','guide','Vodní vysavač / hloubkové čištění','Podlahy','Vodní vysavač a prostředek určený výrobcem a školou.','Připravte prostor, postupujte podle návodu stroje a po práci vybavení vyčistěte.','Použijte pouze zaškolené vybavení a vhodný prostředek.',null,'{deep_clean}',false,true,90),
  ('guide-tiles','guide','Kachličky, obklady a sprcha','Hygiena','Rukavice, hadr a prostředek vhodný na obklady.','Očistěte obklady shora dolů, opláchněte podle použitého prostředku a osušte.','Dávejte pozor na kluzkou mokrou podlahu.',null,'{tiles}',false,true,100),
  ('guide-tables','guide','Stoly a lavičky','Povrchy','Čistý hadr a prostředek vhodný pro nábytek.','Odstraňte volné věci, otřete celou plochu a vraťte pouze původní vybavení.','Nemanipulujte se soukromými věcmi více, než je nutné.','Při nejasnosti věci pouze bezpečně odsuňte.', '{tables}',false,true,110),
  ('guide-storage','guide','Skříňky a police','Povrchy','Čistý hadr a prostředek vhodný pro povrch.','Otřete dostupné vnější plochy a police podle zadání úkolu.','Neotvírejte uzamčené ani soukromé skříňky.',null,'{surfaces}',false,true,120),
  ('guide-upholstery','guide','Gauče a čalounění','Povrchy','Vysavač s vhodným nástavcem.','Odstraňte volné nečistoty a čalounění opatrně vysajte.','Mokré čištění provádějte jen podle školního postupu.',null,'{surfaces}',false,true,130),
  ('guide-trash','guide','Koše','Odpady','Rukavice a správný náhradní pytel.','Pytel bezpečně uzavřete, vyjměte a vložte nový správné velikosti.','Ostré nebo neznámé předměty neberte holou rukou.','Velikosti a barvy pytlů jsou v Praktických informacích.','{trash}',true,true,140),
  ('guide-stairs','guide','Schodiště a zábradlí','Podlahy','Vysavač nebo koště, mop a čistý hadr.','Postupujte po úsecích, udržujte průchod bezpečný a mokré místo nenechávejte bez kontroly.','Pozor na pád a kluzké schody.',null,'{vacuum,mop,surfaces,windows}',false,true,150),
  ('guide-laundry','guide','Praní hadrů','Pomůcky','Koš na použité hadry a vybavení určené školou.','Posbírejte hadry, roztřiďte je podle školního postupu a vyperte podle povoleného programu.','Nemíchejte materiály, které se podle školního postupu perou odděleně.',null,'{laundry}',false,true,160),
  ('guide-tools','guide','Úklidové pomůcky','Pomůcky','Místo pro čisté a použité pomůcky.','Po práci pomůcky očistěte, nechte proschnout a uložte na určené místo.','Poškozenou pomůcku nahlaste v Provozu.',null,'{}',false,true,170),
  ('guide-machine','guide','Mop a úklidový stroj','Technika',null,null,null,'Přesný školní postup zatím není doplněný.','{}',false,false,180)
on conflict (entry_key) do nothing;

insert into public.manual_entries
  (entry_key, entry_type, title, category, body, marker_color, featured, active, sort_order)
values
  ('practical-bag-blue-60','practical','Tříděný odpad','Pytle do košů','Modrý pytel · 60 l','#2563EB',false,true,10),
  ('practical-bag-yellow-35','practical','Plasty','Pytle do košů','Žlutý pytel · 35 l','#FACC15',false,true,20),
  ('practical-bag-white-25','practical','Běžné koše','Pytle do košů','Bílý pytel · 25 l','#F8FAFC',false,true,30),
  ('practical-bag-white-10','practical','Mini koše','Pytle do košů','Bílý pytel · 10 l','#F8FAFC',false,true,40),
  ('practical-cloth-blue','practical','Modrý hadr','Hadry','Okna a zrcadla','#2563EB',false,true,50),
  ('practical-cloth-yellow','practical','Žlutý hadr','Hadry','Záchody / WC','#FACC15',false,true,60),
  ('arrival-open-windows','arrival','Otevřít okna podle počasí','Po příchodu','Před začátkem úklidu zvažte větrání podle počasí a provozu školy.',null,false,true,10)
on conflict (entry_key) do nothing;

-- Okna schodiště jsou nově součástí stejné páteční týdenní návštěvy.
update public.cleaning_tasks
set frequency = 'weekly', schedule_days = '{5}'::smallint[],
    monthly_day = null, period_months = null, period_week = null,
    period_anchor_month = null, active = true
where plan_key = 'v2026|Schodiště|Schodiště|windows';

do $$
begin
  if not exists (select 1 from public.manual_entries where entry_type = 'guide' and active) then
    raise exception 'Nevznikly aktivní návody Manuálu.';
  end if;
  if not exists (select 1 from public.manual_entries where entry_key = 'arrival-open-windows' and active) then
    raise exception 'Nevznikla připomínka po příchodu.';
  end if;
  if not exists (
    select 1 from public.cleaning_tasks
    where plan_key = 'v2026|Schodiště|Schodiště|windows'
      and active and frequency = 'weekly' and schedule_days = '{5}'::smallint[]
      and period_months is null and period_week is null
  ) then
    raise exception 'Okna schodiště nejsou nastavena na týdenní návštěvu.';
  end if;
end $$;

commit;
