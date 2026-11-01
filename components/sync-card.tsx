// Live card of the initial import (ADR 0043) in Profil → Konten. Stateless: the page polls and passes the data. Shows the
// four stages, two progress bars and a short feed of the mails System One has just processed (subject, sender, badges: all
// of it is already in the database and in the list API). No mail content beyond that; respects prefers-reduced-motion.
import { cardBadges, type Badge } from "../lib/review-ui.ts";
import { isActivePhase, syncHeadline, syncNote, syncStages, type Stage, type SyncData } from "../lib/sync-client.ts";

const noop = (): void => {};
/** Badges the feed shows: the call to action, the category (Spam, Newsletter, ...) and how important the mail is. */
const FEED_BADGES: ReadonlySet<string> = new Set(["open", "status", "category", "importance"]);

export interface SyncCardProps {
  sync: SyncData;
  /** Display name of the account, for the accessible label. */
  label: string;
  restarting?: boolean;
  restartError?: string | null;
  /** Where "Zu den Mails" leads. */
  mailsHref?: string;
  onRestart?: () => void;
}

function StageIcon({ state }: { state: Stage["state"] }): React.JSX.Element {
  return (
    <span className={`sync-icon sync-icon-${state}`} aria-hidden="true">
      {state === "done" && <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {state === "failed" && <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>}
    </span>
  );
}

const STATE_TEXT: Record<Stage["state"], string> = { todo: "wartet", active: "läuft", done: "erledigt", failed: "angehalten" };

function StageRow({ stage, indeterminate }: { stage: Stage; indeterminate: boolean }): React.JSX.Element {
  const showBar = stage.max !== undefined && stage.value !== undefined && stage.state !== "todo";
  const pct = showBar && stage.max! > 0 ? Math.min(100, Math.round((stage.value! / stage.max!) * 100)) : 0;
  return (
    <li className={`sync-stage sync-stage-${stage.state}`} data-stage={stage.key} data-state={stage.state}>
      <StageIcon state={stage.state} />
      <div className="sync-stage-body">
        <p className="sync-stage-label">
          {stage.label}
          <span className="sr-only">: {STATE_TEXT[stage.state]}</span>
        </p>
        {showBar && (
          <div className="sync-bar" role="progressbar" aria-label={stage.label} aria-valuemin={0} aria-valuemax={stage.max} aria-valuenow={stage.value}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {indeterminate && stage.state === "active" && <div className="sync-bar sync-bar-wait" aria-hidden="true"><span /></div>}
      </div>
    </li>
  );
}

function FeedItem({ m }: { m: SyncData["feed"][number] }): React.JSX.Element {
  const badges: Badge[] = cardBadges(m).filter((b) => FEED_BADGES.has(b.key));
  return (
    <li className="sync-item" data-testid="sync-item">
      <p className="sync-item-subject">{m.subject.trim() === "" ? "(ohne Betreff)" : m.subject}</p>
      <p className="sync-item-from">{m.sender === "" ? "Unbekannter Absender" : m.sender}</p>
      {badges.length > 0 && (
        <ul className="badges sync-badges">
          {badges.map((b) => <li key={b.key} className={`badge badge-${b.tone}${b.category ? ` cat-${b.category}` : ""}`}>{b.text}</li>)}
        </ul>
      )}
    </li>
  );
}

export function SyncCard({ sync, label, restarting = false, restartError = null, mailsHref = "/", onRestart }: SyncCardProps): React.JSX.Element {
  const stages = syncStages(sync);
  const note = syncNote(sync);
  const active = isActivePhase(sync.phase);
  const waiting = sync.phase === "queued" || sync.phase === "connecting";
  return (
    <section className={`sync-card sync-${sync.phase}`} aria-label={`Erst-Import für ${label}`} data-testid="sync-card" data-phase={sync.phase}>
      <header className="sync-head">
        <span className={`sync-pulse${active ? " is-live" : ""}`} aria-hidden="true" />
        <div className="sync-head-text">
          <p className="sync-kicker">Erst-Import</p>
          <h3 className="sync-title" aria-live="polite">{syncHeadline(sync)}</h3>
        </div>
      </header>
      <ol className="sync-stages">
        {stages.map((st) => <StageRow key={st.key} stage={st} indeterminate={waiting && st.key === "connect"} />)}
      </ol>
      {note !== null && <p className={`sync-note${sync.phase === "failed" || (sync.error_code === "imap_error" && active) ? " sync-note-warn" : ""}`} role="status">{note}</p>}
      {sync.feed.length > 0 && (
        <div className="sync-feed">
          <p className="sync-feed-title">{active ? "Gerade bewertet" : "Zuletzt bewertet"}</p>
          <ul className="sync-feed-list">{sync.feed.slice(0, 10).map((m) => <FeedItem key={m.id} m={m} />)}</ul>
        </div>
      )}
      {restartError !== null && <p className="notice notice-inline notice-error" role="alert">{restartError}</p>}
      {sync.phase === "done" && (
        <div className="sync-actions">
          {sync.total > 0 && <a className="btn btn-accent btn-wide" href={mailsHref}>Zu den Mails</a>}
          <button type="button" className="btn btn-wide" disabled={restarting} onClick={onRestart ?? noop}>{restarting ? "Starte …" : "Import wiederholen"}</button>
        </div>
      )}
      {sync.phase === "failed" && (
        <div className="sync-actions">
          <button type="button" className="btn btn-accent btn-wide" disabled={restarting} onClick={onRestart ?? noop}>{restarting ? "Starte …" : "Erneut versuchen"}</button>
        </div>
      )}
    </section>
  );
}
