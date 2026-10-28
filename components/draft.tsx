// "Entwurf erzeugen" on the detail page (T42). Stateless. The draft is shown as plain text in a text node (never HTML),
// can be copied, and is never stored by the page: it lives in component state only.
import { draftErrorText, type DraftResult } from "../lib/draft-client.ts";

export type DraftViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; result: Extract<DraftResult, { ok: true }> }
  | { kind: "error"; result: Extract<DraftResult, { ok: false }> };

export interface DraftPanelProps {
  state: DraftViewState;
  copied?: boolean;
  onCreate?: () => void;
  onCopy?: () => void;
}

const noop = (): void => {};

export function DraftPanel({ state, copied, onCreate, onCopy }: DraftPanelProps): React.JSX.Element {
  const loading = state.kind === "loading";
  return (
    <section className="panel draft" aria-label="Antwortentwurf">
      <h2>Antwortentwurf</h2>
      {state.kind === "ok" ? (
        <>
          <pre className="draft-text">{state.result.draft}</pre>
          {state.result.needsHumanCheck ? (
            <div className="draft-warn" role="note">
              <p><strong>Bitte besonders sorgfältig prüfen.</strong></p>
              {state.result.reasons.length > 0 && <ul>{state.result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            </div>
          ) : (
            <p className="hint">Prüfen vor dem Senden. Der Entwurf wird nicht gespeichert und nichts wird versendet.</p>
          )}
          <div className="draft-actions">
            <button type="button" className="btn btn-accent" onClick={onCopy ?? noop}>Kopieren</button>
            <button type="button" className="btn" disabled={loading} onClick={onCreate ?? noop}>Neu erzeugen</button>
          </div>
          {copied === true && <p className="notice-ok" role="status">Kopiert</p>}
        </>
      ) : (
        <>
          <p className="hint">Erzeugt einen Vorschlag zum Kopieren. Es wird nichts gesendet oder im Postfach abgelegt.</p>
          <button type="button" className="btn btn-wide btn-accent" disabled={loading} onClick={onCreate ?? noop}>Entwurf erzeugen</button>
          {loading && <p className="notice notice-inline-quiet" role="status"><span className="spinner" aria-hidden="true" />Entwurf wird erstellt …</p>}
          {state.kind === "error" && <p className="notice notice-inline" role="alert">{draftErrorText(state.result)}</p>}
        </>
      )}
    </section>
  );
}
