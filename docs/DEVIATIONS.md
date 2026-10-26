# Abweichungen vom Implementierungsplan

| Datum | Task | Abweichung | Grund | Auswirkung |
|---|---|---|---|---|
| 2026-10-26 | P | `.env.local` als Kopie von `.env` angelegt (Werte nicht gelesen, Modus 0600). | Nur `.env` war vorhanden; Plan verlangt `.env.local`. | Keine; beide Dateien sind gitignored. |
| 2026-10-26 | T2 | `server.ts` registriert `Bundler`/`ModuleLexer` selbst aus `@veryfront/ext-bundler-esbuild` (transitive Abhängigkeit von `veryfront@0.1.1285`, nicht neu installiert). | `startServer` bricht sonst mit "Missing extension for contract Bundler" ab; die Registrierung macht sonst nur das CLI. | Import einer transitiven Abhängigkeit; bei Veryfront-Updates prüfen. |
| 2026-10-26 | T2 | `server.ts` liest optional `PORT` (Default 3000). | Bequemer Port-Override für lokale Läufe. | Zusätzliche rein operative Variable neben `BIND_ADDRESS`; nicht in `.env.example`. |
| 2026-10-26 | T4 | `@openrouter/sdk`-Installation aus blockiertem T3 mit T4 committet (package.json/package-lock.json). | Lock-Konsistenz. | T3-Commit enthält später nur Fixture + jev-contract.md. |
| 2026-10-26 | T4 | Explizit gesetzter `ACCOUNTS_FILE` muss absolut sein (relativ wird abgelehnt); nur der Default `data/accounts.json` wird relativ zur Projektwurzel aufgelöst. | Plan-T4 verlangt Ablehnung relativer Pfade; D4 nennt Auflösung relativ zur Wurzel. | Relative Overrides in `.env.local` funktionieren nicht. |
| 2026-10-26 | T4 | `.vfignore` angelegt (Context7 /websites/veryfront bestätigt `.vfignore` für push/deploy; `.env*` bleibt ohnehin geschützt). | Plan-Vorgabe. | `data/`, `.env*`, `*.sqlite*` werden nie hochgeladen. |
| 2026-10-26 | T6 | `lib/constants.ts` hier angelegt (alle Konstanten aus Plan-Abschnitt 2); `accounts-config.ts` importiert den Default von dort. | Kein Task nennt die Datei explizit. | Zusätzliche Dateien im T6-Commit; `DEFAULT_ACCOUNTS_FILE` wird aus `accounts-config.ts` weiter re-exportiert. |
| 2026-10-26 | T7 | Excerpt basiert auf `parsed.text`; bei reinen HTML-Mails erzeugt mailparser dieses `text` selbst aus dem HTML. | Plan nennt `parsed.text` als Grundlage; mailparser-Verhalten. | Auszug kann bei HTML-only-Mails aus konvertiertem HTML stammen (weiterhin max. 1200 Zeichen, nur im Speicher). |
