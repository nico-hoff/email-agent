# Abweichungen vom Implementierungsplan

| Datum | Task | Abweichung | Grund | Auswirkung |
|---|---|---|---|---|
| 2026-10-26 | P | `.env.local` als Kopie von `.env` angelegt (Werte nicht gelesen, Modus 0600). | Nur `.env` war vorhanden; Plan verlangt `.env.local`. | Keine; beide Dateien sind gitignored. |
| 2026-10-26 | T2 | `server.ts` registriert `Bundler`/`ModuleLexer` selbst aus `@veryfront/ext-bundler-esbuild` (transitive Abhängigkeit von `veryfront@0.1.1285`, nicht neu installiert). | `startServer` bricht sonst mit "Missing extension for contract Bundler" ab; die Registrierung macht sonst nur das CLI. | Import einer transitiven Abhängigkeit; bei Veryfront-Updates prüfen. |
| 2026-10-26 | T2 | `server.ts` liest optional `PORT` (Default 3000). | Bequemer Port-Override für lokale Läufe. | Zusätzliche rein operative Variable neben `BIND_ADDRESS`; nicht in `.env.example`. |
