# 0002 Node 26.12.1, npm, löschbares TypeScript

- Status: angenommen
- Datum: 2026-10-20
- Bezug: `package.json` (`engines`), `.nvmrc`, `tsconfig.json`, H-Regeln in `docs/IMPLEMENTATION_PLAN.md`

## Kontext
Node führt TypeScript nativ aus, sofern nur löschbare Syntax (keine `enum`, keine Parameter-Properties, kein `namespace`) verwendet wird. Ein Build-Schritt für Skripte und Tests entfällt dadurch.

## Entscheidung
Node **exakt 26.12.1**, Paketmanager npm (`npm ci`). Von Node direkt ausgeführter Code importiert mit `.ts`-Endung. Typecheck mit `tsc --noEmit` (TypeScript 7.0.2). Tests mit `node --test`.

## Folgen
- Keine Transpiler-Abhängigkeit für Skripte/Tests; Fehler bei nicht löschbarer Syntax fallen sofort auf.
- Andere Node-Versionen sind nicht unterstützt (`node:sqlite`, Typ-Stripping).
