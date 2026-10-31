# 0013 Synthetische Dev-DB als Standard

- Status: angenommen
- Datum: 2026-10-29
- Bezug: `npm run dev`, `npm run dev:seed`, `data/dev-synthetic.sqlite`, `docs/LOCAL_DEV_MAC.md`

## Kontext
Entwickeln (auch durch Agenten, Screenshots) darf nie echte Mails berühren.

## Entscheidung
`npm run dev` nutzt immer `data/dev-synthetic.sqlite`, startet keinen IMAP-Worker und läuft im Auth-Modus synthetic. Befüllt wird aus den HF-Datensets (`eval:fetch`, `dev:seed`). Echte Daten nur mit `npm run dev:live` bzw. `npm start`.

## Folgen
- UI-Arbeit und Screenshots sind ohne Risiko möglich.
- Der Synthetic-Modus wird nur über die Server-Option von `npm run dev` gesetzt (unabhängig von `ACCOUNTS_FILE`/`DATABASE_PATH`), `assertSyntheticDatabase` prüft die DB; im Synthetic-Modus läuft nie ein Worker und `auto_actions` bleibt wirkungslos.
