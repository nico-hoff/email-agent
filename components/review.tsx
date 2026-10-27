// Presentational components of the signal inbox (T36, T47, T48, T49). They are stateless and receive only the
// metadata rows of GET /api/emails: no body, excerpt or raw source ever exists here. The mailbox itself is read-only.
import type { Ref } from "react";
import {
  cardBadges,
  categoryLabel,
  categoryOf,
  describeAnswers,
  EMPTY_TITLE,
  emptyText,
  folderHistoryRows,
  formatCount,
  formatNumber,
  formatTime,
  groupByUrgency,
  importanceText,
  locationText,
  NOISE_TITLE,
  safeColor,
  scoreLevel,
  shadowText,
  urgencyText,
  VIEWS,
  VIEW_LABEL,
  WORK_LABEL,
  workState,
  DISAGREEMENT_LABEL,
  STATUS_LABEL,
  type AnswerItem,
  type ApiAccount,
  type ApiCounts,
  type ApiEmail,
  type ApiEmailDetail,
  type Badge,
  type ViewId,
} from "../lib/review-ui.ts";

export function BadgeList({ badges }: { badges: Badge[] }): React.JSX.Element {
  return (
    <ul className="badges">
      {badges.map((b) => (
        <li key={b.key} className={`badge badge-${b.tone}${b.category ? ` cat-${b.category}` : ""}`}>{b.text}</li>
      ))}
    </ul>
  );
}

/** Account tag (T47): small color dot plus short name. */
export function AcctTag({ account, small }: { account: ApiAccount; small?: boolean }): React.JSX.Element {
  return (
    <span className={small ? "acct acct-sm" : "acct"}>
      <span className="acct-dot" style={{ background: safeColor(account.color) }} aria-hidden="true" />
      {account.label}
    </span>
  );
}

interface Verdict { key: string; text: string; detail: string | null }

// Subtle Jev verdicts on the card: only positive Spam/Phishing readings, with raw value vs threshold when known.
const VERDICTS: [string, string][] = [["is_spam", "Spam"], ["is_phishing_or_scam", "Phishing"]];

function verdicts(m: ApiEmail): Verdict[] {
  if (m.classification?.status !== "classified") return [];
  const out: Verdict[] = [];
  for (const [key, text] of VERDICTS) {
    const a = m.classification.answers[key];
    if (a === undefined || a.reading !== "positive" || typeof a.value !== "number") continue;
    out.push({
      key, text,
      detail: typeof a.threshold === "number" ? `${formatNumber(a.value)} / ${formatNumber(a.threshold)}` : formatNumber(a.value),
    });
  }
  return out;
}

function initial(sender: string): string {
  const c = sender.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0);
  return c === "" ? "?" : c.toUpperCase();
}

export function EmailCard(
  { m, now, timeZone }: { m: ApiEmail; now: Date; timeZone?: string },
): React.JSX.Element {
  const folder = m.active_location?.folder ?? null;
  const cls = ["item", m.open ? "is-open" : "", m.seen ? "is-seen" : "", m.done ? "is-done" : ""].filter(Boolean).join(" ");
  const vs = verdicts(m);
  return (
    <li className={cls}>
      <a className="card" href={`/emails/${m.id}`} data-cat={categoryOf(m) ?? "none"}>
        <span className="avatar" aria-hidden="true">{initial(m.sender)}</span>
        <span className="card-body">
          <span className="card-head">
            <span className="sender">{m.sender}</span>
            <time className="time" dateTime={m.received_at}>{formatTime(m.received_at, now, timeZone)}</time>
          </span>
          <span className="subject">{m.subject || "(ohne Betreff)"}</span>
          <BadgeList badges={cardBadges(m)} />
          {vs.length > 0 && (
            <span className="verdicts">
              {vs.map((v) => (
                <span key={v.key} className="verdict">
                  <strong>{v.text}</strong>
                  <span className="verdict-raw" title="Rohwert / Schwelle">{v.detail}</span>
                </span>
              ))}
            </span>
          )}
          <span className="meta">
            <AcctTag account={m.account} small />
            {folder !== null && <span className="meta-folder">{folder}</span>}
          </span>
        </span>
      </a>
    </li>
  );
}

