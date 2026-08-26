# Úklid školy

Mobilní PWA pro organizaci školního úklidu. Základ používá lokální úložiště pouze pro demonstraci; `src/repository.ts` je připravené místo pro budoucí sdílenou databázi a napojení přihlášení.

## Spuštění

```bash
npm install
npm run dev
```

## Další integrace

- Supabase (PostgreSQL, přihlášení, realtime) jako společná online databáze.
- Google Calendar přes serverovou integraci s kontrolou kolizí před vytvořením plánu.
- Export docházky do CSV/PDF a správa rolí.
