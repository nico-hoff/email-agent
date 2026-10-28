// Briefing box and sender questions at the top of "Wichtig" (T56, T54). Stateless. The briefing text is plain text
// from the model: it is split into lines and rendered as text nodes, never as HTML or Markdown, and never stored.
import {
  BRIEFING_ERROR_TEXT, briefingLines, FALLBACK_LABEL, type BriefingState,
} from "../lib/briefing-client.ts";
import { dmarcText, hitlTitle, splitCandidates, type HitlCandidate } from "../lib/senders-client.ts";

const noop = (): void => {};
export const BRIEFING_VISIBLE_LINES = 3;

export interface BriefingBoxProps {
  state: BriefingState;
  collapsed: boolean;
  /** Show every line instead of the first three. */
  showAll?: boolean;
  onToggle?: () => void;
  onShowAll?: () => void;
  onRetry?: () => void;
}

export function BriefingBox({ state, collapsed, showAll, onToggle, onShowAll, onRetry }: BriefingBoxProps): React.JSX.Element | null {
  if (state.phase === "idle") return null;
  const lines = briefingLines(state.text);
  const shown = showAll === true ? lines : lines.slice(0, BRIEFING_VISIBLE_LINES);
  const hidden = lines.length - shown.length;
  const waiting = (state.phase === "loading" || state.phase === "streaming") && lines.length === 0;
  return (
    <section className="briefing" aria-label="Zusammenfassung" aria-busy={state.phase === "loading" || state.phase === "streaming"}>
      <button type="button" className="briefing-head" aria-expanded={!collapsed} aria-controls="briefing-body" onClick={onToggle ?? noop}>
        <span className="briefing-title">Zusammenfassung</span>
        {state.openTotal !== null && <span className="fold-count">{state.openTotal} offen</span>}
        <span className="chev" aria-hidden="true">›</span>
      </button>
      {!collapsed && (
        <div id="briefing-body" className="briefing-body">
          {state.source === "fallback" && state.phase !== "loading" && <p className="briefing-tag-row"><span className="briefing-tag">{FALLBACK_LABEL}</span></p>}
          {waiting && <p className="briefing-wait" role="status"><span className="spinner" aria-hidden="true" />Zusammenfassung wird erstellt …</p>}
          {shown.length > 0 && (
            <ul className="briefing-lines">
              {shown.map((l, i) => <li key={i} className={l.bullet ? "" : "plain"}>{l.text}</li>)}
            </ul>
          )}
          {hidden > 0 && <button type="button" className="briefing-more" onClick={onShowAll ?? noop}>+ {hidden} weitere</button>}
          {state.phase === "error" && state.error && (
            <div className="briefing-error" role="alert">
              <p>{BRIEFING_ERROR_TEXT[state.error.code]}</p>
              <button type="button" className="btn" onClick={onRetry ?? noop}>Erneut versuchen</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export type HitlDecision = "blacklist" | "allowlist" | "dismiss";

export interface HitlCardProps {
  candidate: HitlCandidate;
  busy: boolean;
  onDecide?: (c: HitlCandidate, decision: HitlDecision) => void;
}

/** One question: "Absender X wurde N× als Spam erkannt" with the three answers. */
export function HitlCard({ candidate: c, busy, onDecide }: HitlCardProps): React.JSX.Element {
  const hint = dmarcText(c.dmarc_pass_rate);
  const decide = (d: HitlDecision) => () => (onDecide ?? noop)(c, d);
  return (
    <li className="hitl-card">
      <p className="hitl-title">{hitlTitle(c)}</p>
      {hint !== null && <p className="hitl-hint">{hint}</p>}
      <div className="hitl-actions">
        <button type="button" className="btn btn-accent" disabled={busy} onClick={decide("blacklist")}>Immer aussortieren</button>
        <button type="button" className="btn" disabled={busy} onClick={decide("allowlist")}>Nie aussortieren</button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={decide("dismiss")}>Später</button>
      </div>
    </li>
  );
}

export interface HitlCardsProps {
  candidates: HitlCandidate[];
  busy: ReadonlySet<string>;
  expanded: boolean;
  onExpand?: () => void;
  onDecide?: (c: HitlCandidate, decision: HitlDecision) => void;
}

/** At most two cards; the rest sits under "Weitere". */
export function HitlCards({ candidates, busy, expanded, onExpand, onDecide }: HitlCardsProps): React.JSX.Element | null {
  if (candidates.length === 0) return null;
  const { shown, rest } = splitCandidates(candidates);
  const visible = expanded ? [...shown, ...rest] : shown;
  return (
    <section className="hitl" aria-label="Offene Fragen zu Absendern">
      <ul className="hitl-list">
        {visible.map((c) => <HitlCard key={c.key} candidate={c} busy={busy.has(c.key)} onDecide={onDecide} />)}
      </ul>
      {!expanded && rest.length > 0 && (
        <button type="button" className="briefing-more" onClick={onExpand ?? noop}>Weitere ({rest.length})</button>
      )}
    </section>
  );
}
