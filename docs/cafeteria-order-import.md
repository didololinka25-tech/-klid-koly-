# Jednorázový import objednávek Jídelny

Importer čte pouze listy `JÍDELNÍČEK 26/27` a `ZÁŘÍ_2026`. Protože formát XLSX nepovoluje `/` v názvu listu, přijme také jednoznačnou exportní variantu `JÍDELNÍČEK 26_27`. Soubor XLSX s osobními údaji nepatří do repozitáře.

Nejdřív aplikujte samostatnou migraci `20260906165639_cafeteria_order_quantity_support.sql`. Potom nastavte přímé databázové URL jen v prostředí aktuálního terminálu; importer je nikdy nevypisuje.

```powershell
$env:SUPABASE_DB_URL = '<database connection string>'
pnpm import:cafeteria-orders -- --file 'C:\bezpecna\cesta\obed.xlsx' --dry-run
```

Bez `--apply` je běh vždy read-only a končí rollbackem. Report je nutné ručně zkontrolovat, zejména `UNMATCHED_DINER`, `AMBIGUOUS_VARIANT`, `INVALID_QUANTITY`, `MEAL_DAY_NOT_FOUND` a `PRICE_RULE_NOT_FOUND`.

Parser před plánováním konzervativně vynechává pouze známé nepersonální řádky: číselný prefix následovaný `Kč`, popisek ceny s `Kč`, návštěvní souhrny a řádky začínající `souhrn` nebo `celkem`. Ostatní nerozpoznané popisky se neignorují a zůstávají viditelné jako `UNMATCHED_DINER`.

U více variant určí přesná barva objednávkové buňky variantu v jídelníčku pouze v rámci konkrétního dne. Pokud mají menu varianty jednoznačné různé barvy, jejich počet odpovídá počtu aktivních DB variant a DB `sort_order` je jednoznačný, přeloží se pořadí menu na vzestupné `sort_order` v databázi. Texty nemusí být totožné. Stejná či chybějící barva, rozdílný počet variant nebo duplicitní `sort_order` skončí bezpečně jako `AMBIGUOUS_VARIANT`; žádná globální barevná mapa se nepoužívá.

Až po vyřešení nejasností lze spustit explicitní zápis:

```powershell
pnpm import:cafeteria-orders -- --file 'C:\bezpecna\cesta\obed.xlsx' --apply
```

Všechny řádky označené `CREATE` se vloží v jedné transakci. Existující kombinace strávník/jídelní den se hlásí jako `SKIP_ALREADY_EXISTS`, takže opakovaný běh nevytváří duplicity. Audit objednávek vytváří stávající databázový trigger a zachovává `actor_source = system`.

Pokud při APPLY již proběhla uzávěrka daného jídelního dne, importer posune právě vytvořený auditní event na jednu sekundu před `cutoff_at`. Jde o syntetický legacy cutoff snapshot, díky kterému se stará objednávka správně započítá do stavu při uzávěrce; tento čas nepředstavuje skutečný historický okamžik, kdy člověk objednávku v původní tabulce zadal. U dní před uzávěrkou zůstává triggerem zapsaný čas beze změny.
