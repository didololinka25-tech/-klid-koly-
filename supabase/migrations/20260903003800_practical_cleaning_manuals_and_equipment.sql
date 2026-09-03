begin;

-- Potvrzené školní postupy doplňují existující databázový Manuál.
-- Záznamy se nemažou; známé entry_key lze dál upravovat v administraci.
insert into public.manual_entries
  (entry_key, entry_type, title, category, body, supplies, steps, warnings, school_note,
   activity_types, featured, active, sort_order)
values
  ('guide-cleaners-preparation', 'guide', 'Jak připravit čisticí prostředky', 'Pomůcky', null,
   E'Koncentráty Missiva\nOznačené pracovní lahve',
   E'Lili → 1 : 10\nMedium → 1 : 10\nJasněnka → 1 : 10\nMýval → 1 : 10 běžně / 1 : 5 silná špína\nBalzamína → 20 ml / 1 l vlažné vody\nPři úklidu používej už připravené naředěné lahve.',
   E'Nemíchej různé prostředky.\nKoncentrát Lili nelij přímo do kýblu.',
   'Do kýblu se dává už naředěná Lili z pracovní lahve. Přesnou dávku do našeho kýblu zatím neuvádíme.',
   '{}', true, true, 5),

  ('guide-toilet', 'guide', 'WC', 'Hygiena', null,
   E'Medium 1 : 10\nŽlutý hadr\nJasněnka 1 : 10\nModrý hadr na zrcadlo\nMop',
   E'1. Medium – WC mísa a prkénko.\n2. Medium – splachovadlo.\n3. Medium – umyvadlo a baterie.\n4. Vše setři žlutým hadrem.\n5. Zrcadlo – Jasněnka + modrý hadr.\n6. Vynes koš.\n7. Doplň mýdlo / papír podle potřeby.\n8. Podlahu vysaj nebo zameť.\n9. Nakonec vytři.',
   E'Žlutý hadr je pouze na WC.\nBěžně používej Medium 1 : 10. Koncentrát použij pouze na silné usazeniny při hloubkovém úklidu.',
   null, '{toilet}', true, true, 10),

  ('guide-sink', 'guide', 'Umyvadla, dřezy a baterie', 'Hygiena', null,
   E'Medium 1 : 10\nČistý běžný hadr',
   E'1. Nastříkej Medium.\n2. Otři umyvadlo nebo dřez.\n3. Otři baterii.\n4. Setři zbytky prostředku.',
   'Na kuchyňský nebo jídelní dřez nepoužívej žlutý WC hadr.',
   null, '{sink}', false, true, 20),

  ('guide-drain', 'guide', 'Výlevka', 'Hygiena', null,
   E'Medium 1 : 10\nRukavice\nUrčený hadr',
   E'1. Odstraň hrubé nečistoty.\n2. Umyj vnitřek a okraj.\n3. Očisti baterii.\n4. Opláchni nebo setři zbytky prostředku.',
   'Určený hadr nepoužívej na jiné povrchy.',
   null, '{sink}', false, true, 30),

  ('guide-mirror', 'guide', 'Zrcadla', 'Skla', null,
   E'Jasněnka 1 : 10\nModrý hadr',
   E'1. Nastříkej Jasněnku.\n2. Setři modrým hadrem.\n3. Dolešti do sucha.',
   'Nestříkej přímo na elektrické prvky.',
   'Modrý hadr je určený pro okna a zrcadla.', '{mirror}', false, true, 40),

  ('guide-windows', 'guide', 'Okna a skla', 'Skla', null,
   E'Jasněnka 1 : 10\nModrý hadr\nStěrka podle potřeby',
   E'1. Umyj rám.\n2. Umyj sklo.\n3. Stáhni vodu stěrkou.\n4. Dolešti modrým hadrem.',
   'Na výškově obtížná místa používej pouze bezpečné vybavení školy.',
   null, '{windows}', true, true, 50),

  ('guide-doors', 'guide', 'Dveře', 'Povrchy', null,
   E'Čistý běžný hadr\nPlast / lamino / omyvatelný povrch → Lili 1 : 10\nDřevo → Balzamína\nSklo → Jasněnka 1 : 10 + modrý hadr',
   E'1. Urči materiál.\n2. Použij prostředek určený pro tento materiál.\n3. Otři plochu dveří a hrany.\n4. Sklo dolešti modrým hadrem.',
   E'Nepoužívej žlutý WC hadr.\nNezamáčej zámky ani elektrické prvky.',
   null, '{doors}', false, true, 60),

  ('guide-floors', 'guide', 'Podlahy', 'Podlahy', null,
   E'Svůj mop Vileda\nKýbl\nPracovní láhev Lili 1 : 10',
   E'1. Podlahu vysaj nebo zameť.\n2. Napusť vodu do kýblu.\n3. Přidej už naředěnou Lili z pracovní lahve.\n4. Vytři směrem k východu.\n5. Po práci odlož použitou mopovou hlavici na určené místo.',
   E'Koncentrát Lili nelij rovnou do kýblu.\nPřesnou dávku naředěné Lili do kýblu zatím neuvádíme.',
   'Máme 2 kulaté a 1 hranatý mop Vileda. Každá uklízečka používá při směně svůj. Máme i náhradní mopy.',
   '{vacuum,mop}', true, true, 70),

  ('guide-stairs', 'guide', 'Schodiště', 'Podlahy', null,
   E'Batohový vysavač určený na schody\nPři vytírání: svůj mop + pracovní Lili 1 : 10',
   E'1. Začni nahoře.\n2. Vysávej směrem dolů.\n3. Vysaj i kraje.\n4. Pokud je podle plánu vytírání, po vysátí vytři.\n5. Postupuj tak, abys nemusela chodit přes mokré schody.',
   'Na schody máme zvláštní batohový vysavač.',
   null, '{vacuum,mop,surfaces,windows}', true, true, 80),

  ('guide-carpet', 'guide', 'Koberce – běžný úklid', 'Koberce', null,
   'Běžný vysavač',
   E'1. Odstraň věci z cesty.\n2. Pomalu vysaj celý koberec.\n3. Vysaj rohy.\n4. Vysaj kraje.',
   'Na fleky nelij náhodnou chemii.',
   null, '{vacuum}', false, true, 90),

  ('guide-deep-clean', 'guide', 'Koberce – Mýval', 'Koberce', null,
   E'Mýval\nŘedění 1 : 10 běžně\nŘedění 1 : 5 při větším znečištění',
   E'1. Vytvoř pěnu.\n2. Pěnu nanes.\n3. Lehce ji zapracuj.\n4. Nech koberec zaschnout.\n5. Důkladně vysaj nebo vykartáčuj.',
   E'Po mokrém čištění po koberci nechoď, dokud neuschne.\nMýval není potvrzený pro nalití do Nilfisk SC100.',
   'Mýval je vhodný pro koberce a pěnové šamponovače. SC100 vyžaduje nízkopěnivý prostředek určený pro automatické mycí stroje.',
   '{deep_clean}', true, true, 100),

  ('guide-wood', 'guide', 'Dřevěný nábytek', 'Povrchy', null,
   E'Balzamína – mýdlový čistič\nČistý hadr\n20 ml / 1 l vlažné vody',
   E'1. Nařeď Balzamínu: 20 ml do 1 l vlažné vody.\n2. Otři dřevo.\n3. Setři čistou vodou.\n4. Nech zaschnout.',
   'Nejdřív vyzkoušej na malém skrytém místě.',
   'Používáme Balzamínu – mýdlový čistič, ne Balzamínu balzám na nábytek.',
   '{surfaces}', false, true, 110),

  ('guide-tables', 'guide', 'Stoly, lavičky a parapety', 'Povrchy', null,
   E'Čistý běžný hadr\nPlast / lamino / omyvatelný povrch → Lili 1 : 10\nDřevo → Balzamína\nSklo → Jasněnka 1 : 10 + modrý hadr',
   E'1. Odstraň volné věci.\n2. Urči materiál povrchu.\n3. Použij správný prostředek.\n4. Otři celou plochu.\n5. Vrať původní vybavení.',
   E'Nepoužívej žlutý WC hadr.\nSe soukromými věcmi manipuluj jen nezbytně.',
   null, '{tables}', false, true, 120),

  ('guide-storage', 'guide', 'Skříňky a police', 'Povrchy', null,
   E'Čistý běžný hadr\nPlast / lamino / omyvatelný povrch → Lili 1 : 10\nDřevo → Balzamína\nSklo → Jasněnka 1 : 10 + modrý hadr',
   E'1. Urči materiál povrchu.\n2. Použij správný prostředek.\n3. Otři dostupné vnější plochy a police.\n4. Povrch nech uschnout.',
   E'Nepoužívej žlutý WC hadr.\nNeotvírej uzamčené ani soukromé skříňky.',
   null, '{surfaces}', false, true, 130),

  ('guide-upholstery', 'guide', 'Gauče a čalounění', 'Koberce', null,
   E'Běžně: vysavač + nástavec\nHloubkově: Mýval 1 : 10 až 1 : 5',
   E'1. Běžný úklid: čalounění vysaj nástavcem.\n2. Hloubkový úklid: vytvoř pěnu z Mývalu.\n3. Pěnu lehce zapracuj.\n4. Nech čalounění vyschnout.\n5. Po zaschnutí vysaj.',
   'Po mokrém čištění čalounění nepoužívej, dokud neuschne.',
   null, '{surfaces}', false, true, 140),

  ('guide-trash', 'guide', 'Koše', 'Odpady', null,
   E'Tříděný odpad → modrý pytel 60 l\nPlasty → žlutý pytel 35 l\nBěžné koše → bílý pytel 25 l\nMini koše → bílý pytel 10 l',
   E'1. Pytel zaváž.\n2. Vyjmi ho z koše.\n3. Vlož nový správný pytel.\n4. Odpad odnes.',
   'Ostré nebo neznámé předměty neber holou rukou.',
   null, '{trash}', true, true, 150),

  ('guide-tools', 'guide', 'Mopy Vileda', 'Pomůcky', null,
   E'2 kulaté mopy\n1 hranatý mop\nNáhradní mopy / hlavice',
   E'1. Každá uklízečka si vezme při směně svůj mop.\n2. Po práci odlož použitou nebo mokrou hlavici na určené místo.\n3. Když hlavní mop není připravený, použij náhradní.',
   'Náhradní mop použij také při praní nebo poškození hlavního mopu.',
   null, '{}', false, true, 160),

  ('guide-laundry', 'guide', 'Hadry a mopy po úklidu', 'Pomůcky', null,
   E'Místo na použité hadry\nUrčené místo na mokré mopové hlavice',
   E'1. Posbírej použité hadry.\n2. Dej je k vyprání.\n3. Použitou mokrou mopovou hlavici dej na určené místo.\n4. Žluté WC hadry drž odděleně.',
   'Žluté WC hadry nemíchej s hadry na ostatní povrchy.',
   null, '{laundry}', false, true, 170),

  ('guide-machine', 'guide', 'Nilfisk SC100 – tvrdé podlahy', 'Technika', null,
   E'Nilfisk SC100\nČistá voda\nModrý strojový saponát na podlahy',
   E'1. Naplň nádrž čistou vodou.\n2. Přidej modrý strojový saponát podle etikety.\n3. Víčko nádrže slouží jako odměrka.\n4. Zapoj stroj.\n5. Sklop ho do pracovní polohy.\n6. Nastav 1 kapku pro běžnou špínu.\n7. Nastav 2 kapky pro silnější špínu.\n8. Pomalu projeď podlahu.\n9. Po práci stroj vypni a vytáhni ze zásuvky.\n10. Vylij špinavou vodu.\n11. Vylij zbytek roztoku.\n12. Vypláchni obě nádrže.\n13. Očisti kartáč a sací lišty.',
   E'Nenechávej běžící kartáč stát na jednom místě.\nDo stroje na tvrdé podlahy používáme modrý strojový saponát, ne Lili.\nPřesný počet odměrek zatím neuvádíme.',
   'SC100 má 3 l nádrž. Jedno plné víčko = 30 ml = 1 % při plné nádrži.',
   '{}', true, true, 180),

  ('guide-machine-carpet', 'guide', 'Nilfisk SC100 – koberce', 'Technika', null,
   E'Nilfisk SC100\nCarpet Complete Kit\nBěžný vysavač',
   E'1. Koberec nejdřív důkladně vysaj nasucho.\n2. SC100 vypni a vytáhni ze zásuvky.\n3. Nasaď kobercový kartáč.\n4. Nasaď kobercové sací lišty.\n5. Naplň vodu.\n6. Použij pouze prostředek potvrzený pro SC100 + carpet kit.\n7. Pomalu projeď koberec.\n8. Po práci vylij a vypláchni nádrže.\n9. Očisti kobercový kartáč a sací lišty.',
   E'Modrý prostředek je na tvrdé podlahy.\nMýval je na koberce, ale jeho nalití přímo do SC100 zatím není potvrzené. Nevymýšlej jeho dávkování do SC100.',
   'Carpet Complete Kit pro SC100 ve škole máme.',
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
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-machine' and active and featured
      and warnings ilike '%ne Lili%'
  ) then
    raise exception 'Návod SC100 pro tvrdé podlahy nemá potvrzené bezpečnostní upozornění.';
  end if;
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-machine-carpet' and active
      and warnings ilike '%není potvrzené%'
  ) then
    raise exception 'Návod SC100 pro koberce nesmí tvrdit nepotvrzené dávkování.';
  end if;
  if not exists (
    select 1 from public.manual_entries
    where entry_key = 'guide-cleaners-preparation'
      and school_note ilike '%zatím neuvádíme%'
  ) then
    raise exception 'Příprava prostředků nesmí vymýšlet dávku Lili do kýblu.';
  end if;
end $$;

commit;
