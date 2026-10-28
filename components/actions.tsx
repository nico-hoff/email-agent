// "Aussortiert" (T59a/T60a): what the rule "Spam gelesen" would do (dry run) or did (live), with the undo button.
// Stateless. The rows carry the metadata of GET /api/actions plus the card of GET /api/emails/:id; no body, excerpt
// or raw source exists here, and server codes (failure_code) are never printed.
import { AcctTag, CardLink, UndoToast } from "./review.tsx";
import {
  ACTION_TABS,
  ACTION_TAB_LABEL,
  actionTitle,
  formatCount,
  modeNotices,
  tabCount,
  type ActionRow,
  type ActionTab,
  type ActionsCounts,
  type ApiAccount,
  type AutoMode,
} from "../lib/review-ui.ts";

const noop = (): void => {};

export interface ActionsViewProps {
  tab: ActionTab;
  /** null until the first response. */
  counts: ActionsCounts | null;
  rows: ActionRow[];
  accounts: ApiAccount[];
  modes?: Record<string, AutoMode>;
  now: Date;
  timeZone?: string;
  loading: boolean;
  error: string | null;
  canLoadMore: boolean;
  /** Email ids with a request in flight. */
  busy: ReadonlySet<number>;
  onTab?: (t: ActionTab) => void;
  onMore?: () => void;
  onReload?: () => void;
  onUnread?: (emailId: number) => void;
  toast?: { text: string; error?: boolean } | null;
  onToastClose?: () => void;
}

const EMPTY: Record<ActionTab, { title: string; hint: string }> = {
  dry_run: { title: "Nichts geplant", hint: "Sobald neuer Spam eintrifft, steht hier, was die Regel tun würde." },
  live: { title: "Noch nichts ausgeführt", hint: "Hier stehen Mails, die im Postfach als gelesen markiert wurden." },
};

function Row(
  { row, p }: { row: ActionRow; p: ActionsViewProps },
): React.JSX.Element {
  const { action, email } = row;
  const title = actionTitle(action);
  if (email === null) return <li className="skeleton" aria-hidden="true" />;
  if (email === "missing") {
    return (
      <li className="item action-item">
        <p className="action-title">{title}</p>
        <p className="notice notice-quiet">Mail nicht mehr vorhanden</p>
      </li>
    );
  }
  const busy = p.busy.has(action.email_id);
  // In the dry run nothing was marked yet: the button keeps the rule from marking the mail, so it is not "ungelesen".
  const label = p.tab === "dry_run" ? "Nicht markieren" : "Wieder ungelesen";
  return (
    <li className="item action-item">
      <p className="action-title">{title}</p>
      <CardLink m={email} now={p.now} timeZone={p.timeZone} />
      <div className="action-foot">
        <button
          type="button"
          className="btn btn-unread"
          aria-label={`${label}: ${email.subject || "(ohne Betreff)"}`}
          disabled={busy}
          onClick={() => (p.onUnread ?? noop)(action.email_id)}
        >{label}</button>
      </div>
    </li>
  );
}

export function ActionsView(p: ActionsViewProps): React.JSX.Element {
  // Accounts with the same mode share one line (many accounts stay compact).
  const notices = ([] as { mode: AutoMode; text: string; accounts: ApiAccount[] }[]);
  for (const n of modeNotices(p.accounts, p.modes)) {
    const g = notices.find((x) => x.mode === n.mode);
    if (g) g.accounts.push(n.account);
    else notices.push({ mode: n.mode, text: n.text, accounts: [n.account] });
  }
  const failed = p.counts?.live.failed ?? 0;
  const empty = p.rows.length === 0 && !p.loading && p.error === null;
  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-row">
          <a className="back" href="/"><span aria-hidden="true">‹</span> Mails</a>
          <button type="button" className="btn btn-accent" onClick={p.onReload ?? noop} disabled={p.loading}>Neu laden</button>
        </div>
        <div className="title">
          <h1>Aussortiert</h1>
          <p className="mode">Spam, den die App als gelesen markiert</p>
        </div>
        <div className="segmented" role="group" aria-label="Ansicht">
          {ACTION_TABS.map((t) => (
            <button key={t} type="button" className="seg" aria-pressed={p.tab === t} onClick={p.onTab ? () => p.onTab?.(t) : noop}>
              <span className="seg-label">{ACTION_TAB_LABEL[t]}</span>
              {p.counts !== null && <span className="seg-count">{formatCount(tabCount(p.counts, t))}</span>}
            </button>
          ))}
        </div>
      </header>
      {p.error !== null && (
        <div className="notice notice-error" role="alert">
          <p>{p.error}</p>
          <button type="button" className="btn" onClick={p.onReload ?? noop}>Erneut versuchen</button>
        </div>
      )}
      <main>
        {notices.length > 0 && (
          <ul className="mode-list" aria-label="Modus je Konto">
            {notices.map((n) => (
              <li key={n.mode} className={`mode-note mode-${n.mode}`}>
                <span className="mode-accts">{n.accounts.map((a) => <AcctTag key={a.id} account={a} small />)}</span>
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        )}
        {p.tab === "live" && failed > 0 && (
          <p className="hint action-failed">{failed} fehlgeschlagen. Fehlgeschlagene Aktionen werden nicht wiederholt.</p>
        )}
        {p.rows.length > 0 && <ul className="cards action-list">{p.rows.map((r) => <Row key={r.action.id} row={r} p={p} />)}</ul>}
        {empty && (
          <div className="empty">
            <p className="empty-icon" aria-hidden="true">✉</p>
            <p className="empty-title">{EMPTY[p.tab].title}</p>
            <p className="hint">{EMPTY[p.tab].hint}</p>
          </div>
        )}
        {p.loading && p.rows.length === 0 && (
          <ul className="cards skeletons" aria-hidden="true">
            {[0, 1, 2].map((i) => <li key={i} className="skeleton" />)}
          </ul>
        )}
        {p.loading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>}
        {p.canLoadMore && !p.loading && (
          <button type="button" className="btn btn-wide" onClick={p.onMore ?? noop}>Mehr laden</button>
        )}
      </main>
      {p.toast && <UndoToast text={p.toast.text} error={p.toast.error} onClose={p.onToastClose ?? noop} />}
    </div>
  );
}
