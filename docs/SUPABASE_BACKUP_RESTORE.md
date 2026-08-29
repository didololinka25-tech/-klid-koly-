# Zálohování a obnova produkční Supabase databáze

## Co je připravené

Workflow `Encrypted Supabase backup` se spouští každý den v 03:17 UTC a lze jej spustit také ručně. Vytvoří tři logické dumpy podle doporučeného postupu Supabase (`roles.sql`, `schema.sql`, `data.sql`), ověří důležité tabulky, zabalí je a zašifruje pomocí AES-256. Do GitHub Artifactu se nahraje pouze zašifrovaný soubor a jeho SHA-256 kontrolní součet. Retence každého běhu je 30 dní.

GitHub v neaktivním veřejném repozitáři po 60 dnech bez aktivity plánované workflow automaticky vypíná. Proto je nutné alespoň měsíčně kontrolovat zelené běhy; případně workflow v **Actions → Encrypted Supabase backup → Enable workflow** znovu zapnout.

Repozitář je veřejný. Artifacty veřejného repozitáře proto nepovažujeme za soukromé úložiště; databázový obsah chrání samostatná silná šifrovací fráze. Nešifrované SQL existuje pouze dočasně na jednorázovém GitHub runneru a po vytvoření šifrovaného archivu se odstraní.

## Co záloha obsahuje

- role, databázové schéma a data dostupná databázovému uživateli `postgres`,
- aplikační tabulky včetně profilů, docházky, dokončení úklidů, plánu, místností, budov, výjimečných úklidových dnů a Provozu,
- databázová data Supabase Auth, včetně `auth.users`, která oficiální datový dump zahrnuje,
- metadata Supabase Storage uložená v databázi.

Záloha **neobsahuje samotné soubory uložené přes Storage API**; v databázi jsou pouze jejich metadata. Neobsahuje také nastavení Google OAuth poskytovatele, hodnoty GitHub/Vercel/Supabase secrets, Edge Functions ani jejich secrets. Pokud se později začne používat nahrávání fotografií, je potřeba zavést samostatnou zálohu Storage objektů.

## Potřebné GitHub Actions Secrets

### `SUPABASE_DB_URL`

1. Otevřete produkční projekt v Supabase Dashboardu.
2. Klikněte nahoře na **Connect**.
3. Vyberte **Session pooler** (port 5432); funguje z IPv4 sítě GitHub runneru.
4. Zkopírujte celý connection string.
5. Zástupný text `[YOUR-PASSWORD]` nahraďte skutečným databázovým heslem. Pokud jej neznáte, lze jej vědomě změnit v **Project Settings → Database**; změna může ovlivnit jiné databázové klienty.

Nepoužívejte Supabase URL, anon key ani service-role key. Workflow potřebuje PostgreSQL connection string.

### `BACKUP_ENCRYPTION_PASSPHRASE`

Vygenerujte v důvěryhodném správci hesel náhodnou frázi alespoň 32 znaků. Musí být jiná než databázové heslo. Uložte ji také mimo GitHub do správce hesel — při její ztrátě nelze zálohy obnovit.

## Kam vložit secrets v GitHubu

1. Otevřete repozitář `didololinka25-tech/-klid-koly-`.
2. Klikněte **Settings**.
3. Vlevo otevřete **Secrets and variables → Actions**.
4. Klikněte **New repository secret**.
5. Vytvořte `SUPABASE_DB_URL` a vložte connection string.
6. Stejně vytvořte `BACKUP_ENCRYPTION_PASSPHRASE` a vložte šifrovací frázi.

Workflow nebude bez obou secrets úspěšný. Jejich hodnoty se nesmí zapisovat do workflow, Issues ani logů.

## První ruční test

1. V repozitáři otevřete záložku **Actions**.
2. Vlevo vyberte **Encrypted Supabase backup**.
3. Klikněte **Run workflow**, ponechte větev `main` a potvrďte **Run workflow**.
4. Otevřete vzniklý běh a počkejte, až bude zelený.
5. Dole v části **Artifacts** musí být položka `klid-koly-supabase-...`.
6. Stáhněte ji a ověřte, že ZIP obsahuje `.tar.gz.enc`, `.sha256` a `README.txt`. Nikdy neobsahuje nešifrované `.sql` soubory.

## Stažení a ověření historické zálohy

V GitHubu otevřete **Actions → Encrypted Supabase backup**, vyberte konkrétní datum a stáhněte artifact. Po rozbalení ZIPu spusťte v Linuxu, macOS nebo Git Bash:

```bash
sha256sum -c klid-koly-supabase-YYYY-MM-DDTHH-MM-SSZ.sha256
test -s klid-koly-supabase-YYYY-MM-DDTHH-MM-SSZ.tar.gz.enc
```

Výsledek kontrolního součtu musí být `OK` a soubor nesmí být prázdný.

## Dešifrování a kontrola obsahu

Následující krok provádějte pouze na důvěryhodném počítači. Příkaz si frázi bezpečně vyžádá; nevkládejte ji přímo do příkazové řádky ani historie shellu.

```bash
read -s BACKUP_ENCRYPTION_PASSPHRASE
export BACKUP_ENCRYPTION_PASSPHRASE
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  -in klid-koly-supabase-YYYY-MM-DDTHH-MM-SSZ.tar.gz.enc \
  -out klid-koly-supabase.tar.gz
mkdir restored-backup
tar -xzf klid-koly-supabase.tar.gz -C restored-backup
test -s restored-backup/roles.sql
test -s restored-backup/schema.sql
test -s restored-backup/data.sql
unset BACKUP_ENCRYPTION_PASSPHRASE
```

## Obnova — pouze po vědomém rozhodnutí

> **VAROVÁNÍ: RESTORE NIKDY NESPOUŠTĚJTE PROTI PRODUKČNÍ DATABÁZI BEZ VÝSLOVNÉHO ROZHODNUTÍ, OVĚŘENÉ ZÁLOHY A PLÁNU ODSTÁVKY.**

Nejprve vytvořte oddělený testovací Supabase projekt a použijte jeho connection string jako `NEW_DB_URL`. Potom postupujte podle aktuální oficiální dokumentace Supabase. Základní pořadí je:

```bash
read -s NEW_DB_URL
export NEW_DB_URL
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file restored-backup/roles.sql \
  --file restored-backup/schema.sql \
  --command 'SET session_replication_role = replica' \
  --file restored-backup/data.sql \
  --dbname "$NEW_DB_URL"
unset NEW_DB_URL
```

Před případným ostrým obnovením je nutné na testovacím projektu ověřit přihlášení, počty řádků klíčových tabulek, RLS, completion RPC, Realtime publikace a návaznosti Auth. Supabase uvádí také zvláštní kroky pro rozšíření, vlastní změny schémat `auth`/`storage`, Vault a publikace. Automatický restore workflow záměrně neexistuje.

## Pravidelná kontrola

Alespoň jednou měsíčně zkontrolujte, že poslední plánované běhy jsou zelené, stáhněte jednu zálohu, ověřte SHA-256 a proveďte dešifrování a kontrolu tří neprázdných SQL souborů. Bez pravidelného testu obnovitelnosti není samotná existence artifactu dostatečnou zárukou.

Aktuální referenční dokumentace:

- [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase: Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase: Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [GitHub: Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- [GitHub: Disabling and enabling workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
