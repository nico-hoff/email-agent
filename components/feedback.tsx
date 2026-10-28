// Feedback buttons on the detail page (T37). Stateless: the current answer per topic comes from the server,
// null = still loading. A repeated answer is a no-op on the server, so a pressed button just stays pressed.
import { CATEGORY_CHOICES, type FeedbackKind, type FeedbackState } from "../lib/feedback-client.ts";
import { categoryLabel } from "../lib/review-ui.ts";

export interface FeedbackPanelProps {
  state: FeedbackState | null;
  busy?: boolean;
  onAnswer?: (kind: FeedbackKind, value?: string) => void;
}

const noop = (): void => {};

export function FeedbackPanel({ state, busy, onAnswer }: FeedbackPanelProps): React.JSX.Element {
  const answer = onAnswer ?? noop;
  const off = state === null || busy === true;
  const choice = (kind: FeedbackKind, label: string, pressed: boolean) => (
    <button type="button" className="btn choice" aria-pressed={pressed} disabled={off} onClick={() => answer(kind)}>{label}</button>
  );
  return (
    <section className="panel" aria-label="Feedback">
      <h2>Stimmt das?</h2>
      <div className="choices" role="group" aria-label="Spam">
        {choice("spam_correct", "Spam", state?.spam === "spam_correct")}
        {choice("not_spam", "Kein Spam", state?.spam === "not_spam")}
      </div>
      <div className="choices" role="group" aria-label="Antwort">
        {choice("reply_needed", "Braucht Antwort", state?.reply === "reply_needed")}
        {choice("no_reply_needed", "Keine Antwort nötig", state?.reply === "no_reply_needed")}
      </div>
      <label className="choice-select">
        <span className="visually-hidden">Richtige Kategorie</span>
        <select
          className="select"
          disabled={off}
          value=""
          onChange={(e) => {
            if (e.target.value !== "") answer("category_wrong", e.target.value);
          }}
        >
          <option value="">Falsche Kategorie …</option>
          {CATEGORY_CHOICES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
      </label>
      {state?.category != null && <p className="hint">Kategorie korrigiert: {categoryLabel(state.category)}</p>}
    </section>
  );
}
