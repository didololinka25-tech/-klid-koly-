# Plán úklidu školy

Tento plán je seed pro lokální migraci `202608270002_cleaning_schedule.sql`. Nic z něj nebylo spuštěno v Supabase. Dny jsou ISO: pondělí 1, středa 3, pátek 5.

## Rozdělení práce

Pravidelný úklid není trvale přiřazen Daně ani Martině. Je rozdělen na dvě pracovní části:

- Část A: přízemí až 2. patro včetně chodeb a toalet.
- Část B: 3. a 4. patro včetně chodeb a toalet, plus třídy.

Tabulka `work_part_assignments` eviduje aktuálního držitele části. Funkce `swap_cleaning_work_parts()` bezpečně prohodí aktuální držitele A a B a uloží historii změny. Tuto operaci má podle RLS provádět David jako správce; pozdější mobilní ovládání pouze zavolá tuto funkci.

David je mimo části A/B. Má pouze úkol projít školu a odstranit věci z cesty. Samotné povýšení Davidova Auth účtu na roli `caretaker` zůstává ručním bezpečnostním krokem.

## Pravidla plánování

- Každý úklidový den: pondělí, středa a pátek.
- Schody: pondělí a pátek; Dana a Martina se střídají po týdnech.
- Stoly ve třídách: středa; Dana a Martina se střídají po týdnech.
- Okna: měsíčně, výchozí den 1. v měsíci; úkol náleží pracovní části a při prohození přechází s ní.
- Praní utěrek a hadrů: týdenní evidence, výchozí pátek. Je v `laundry_schedules` a `laundry_records`, nikdy v `cleaning_tasks` ani `cleaning_completions`.
- Vytřít lze dokončit až po zametení/vysátí stejné místnosti. Pravidlo je uložené jako závislost v `requires_task_id`.

## Kompletní seznam pravidelných úkolů

| Část | Oblast | Úkoly | Kdy |
|---|---|---|---|
| David | Celá škola | Projít školu a odstranit věci z cesty | Po, St, Pá |
| A/B | Chodby všech pater | Zamést/vysát chodbu; vytřít chodbu; dezinfikovat kliky a vypínače | Po, St, Pá |
| A/B | Toalety všech pater | WC a splachovadla; umyvadla, baterie a zrcadla; dezinfikovat kliky, vypínače, baterie a splachovadla; zamést/vysát podlahu; vytřít podlahu | Po, St, Pá |
| Střídání | Schodiště | Zamést/vysát schody; vytřít schody | Po, Pá |
| B | Třídy | Vynést koše | Po, St, Pá |
| Střídání | Třídy | Otřít stoly | St |
| A/B | Okna své části | Mytí oken | Měsíčně |
| Evidence | Praní | Praní utěrek a hadrů | Týdně, výchozí Pá |