function CardGroups({ emails, now, timeZone }: { emails: ApiEmail[]; now: Date; timeZone?: string }): React.JSX.Element {
  return (
    <>
      {groupByUrgency(emails).map((g, i) => (
        <section key={`${g.key}-${i}`} className="group">
          <h2 className="group-title">{g.label}</h2>
          <ul className="cards">
            {g.items.map((m) => <EmailCard key={m.id} m={m} now={now} timeZone={timeZone} />)}
          </ul>
        </section>
      ))}
    </>
  );
}

export interface NoiseState {
  open: boolean;
  emails: ApiEmail[];
  loading: boolean;
  canLoadMore: boolean;
  error: boolean;
}

export interface ReviewListProps {
  emails: ApiEmail[];
  view: ViewId;
  /** null until the first response; then the segment and section numbers come from the API. */
  counts: ApiCounts | null;
  accounts: ApiAccount[];
  account: string;
  now: Date;
  timeZone?: string;
  loading: boolean;
  error: string | null;
  canLoadMore: boolean;
  noise: NoiseState;
  onView?: (v: ViewId) => void;
  onAccount?: (a: string) => void;
  onReload?: () => void;
  onMore?: () => void;
  onNoiseToggle?: () => void;
  onNoiseMore?: () => void;
  sentinelRef?: Ref<HTMLDivElement>;
}

const noop = (): void => {};

function NoiseFold(
  { counts, noise, now, timeZone, onToggle, onMore }:
    { counts: ApiCounts; noise: NoiseState; now: Date; timeZone?: string; onToggle?: () => void; onMore?: () => void },
): React.JSX.Element {
  return (
    <section className="fold" aria-label="Aussortiert">
      <button type="button" className="fold-head" aria-expanded={noise.open} aria-controls="noise-list" onClick={onToggle ?? noop}>
        <span className="fold-title">{NOISE_TITLE}</span>
        <span className="fold-count">{formatCount(counts.noise)}</span>
        <span className="chev" aria-hidden="true">›</span>
      </button>
      {noise.open && (
        <div id="noise-list" className="fold-body">
          {noise.emails.length > 0 && (
            <ul className="cards">
              {noise.emails.map((m) => <EmailCard key={m.id} m={m} now={now} timeZone={timeZone} />)}
            </ul>
          )}
          {noise.error && <p className="notice notice-inline" role="alert">Aussortiertes konnte nicht geladen werden.</p>}
          {noise.loading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>}
          {!noise.loading && !noise.error && noise.emails.length === 0 && <p className="notice">Nichts aussortiert.</p>}
          {noise.canLoadMore && !noise.loading && (
            <button type="button" className="btn btn-wide" onClick={onMore ?? noop}>Mehr laden</button>
          )}
        </div>
      )}
    </section>
  );
}

