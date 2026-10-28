// "Absender" (T54): active rules (blacklist and allowlist apart), a manual rule form and the open HITL questions.
// Stateless. Addresses, domains, counts and ids only; the mail content never reaches this screen.
import { UndoToast } from "./review.tsx";
import { HitlCard, type HitlDecision } from "./briefing.tsx";
import {
  KIND_LABEL, SENDER_ERROR_TEXT, type HitlCandidate, type RuleKind, type SenderReason, type SenderRule,
} from "../lib/senders-client.ts";

const noop = (): void => {};

export interface RuleForm {
  value: string;
  kind: RuleKind;
  busy: boolean;
  error: SenderReason | null;
}

export interface SendersViewProps {
  rules: SenderRule[];
  candidates: HitlCandidate[];
  loading: boolean;
  error: string | null;
  busyKeys: ReadonlySet<string>;
  form: RuleForm;
  expanded?: boolean;
  onExpand?: () => void;
  onFormChange?: (patch: Partial<Pick<RuleForm, "value" | "kind">>) => void;
  onSubmit?: () => void;
  onRemove?: (id: number) => void;
  onDecide?: (c: HitlCandidate, d: HitlDecision) => void;
  onReload?: () => void;
  toast?: { text: string; error?: boolean } | null;
  onToastClose?: () => void;
}

function RuleList(
  { kind, rules, busyKeys, onRemove }: { kind: RuleKind; rules: SenderRule[]; busyKeys: ReadonlySet<string>; onRemove?: (id: number) => void },
): React.JSX.Element {
  const title = kind === "blacklist" ? "Immer aussortieren" : "Nie aussortieren";
  const hint = kind === "blacklist" ? "Blacklist: darf künftig automatisch aussortiert werden." : "Whitelist: wird nie aussortiert.";
  return (
    <section className="panel" aria-label={title}>
      <h2>{title}</h2>
      <p className="hint">{hint}</p>
      {rules.length === 0 ? (
        <p className="hint">Noch keine Regeln.</p>
      ) : (
        <ul className="rules">
          {rules.map((r) => (
            <li key={r.id} className="rule">
              <span className="rule-main">
                <span className="rule-value">{r.value}</span>
                <span className="hint">{r.match === "domain" ? "Ganze Domain" : "Einzelne Adresse"}{r.account_id !== null ? ", nur ein Konto" : ""}</span>
              </span>
              <button
                type="button"
                className="btn"
                aria-label={`Regel entfernen: ${r.value}`}
                disabled={busyKeys.has(`rule:${r.id}`)}
                onClick={() => (onRemove ?? noop)(r.id)}
              >Entfernen</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SendersView(p: SendersViewProps): React.JSX.Element {
  const black = p.rules.filter((r) => r.kind === "blacklist");
  const white = p.rules.filter((r) => r.kind === "allowlist");
  const shownCandidates = p.expanded === true ? p.candidates : p.candidates.slice(0, 5);
  const hiddenCount = p.candidates.length - shownCandidates.length;
  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-row">
          <a className="back" href="/"><span aria-hidden="true">‹</span> Mails</a>
          <button type="button" className="btn btn-accent" onClick={p.onReload ?? noop} disabled={p.loading}>Neu laden</button>
        </div>
        <div className="title">
          <h1>Absender</h1>
          <p className="mode">Regeln für Absender, die immer oder nie aussortiert werden</p>
        </div>
      </header>
      {p.error !== null && (
        <div className="notice notice-error" role="alert">
          <p>{p.error}</p>
          <button type="button" className="btn" onClick={p.onReload ?? noop}>Erneut versuchen</button>
        </div>
      )}
      <main className="detail">
        {p.loading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>}

        {p.candidates.length > 0 && (
          <section className="panel" aria-label="Offene Fragen">
            <h2>Offene Fragen</h2>
            <ul className="hitl-list">
              {shownCandidates.map((c) => <HitlCard key={c.key} candidate={c} busy={p.busyKeys.has(c.key)} onDecide={p.onDecide} />)}
            </ul>
            {hiddenCount > 0 && <button type="button" className="briefing-more" onClick={p.onExpand ?? noop}>Weitere ({hiddenCount})</button>}
          </section>
        )}

        <RuleList kind="blacklist" rules={black} busyKeys={p.busyKeys} onRemove={p.onRemove} />
        <RuleList kind="allowlist" rules={white} busyKeys={p.busyKeys} onRemove={p.onRemove} />

        <form
          className="panel rule-form"
          aria-label="Regel anlegen"
          onSubmit={(e) => {
            e.preventDefault();
            (p.onSubmit ?? noop)();
          }}
        >
          <h2>Regel anlegen</h2>
          <label className="field">
            <span>Adresse oder Domain</span>
            <input
              className="input"
              type="text"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="z. B. news@beispiel.de oder beispiel.de"
              value={p.form.value}
              onChange={(e) => (p.onFormChange ?? noop)({ value: e.target.value })}
            />
          </label>
          <div className="choices" role="group" aria-label="Art der Regel">
            {(["blacklist", "allowlist"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="btn choice"
                aria-pressed={p.form.kind === k}
                onClick={() => (p.onFormChange ?? noop)({ kind: k })}
              >{KIND_LABEL[k]}</button>
            ))}
          </div>
          {p.form.error !== null && <p className="notice notice-inline" role="alert">{SENDER_ERROR_TEXT[p.form.error]}</p>}
          <button type="submit" className="btn btn-accent btn-wide" disabled={p.form.busy || p.form.value.trim() === ""}>Regel anlegen</button>
        </form>
      </main>
      {p.toast && <UndoToast text={p.toast.text} error={p.toast.error} onClose={p.onToastClose ?? noop} />}
    </div>
  );
}
