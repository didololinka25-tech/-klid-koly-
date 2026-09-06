# Jednorázový import objednávek Jídelny

Importer čte pouze listy `JÍDELNÍČEK 26/27` a `ZÁŘÍ_2026`. Protože formát XLSX nepovoluje `/` v názvu listu, přijme také jednoznačnou exportní variantu `JÍDELNÍČEK 26_27`. Soubor XLSX s osobními údaji nepatří do repozitáře.

Nejdřív aplikujte samostatnou migraci `20260906165639_cafeteria_order_quantity_support.sql`. Potom nastavte přímé databázové URL jen v prostředí aktuálního terminálu; importer je nikdy nevypisuje.

```powershell
$env:SUPABASE_DB_URL = '<database connection string>'
pnpm import:cafeteria-orders -- --file 'C:\bezpecna\cesta\obed.xlsx' --dry-run
```

Bez `--apply` je běh vždy read-only a končí rollbackem. Report je nutné ručně zkontrolovat, zejména `UNMATCHED_DINER`, `AMBIGUOUS_VARIANT`, `INVALID_QUANTITY`, `MEAL_DAY_NOT_FOUND` a `PRICE_RULE_NOT_FOUND`.

Až po vyřešení nejasností lze spustit explicitní zápis:

```powershell
pnpm import:cafeteria-orders -- --file 'C:\bezpecna\cesta\obed.xlsx' --apply
```

Všechny řádky označené `CREATE` se vloží v jedné transakci. Existující kombinace strávník/jídelní den se hlásí jako `SKIP_ALREADY_EXISTS`, takže opakovaný běh nevytváří duplicity. Audit objednávek vytváří stávající databázový trigger.