export function ReviewListView(p: ReviewListProps): React.JSX.Element {
  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-row">
          <div className="title">
            <h1>Mails</h1>
            <p className="mode">Alle Konten · Postfach nur lesend</p>
          </div>
          <button type="button" className="btn btn-accent" onClick={p.onReload ?? noop} disabled={p.loading}>Neu laden</button>
        </div>
        <div className="segmented" role="group" aria-label="Ansicht">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className="seg"
              aria-pressed={p.view === v}
              onClick={p.onView ? () => p.onView?.(v) : noop}
            >
              <span className="seg-label">{VIEW_LABEL[v]}</span>
              {p.counts !== null && <span className="seg-count">{formatCount(p.counts[v])}</span>}
            </button>
          ))}
        </div>
        {p.accounts.length > 1 && (
          <div className="chips" role="group" aria-label="Konto">
            <button type="button" className="chip" aria-pressed={p.account === ""} onClick={() => (p.onAccount ?? noop)("")}>Alle Konten</button>
            {p.accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                className="chip"
                aria-pressed={p.account === a.id}
                onClick={() => (p.onAccount ?? noop)(a.id)}
              >
                <span className="acct-dot" style={{ background: safeColor(a.color) }} aria-hidden="true" />{a.label}
              </button>
            ))}
          </div>
        )}
      </header>
      {p.error !== null && (
        <div className="notice notice-error" role="alert">
          <p>{p.error}</p>
          <button type="button" className="btn" onClick={p.onReload ?? noop}>Erneut versuchen</button>
        </div>
      )}
      <main>
        {p.emails.length > 0 && <CardGroups emails={p.emails} now={p.now} timeZone={p.timeZone} />}
        {p.emails.length === 0 && !p.loading && p.error === null && (
          <div className="empty">
            <p className="empty-icon" aria-hidden="true">✉</p>
            <p className="empty-title">{EMPTY_TITLE}</p>
            <p className="hint">{emptyText(p.view)}</p>
          </div>
        )}
        {p.loading && p.emails.length === 0 && (
          <ul className="cards skeletons" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <li key={i} className="skeleton" />)}
          </ul>
        )}
        {p.loading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>}
        {p.canLoadMore && !p.loading && (
          <button type="button" className="btn btn-wide" onClick={p.onMore ?? noop}>Mehr laden</button>
        )}
        <div ref={p.sentinelRef} aria-hidden="true" className="sentinel" />
        {p.view === "important" && p.counts !== null && p.counts.noise > 0 && (
          <NoiseFold
            counts={p.counts}
            noise={p.noise}
            now={p.now}
            timeZone={p.timeZone}
            onToggle={p.onNoiseToggle}
            onMore={p.onNoiseMore}
          />
        )}
      </main>
    </div>
  );
}

