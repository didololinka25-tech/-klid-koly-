begin;

-- Přesný model stroje není školou potvrzený. Aktivní manuál proto používá
-- pouze obecné označení Nilfisk a zachovává bezpečné pokyny z 03800.
update public.manual_entries
set
  title = 'Nilfisk – tvrdé podlahy',
  supplies = E'Nilfisk\nČistá voda\nPouze prostředek určený výrobcem pro tento stroj a povrch',
  steps = E'1. Zkontroluj stroj a přívodní kabel.\n2. Přečti si návod stroje a etiketu prostředku.\n3. Naplň stroj a dávkuj pouze podle návodu výrobce.\n4. Stroj zapoj a nastav do pracovní polohy.\n5. Pomalu projeď podlahu.\n6. Po práci stroj vypni a vytáhni ze zásuvky.\n7. Vylij špinavou vodu a zbytek roztoku.\n8. Vypláchni nádrže.\n9. Očisti kartáč a sací lišty.',
  warnings = E'Nenechávej běžící kartáč stát na jednom místě.\nNepoužívej prostředek, který výrobce a škola pro stroj nepotvrdili.\nDávkování neodhaduj.',
  school_note = 'Přesný prostředek a dávkování doplní správce až po ověření návodu výrobce a školního postupu.'
where entry_key = 'guide-machine';

update public.manual_entries
set
  title = 'Nilfisk – koberce',
  supplies = E'Nilfisk\nPouze vybavení schválené výrobcem pro koberec\nBěžný vysavač',
  steps = E'1. Koberec nejdřív důkladně vysaj nasucho.\n2. Nilfisk vypni a vytáhni ze zásuvky.\n3. Použij pouze kobercové vybavení schválené výrobcem.\n4. Vodu a prostředek připrav jen podle návodu výrobce.\n5. Pomalu projeď koberec.\n6. Po práci vylij a vypláchni nádrže.\n7. Očisti použité vybavení.',
  warnings = E'Do Nilfisku nelij Mýval bez výslovného potvrzení výrobce a školy.\nPoužij pouze prostředek určený výrobcem pro tento stroj a povrch.\nDávkování neodhaduj.',
  school_note = 'Přesný prostředek, vybavení a dávkování doplní správce až po ověření návodu výrobce a školního postupu.'
where entry_key = 'guide-machine-carpet';

-- Stejná oprava názvu modelu v souvisejícím návodu na hloubkové čištění.
update public.manual_entries
set warnings = E'Po mokrém čištění po koberci nechoď, dokud neuschne.\nDo Nilfisku nelij Mýval bez výslovného potvrzení výrobce a školy.'
where entry_key = 'guide-deep-clean';

-- Zachováváme úklid po směně, ale odstraňujeme nepotřebný čtvrtý pokyn.
update public.manual_entries
set
  steps = E'1. Posbírej použité hadry.\n2. Dej je k vyprání.\n3. Použitou mokrou mopovou hlavici dej na určené místo.',
  warnings = null
where entry_key = 'guide-laundry';

do $$
begin
  if exists (
    select 1
    from public.manual_entries
    where active
      and concat_ws(E'\n', title, body, supplies, steps, warnings, school_note) ilike '%SC100%'
  ) then
    raise exception 'Aktivní Manuál stále obsahuje nepotvrzený model SC100.';
  end if;

  if not exists (
    select 1
    from public.manual_entries
    where entry_key = 'guide-machine'
      and active
      and title = 'Nilfisk – tvrdé podlahy'
      and supplies like E'Nilfisk\n%'
  ) then
    raise exception 'Návod Nilfisk pro tvrdé podlahy nebyl opraven.';
  end if;

  if not exists (
    select 1
    from public.manual_entries
    where entry_key = 'guide-machine-carpet'
      and active
      and title = 'Nilfisk – koberce'
      and supplies like E'Nilfisk\n%'
      and warnings ilike '%Do Nilfisku nelij Mýval%'
  ) then
    raise exception 'Návod Nilfisk pro koberce nebyl opraven.';
  end if;

  if exists (
    select 1
    from public.manual_entries
    where entry_key = 'guide-laundry'
      and concat_ws(E'\n', steps, warnings) ilike '%žlut%hadr%'
      and concat_ws(E'\n', steps, warnings) ilike '%odděl%'
  ) then
    raise exception 'Návod po úklidu stále vyžaduje oddělování žlutých hadrů.';
  end if;

  if not exists (
    select 1
    from public.manual_entries
    where entry_key = 'guide-toilet'
      and active
      and concat_ws(E'\n', body, supplies, steps, warnings, school_note)
        ilike '%Žlutý hadr používej pouze na WC%'
  ) then
    raise exception 'Potvrzené pravidlo pro žlutý WC hadr se ztratilo.';
  end if;
end $$;

commit;
