# Úklid školy

Mobilní PWA pro organizaci školního úklidu se sdílenými daty v Supabase (PostgreSQL a Auth).

## Spuštění

```bash
npm install
npm run typecheck
npm run dev
```

## Nastavení Supabase

1. V Supabase vytvořte nový projekt a v SQL Editoru spusťte migraci `supabase/migrations/202608260001_initial_schema.sql`.
2. V Auth vytvořte účty Dany, Martiny a Davida se jmény v metadatech `full_name`. Nové účty jsou z bezpečnostních důvodů vždy `cleaner`.
3. U Davidova účtu nastavte v SQL Editoru roli správce:

   ```sql
   update public.profiles set role = 'caretaker' where full_name = 'David';
   ```

4. Přiřaďte úkoly Daně a Martině přes `task_assignments` (ID profilů jsou v `public.profiles`).
5. Zkopírujte `.env.example` do `.env.local` a vyplňte pouze `VITE_SUPABASE_URL` a `VITE_SUPABASE_ANON_KEY`. Obě hodnoty jsou veřejné klientské hodnoty; `service_role` klíč do aplikace nikdy nedávejte.

Migrace zapíná RLS, vytváří tabulky a seed budov, pater, aktuálních místností, výchozích úkolů i zásob. Realtime je zapnutý pro `cleaning_completions` a `attendance`.

## Další integrace

- Supabase (PostgreSQL, přihlášení, realtime) jako společná online databáze.
- Google Calendar přes serverovou integraci s kontrolou kolizí před vytvořením plánu.
- Export docházky do CSV/PDF a správa rolí.
