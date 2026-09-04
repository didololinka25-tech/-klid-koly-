begin;

-- Praktické postupy doplňují existující databázový Manuál.
-- Konkrétní dávkování a technologické parametry zde nejsou uvedené bez ověření školou.
-- Záznamy se nemažou; známé entry_key lze dál upravovat v administraci.
insert into public.manual_entries
  (entry_key, entry_type, title, category, body, supplies, steps, warnings, school_note,
   activity_types, featured, active, sort_order)
values
  ('guide-cleaners-preparation', 'guide', 'Jak připravit čisticí prostředky', 'Pomůcky', null,
   E'Čisticí prostředky používané ve škole\nOznačené pracovní lahve',
   E'1. Přečti si etiketu a ověřený školní návod.\n2. Prostředek připrav jen podle těchto pokynů.\n3. Pracovní láhev zřetelně označ.\n4. Při úklidu používej připravenou pracovní láhev.',
   E'Nemíchej různé prostředky.\nNepřelévej prostředek do neoznačené lahve.\nDávkování neodhaduj.',
   'Konkrétní ředění a dávkování doplní správce až po ověření etikety a školního postupu.',
   '{}', true, true, 5),

  ('guide-toilet', 'guide', 'WC', 'Hygiena', null,
   E'Připravená pracovní láhev Medium\nŽlutý hadr\nPřipravená pracovní láhev Jasněnky\nModrý hadr na zrcadlo\nMop',
   E'1. Očisti WC mísu a prkénko.\n2. Očisti splachovadlo.\n3. Očisti umyvadlo a baterii.\n4. WC povrchy setři žlutým hadrem.\n5. Zrcadlo očisti modrým hadrem.\n6. Vynes koš.\n7. Doplň mýdlo a papír podle potřeby.\n8. Podlahu vysaj nebo zameť.\n9. Nakonec vytři.',
   E'Žlutý hadr používej pouze na WC.\nProstředky používej podle etikety nebo ověřeného školního návodu.',
   null, '{toilet}', true, true, 10),

  ('guide-sink', 'guide', 'Umyvadla, dřezy a baterie', 'Hygiena', null,
   E'Připravená pracovní láhev Medium\nČistý běžný hadr',
   E'1. Použij prostředek podle etikety nebo školního návodu.\n2. Otři umyvadlo nebo dřez.\n3. Otři baterii.\n4. Setři zbytky prostředku.',
   'Na kuchyňský nebo jídelní dřez nepoužívej žlutý WC hadr.',
   null, '{sink}', false, true, 20),

  ('guide-drain', 'guide', 'Výlevka', 'Hygiena', null,
   E'Připravená pracovní láhev Medium\nRukavice\nUrčený hadr',
   E'1. Odstraň hrubé nečistoty.\n2. Umyj vnitřek a okraj.\n3. Očisti baterii.\n4. Opláchni nebo setři zbytky prostředku.',
   E'Určený hadr nepoužívej na jiné povrchy.\nProstředek používej podle etikety nebo školního návodu.',
   null, '{sink}', false, true, 30),

  ('guide-mirror', 'guide', 'Zrcadla', 'Skla', null,
   E'Připravená pracovní láhev Jasněnky\nModrý hadr',
   E'1. Použij Jasněnku podle etikety nebo školního návodu.\n2. Setři zrcadlo modrým hadrem.\n3. Dolešti do sucha.',
   'Nestříkej přímo na elektrické prvky.',
   'Modrý hadr je určený pro okna a zrcadla.', '{mirror}', false, true, 40),

  ('guide-windows', 'guide', 'Okna a skla', 'Skla', null,
   E'Připravená pracovní láhev Jasněnky\nModrý hadr\nStěrka podle potřeby',
   E'1. Použij prostředek podle etikety nebo školního návodu.\n2. Umyj rám.\n3. Umyj sklo.\n4. Stáhni vodu stěrkou.\n5. Dolešti modrým hadrem.',
   'Na výškově obtížná místa používej pouze bezpečné vybavení školy.',
   null, '{windows}', true, true, 50),

  ('guide-doors', 'guide', 'Dveře', 'Povrchy', null,
   E'Čistý běžný hadr\nProstředek určený pro daný materiál\nNa sklo modrý hadr',
   E'1. Urči materiál dveří.\n2. Použij prostředek určený pro tento materiál podle etikety.\n3. Otři plochu dveří a hrany.\n4. Sklo dolešti modrým hadrem.',
   E'Nepoužívej žlutý WC hadr.\nNezamáčej zámky ani elektrické prvky.',
   'Prostředky Lili, Balzamína a Jasněnka používej jen podle etikety nebo ověřeného školního návodu.',
   '{doors}', false, true, 60),

  ('guide-floors', 'guide', 'Podlahy', 'Podlahy', null,
   E'Čistý školní mop\nKýbl\nPřipravený prostředek určený pro danou podlahu',
   E'1. Podlahu vysaj nebo zameť.\n2. Připrav vodu a prostředek podle etikety nebo školního návodu.\n3. Vytři směrem k východu.\n4. Po práci odlož použitou mopovou hlavici na určené místo.',
   E'Nepoužívej neověřené dávkování.\nPo mokré podlaze nechoď, dokud neuschne.',
   'Pokud se používá Lili, vezmi připravenou pracovní láhev a řiď se ověřeným školním návodem.',
   '{vacuum,mop}', true, true, 70),

  ('guide-stairs', 'guide', 'Schodiště', 'Podlahy', null,
   E'Vysavač určený na schody\nPři vytírání: čistý školní mop a prostředek určený pro podlahu',
   E'1. Začni nahoře.\n2. Vysávej směrem dolů.\n3. Vysaj i kraje.\n4. Pokud je podle plánu vytírání, po vysátí vytři.\n5. Postupuj tak, abys nemusela chodit přes mokré schody.',
   E'Používej pouze vybavení určené školou.\nProstředek dávkuj podle etikety nebo školního návodu.',
   null, '{vacuum,mop,surfaces,windows}', true, true, 80),

  ('guide-carpet', 'guide', 'Koberce – běžný úklid', 'Koberce', null,
   'Běžný vysavač',
   E'1. Odstraň věci z cesty.\n2. Pomalu vysaj celý koberec.\n3. Vysaj rohy.\n4. Vysaj kraje.',
   'Na skvrny nepoužívej náhodný nebo neověřený prostředek.',
   null, '{vacuum}', false, true, 90),

  ('guide-deep-clean', 'guide', 'Koberce – hloubkové čištění', 'Koberce', null,
   E'Prostředek určený pro koberec\nPomůcky určené ověřeným školním postupem',
   E'1. Ověř etiketu prostředku a školní postup.\n2. Nejprve vyzkoušej postup na malém skrytém místě.\n3. Čisti rovnoměrně podle ověřeného postupu.\n4. Nech koberec úplně vyschnout.\n5. Dokonči postup podle pokynů použitého prostředku a vybavení.',
   E'Po mokrém čištění po koberci nechoď, dokud neuschne.\nMýval nelij do Nilfisk SC100 bez výslovného potvrzení výrobce a školy.',
   'Pokud se používá Mýval, dávkování a postup se řídí etiketou a ověřeným školním návodem.',
   '{deep_clean}', true, true, 100),

  ('guide-wood', 'guide', 'Dřevěný nábytek', 'Povrchy', null,
   E'Prostředek určený pro dřevo\nČistý hadr',
   E'1. Ověř pokyny na etiketě.\n2. Prostředek nejdřív vyzkoušej na malém skrytém místě.\n3. Otři dřevo podle pokynů výrobce.\n4. Nech povrch zaschnout.',
   'Nepoužívej neověřené dávkování ani prostředek určený pro jiný materiál.',
   'Balzamínu používej pouze podle etikety a ověřeného školního postupu.',
   '{surfaces}', false, true, 110),

  ('guide-tables', 'guide', 'Stoly, lavičky a parapety', 'Povrchy', null,
   E'Čistý běžný hadr\nProstředek určený pro daný materiál',
   E'1. Odstraň volné věci.\n2. Urči materiál povrchu.\n3. Použij prostředek podle etikety nebo školního návodu.\n4. Otři celou plochu.\n5. Vrať původní vybavení.',
   E'Nepoužívej žlutý WC hadr.\nSe soukromými věcmi manipuluj jen nezbytně.',
   'Lili, Balzamínu nebo Jasněnku použij pouze tehdy, pokud jsou podle etikety a školního návodu vhodné pro daný povrch.',
   '{tables}', false, true, 120),

  ('guide-storage', 'guide', 'Skříňky a police', 'Povrchy', null,
   E'Čistý běžný hadr\nProstředek určený pro daný materiál',
   E'1. Urči materiál povrchu.\n2. Použij prostředek podle etikety nebo školního návodu.\n3. Otři dostupné vnější plochy a police.\n4. Povrch nech uschnout.',
   E'Nepoužívej žlutý WC hadr.\nNeotvírej uzamčené ani soukromé skříňky.',
   'Lili, Balzamínu nebo Jasněnku použij pouze tehdy, pokud jsou podle etikety a školního návodu vhodné pro daný povrch.',
   '{surfaces}', false, true, 130),

  ('guide-upholstery', 'guide', 'Gauče a čalounění', 'Koberce', null,
   E'Běžný vysavač s vhodným nástavcem\nPro hloubkové čištění pouze ověřený prostředek a postup',
   E'1. Při běžném úklidu čalounění vysaj nástavcem.\n2. Před mokrým čištěním ověř etiketu a školní postup.\n3. Prostředek vyzkoušej na malém skrytém místě.\n4. Čisti rovnoměrně podle ověřeného postupu.\n5. Nech čalounění úplně vyschnout.',
   'Po mokrém čištění čalounění nepoužívej, dokud neuschne.',
   'Pokud se používá Mýval, dávkování a postup se řídí etiketou a ověřeným školním návodem.',
   '{surfaces}', false, true, 140),

  ('guide-trash', 'guide', 'Koše', 'Odpady', null,
   E'Tříděný odpad → modrý pytel 60 l\nPlasty → žlutý pytel 35 l\nBěžné koše → bílý pytel 25 l\nMini koše → bílý pytel 10 l',
   E'1. Pytel zaváž.\n2. Vyjmi ho z koše.\n3. Vlož nový správný pytel.\n4. Odpad odnes.',
   'Ostré nebo neznámé předměty neber holou rukou.',
   null, '{trash}', true, true, 150),

  ('guide-tools', 'guide', 'Mopy', 'Pomůcky', null,
   E'Čistý školní mop\nNáhradní hlavice, pokud je k dispozici',
   E'1. Před úklidem zkontroluj, že je mop čistý a nepoškozený.\n2. Použij mop určený školou.\n3. Po práci odlož použitou nebo mokrou hlavici na určené místo.\n4. Pokud hlavní mop není připravený, vezmi dostupnou náhradní hlavici.',
   'Poškozený nebo silně znečištěný mop nepoužívej.',
   null, '{}', false, true, 160),

  ('guide-laundry', 'guide', 'Hadry a mopy po úklidu', 'Pomůcky', null,
   E'Místo na použité hadry\nUrčené místo na mokré mopové hlavice',
   E'1. Posbírej použité hadry.\n2. Dej je k vyprání.\n3. Použitou mokrou mopovou hlavici dej na určené místo.\n4. Žluté WC hadry drž odděleně.',
   'Žluté WC hadry nepoužívej na jiné povrchy.',
   null, '{laundry}', false, true, 170),

  ('guide-machine', 'guide', 'Nilfisk SC100 – tvrdé podlahy', 'Technika', null,
   E'Nilfisk SC100\nČistá voda\nPouze prostředek určený výrobcem pro tento stroj a povrch',
   E'1. Zkontroluj stroj a přívodní kabel.\n2. Přečti si návod stroje a etiketu prostředku.\n3. Naplň stroj a dávkuj pouze podle návodu výrobce.\n4. Stroj zapoj a nastav do pracovní polohy.\n5. Pomalu projeď podlahu.\n6. Po práci stroj vypni a vytáhni ze zásuvky.\n7. Vylij špinavou vodu a zbytek roztoku.\n8. Vypláchni nádrže.\n9. Očisti kartáč a sací lišty.',
   E'Nenechávej běžící kartáč stát na jednom místě.\nNepoužívej prostředek, který výrobce a škola pro stroj nepotvrdili.\nDávkování neodhaduj.',
   'Přesný prostředek a dávkování doplní správce až po ověření návodu výrobce a školního postupu.',
   '{}', true, true, 180),

  ('guide-machine-carpet', 'guide', 'Nilfisk SC100 – koberce', 'Technika', null,
   E'Nilfisk SC100\nPouze vybavení schválené výrobcem pro koberec\nBěžný vysavač',
   E'1. Koberec nejdřív důkladně vysaj nasucho.\n2. SC100 vypni a vytáhni ze zásuvky.\n3. Použij pouze kobercové vybavení schválené výrobcem.\n4. Vodu a prostředek připrav jen podle návodu výrobce.\n5. Pomalu projeď koberec.\n6. Po práci vylij a vypláchni nádrže.\n7. Očisti použité vybavení.',
   E'Do SC100 nelij Mýval bez výslovného potvrzení výrobce a školy.\nPoužij pouze prostředek určený výrobcem pro tento stroj a povrch.\nDávkování neodhaduj.',
   'Přesný prostředek, vybavení a dávkování doplní správce až po ověření návodu výrobce a školního postupu.',
   '{}', false, true, 190)
