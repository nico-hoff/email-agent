# 0014 Evals: HF-Datensets, calib/test, Offline-Gates

- Status: angenommen
- Datum: 2026-10-29
- Bezug: `docs/eval-datasets.md`, `docs/agent-contract.md` §7, `evals/`, `scripts/eval-*.ts`

## Kontext
Qualität der Klassifikation und der Agenten muss messbar sein („Data Science Standard“), ohne echte Mails.

## Entscheidung
Synthetische Hugging-Face-Datensets (triage, sinabis), fester Split calib 30 % / test 70 %, stratifiziertes Sampling mit Seed, Wilson-Intervalle, Vergleich in `insights.md` (`eval:compare`). `npm run eval` ist das Offline-Gate (3 Evals: jev, reply-drafter, briefing) mit aufgezeichneten Antworten und läuft in CI. Live-Läufe (`eval:jev`, `eval:agents`) nur durch Nico.

## Folgen
- Jede Schwellen- oder Prompt-Änderung braucht einen Eval-Beleg.
- Ziel ≥ 95 % Spam-Erkennung wird auf dem test-Split nachgewiesen, nicht auf calib.