function AnswerBlock({ item }: { item: AnswerItem }): React.JSX.Element {
  return (
    <li className="qa">
      <div className="qa-row">
        <p className="q">{item.question}</p>
        <p className={item.kind === "noul" && (item.answer === "Ja" || item.answer === "Nein") ? `a pill ${item.answer === "Ja" ? "pill-yes" : "pill-no"}` : "a"}>{item.answer}</p>
      </div>
      {item.bar && (
        <div className="bar-wrap">
          <div
            className={item.bar.uncalibrated ? "meter meter-raw" : "meter"}
            role="meter"
            aria-valuenow={item.bar.raw}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-label={`Rohwert ${item.key}`}
          >
            <span style={{ width: `${Math.round(item.bar.fill * 100)}%` }} />
          </div>
          {item.bar.uncalibrated && <span className="hint">unkalibriert: noch keine Ja/Nein-Aussage</span>}
          {item.bar.detail && <span className="hint">{item.bar.detail}</span>}
        </div>
      )}
      {item.probabilities && (
        <ul className="probs">
          {item.probabilities.map((r) => (
            <li key={r.label} className={r.selected ? "prob prob-sel" : "prob"}>
              <span className="prob-label">{r.label}</span>
              <span className="prob-bar"><span style={{ width: r.percent.replace(" ", "") }} /></span>
              <span className="prob-val">{r.percent}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export interface EmailDetailProps {
  email: ApiEmailDetail;
  now: Date;
  timeZone?: string;
}

export function EmailDetailView({ email: m, now, timeZone }: EmailDetailProps): React.JSX.Element {
  const a = m.classification?.answers ?? {};
  const classified = m.classification?.status === "classified";
  const imp = scoreLevel(m.importance ?? a.importance?.value);
  const urg = scoreLevel(m.urgency ?? a.urgency?.value);
  const cat = categoryOf(m);
  const status = m.classification?.status ?? null;
  const history = folderHistoryRows(m.folder_history, now, timeZone);
  return (
    <div className="screen">
      <header className="bar">
        <a className="back" href="/"><span aria-hidden="true">‹</span> Liste</a>
      </header>
      <main className="detail">
        <h1 className="detail-subject">{m.subject || "(ohne Betreff)"}</h1>
        <p className="detail-from">{m.sender}</p>
        <p className="meta detail-meta">
          <AcctTag account={m.account} />
          <span>{formatTime(m.received_at, now, timeZone)}</span>
          <span>{locationText(m)}</span>
        </p>

        <section className="panel" aria-label="Überblick">
          <h2>Überblick</h2>
          <dl className="facts">
            <dt>Status</dt>
            <dd className={`work work-${workState(m)}`}>{WORK_LABEL[workState(m)]}</dd>
            {classified ? (
              <>
                <dt>Kategorie</dt>
                <dd>{categoryLabel(cat)}</dd>
                <dt>Dringlichkeit</dt>
                <dd>{urg === null ? "-" : `Stufe ${urg} von 3: ${urgencyText(urg)}`}</dd>
                <dt>Wichtigkeit</dt>
                <dd>{imp === null ? "-" : `Stufe ${imp} von 3: ${importanceText(imp)}`}</dd>
              </>
            ) : (
              <>
                <dt>Bewertung</dt>
                <dd>
                  {status === null ? "Nicht bewertet" : STATUS_LABEL[status] ?? "Nicht bewertet"}
                  {m.classification?.failure_code ? ` (${m.classification.failure_code})` : ""}
                </dd>
              </>
            )}
          </dl>
        </section>

        {m.disagreement !== null && (
          <section className="panel panel-warn" aria-label="Abweichung">
            <h2>Abweichung zum Provider</h2>
            <p>{DISAGREEMENT_LABEL[m.disagreement] ?? "Provider und Jev urteilen verschieden."}</p>
          </section>
        )}

        {m.shadow_quarantine?.candidate === true && (
          <section className="panel" aria-label="Shadow">
            <h2>Shadow-Entscheidung</h2>
            <p>Spam-Kandidat. Es wird nichts verschoben.</p>
          </section>
        )}

        <details className="fold-panel">
          <summary>Details</summary>
          <section className="fold-section" aria-label="Jev-Antworten">
            <h2>Jev-Antworten</h2>
            {classified ? (
              <ul className="qas">{describeAnswers(a).map((i) => <AnswerBlock key={i.key} item={i} />)}</ul>
            ) : (
              <p>Noch keine Jev-Antworten vorhanden.</p>
            )}
          </section>
          {m.shadow_quarantine && (
            <section className="fold-section" aria-label="Shadow-Details">
              <h2>Shadow-Entscheidung</h2>
              <p className="hint">{shadowText(m.shadow_quarantine)}</p>
            </section>
          )}
          <section className="fold-section" aria-label="Ordnerverlauf">
            <h2>Ordnerverlauf</h2>
            {history.length > 0 ? (
              <ul className="history">
                {history.map((h) => (
                  <li key={h.key}><span className="history-when">{h.when}</span><span>{h.text}</span></li>
                ))}
              </ul>
            ) : (
              <p className="hint">Kein Ordnerwechsel beobachtet.</p>
            )}
            {m.locations.length > 0 && (
              <p className="hint">
                Gesehen in: {m.locations.map((l) => (l.is_active ? `${l.folder} (aktuell)` : l.folder)).join(", ")}
              </p>
            )}
          </section>
        </details>
        <p className="hint foot">Das Postfach bleibt unberührt: Es wird nichts verschoben, gelöscht oder beantwortet.</p>
      </main>
    </div>
  );
}

export function DetailMessage({ text, role }: { text: string; role?: "alert" | "status" }): React.JSX.Element {
  return (
    <div className="screen">
      <header className="bar"><a className="back" href="/">‹ Liste</a></header>
      <main><p className="notice" role={role}>{text}</p></main>
    </div>
  );
}