on conflict (entry_key) do update set
  entry_type = excluded.entry_type,
  title = excluded.title,
  category = excluded.category,
  body = excluded.body,
  supplies = excluded.supplies,
  steps = excluded.steps,
  warnings = excluded.warnings,
  school_note = excluded.school_note,
  activity_types = excluded.activity_types,
  featured = excluded.featured,
  active = excluded.active,
  sort_order = excluded.sort_order;

do $$
declare
  expected_keys text[] := array[
    'guide-cleaners-preparation', 'guide-toilet', 'guide-sink', 'guide-drain',
    'guide-mirror', 'guide-windows', 'guide-doors', 'guide-floors', 'guide-stairs',
    'guide-carpet', 'guide-deep-clean', 'guide-wood', 'guide-tables', 'guide-storage',
    'guide-upholstery', 'guide-trash', 'guide-tools', 'guide-laundry', 'guide-machine',
    'guide-machine-carpet'
  ];
begin
  if (select count(*) from public.manual_entries where entry_key = any(expected_keys)) <> cardinality(expected_keys) then
    raise exception 'Nebyly vytvořeny všechny praktické návody.';
  end if;
  if exists (
    select 1 from public.manual_entries
    where entry_key = any(expected_keys)
      and (entry_type <> 'guide' or not active or nullif(btrim(title), '') is null
        or nullif(btrim(supplies), '') is null or nullif(btrim(steps), '') is null)
  ) then
    raise exception 'Praktický návod je neaktivní nebo neúplný.';
  end if;
  if exists (
    select 1 from public.manual_entries
    where entry_key = any(expected_keys)
      and concat_ws(E'\n', body, supplies, steps, warnings, school_note) ~*
        '(^|[^0-9])(1[[:space:]]*:[[:space:]]*(5|10)|20[[:space:]]*ml|30[[:space:]]*ml|3[[:space:]]*l([^a-z]|$)|1[[:space:]]*%|[12][[:space:]]*kapk)'
  ) then
    raise exception 'Praktický návod obsahuje neověřené dávkování nebo parametr stroje.';
  end if;
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-machine' and active and featured
      and warnings ilike '%výrobce%'
      and school_note ilike '%ověření%'
  ) then
    raise exception 'Návod SC100 pro tvrdé podlahy nemá bezpečný obecný postup.';
  end if;
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-machine-carpet' and active
      and warnings ilike '%Mýval%'
      and warnings ilike '%potvrzení výrobce%'
  ) then
    raise exception 'Návod SC100 pro koberce nesmí doporučovat nepotvrzený prostředek.';
  end if;
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-cleaners-preparation'
      and school_note ilike '%ověření%'
  ) then
    raise exception 'Příprava prostředků musí odkázat na ověřené dávkování.';
  end if;
end $$;

commit;
