# Soukromý školní Google Kalendář

Integrace je pouze pro čtení. React klient nedostává Google access token, refresh token, client secret ani ID soukromého kalendáře. Přihlášení uživatelů přes Google/Supabase Auth se nemění.

Tok dat:

1. přihlášená aplikace zavolá Supabase Edge Function `school-calendar-events` s `from` a `to`,
2. funkce ověří Supabase JWT a `can_view_school_data()`,
3. na serveru vymění uložený Google refresh token za krátkodobý access token,
4. přes Google Calendar API `events.list` načte pouze požadovaný interval,
5. klient dostane omezený a očištěný seznam událostí bez přístupových údajů.

Události ani jejich popisy se necachují v databázi. Ukládá se pouze adminem potvrzené mapování externího ID nebo ID opakující se série na budovu, patro či místnost.

## Jednorázové nastavení Google

1. V Google Cloud projektu zapněte Google Calendar API.
2. Vytvořte OAuth client určený pro serverové použití a dokončete consent konfiguraci organizace.
3. Jednorázově autorizujte účet, který má k cílovému kalendáři přístup pouze pro čtení, se scope:
   `https://www.googleapis.com/auth/calendar.readonly`.
4. Při této jednorázové autorizaci vyžádejte offline access a bezpečně uložte vydaný refresh token. Běžní pracovníci už žádný další Google souhlas nedávají.
5. Hodnoty vložte výhradně mezi Supabase Function Secrets. Nepoužívejte `VITE_*`, databázi ani soubory repozitáře.

Příkazy spouštějte až po kontrole migrace a s vlastními tajnými hodnotami:

```sh
supabase secrets set GOOGLE_CALENDAR_CLIENT_ID="<GOOGLE_OAUTH_CLIENT_ID>"
supabase secrets set GOOGLE_CALENDAR_CLIENT_SECRET="<GOOGLE_OAUTH_CLIENT_SECRET>"
supabase secrets set GOOGLE_CALENDAR_REFRESH_TOKEN="<GOOGLE_OAUTH_REFRESH_TOKEN>"
supabase secrets set SCHOOL_GOOGLE_CALENDAR_ID="<ID_SOUKROMEHO_KALENDARE>"
supabase functions deploy school-calendar-events
```

Skutečné hodnoty nikdy nevkládejte do terminálového výstupu, issue, logu ani commitu.

## Ověření po nasazení

Po přihlášení do aplikace otevřete Kalendář. Síťový požadavek na `functions/v1/school-calendar-events` má vrátit pouze normalizované události. Bez přihlášení má endpoint vrátit 401, neschválenému účtu 403. Chybějící konfigurace vrací kontrolovanou 503 a úklidový plán dál funguje.

Mapovací migrace je samostatná a před nasazením se musí ručně zkontrolovat:

`supabase/migrations/20260907120000_school_calendar_scope_mappings.sql`

Integrace nikdy sama nemaže, neruší ani nepřesouvá úklid. Doporučení v detailu dne je pouze informace; potvrzenou změnu plánu musí správce provést existujícími nástroji aplikace.
