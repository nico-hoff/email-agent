// Presentational components of the mobile review UI (T36). They are stateless and receive only the metadata
// rows of GET /api/emails: no body, excerpt or raw source ever exists here. Read-only: no write controls.
import type { ChangeEvent, Ref } from "react";
import {
  availableViews,
  cardBadges,
  categoryLabel,
  describeAnswers,
  EMPTY_TITLE,
  emptyText,
  filterByView,
  formatNumber,
  formatTime,
  importanceText,
  locationText,
  scoreLevel,
  shadowText,
  urgencyText,
  VIEW_LABEL,
  DISAGREEMENT_LABEL,
  STATUS_LABEL,
  type AnswerItem,
  type ApiEmail,
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

function categoryOf(m: ApiEmail): string {
  const v = m.classification?.answers.category?.value;
  return m.classification?.status === "classified" && typeof v === "string" ? v : "none";
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
  { m, now, timeZone, showAccount }: { m: ApiEmail; now: Date; timeZone?: string; showAccount: boolean },
): React.JSX.Element {
  const meta = [showAccount ? m.account_id : null, m.active_location?.folder ?? null].filter(Boolean).join(" · ");
  return (
    <li>
      <a className="card" href={`/emails/${m.id}`} data-cat={categoryOf(m)}>
        <span className="avatar" aria-hidden="true">{initial(m.sender)}</span>
        <span className="card-body">
          <span className="card-head">
            <span className="sender">{m.sender}</span>
            <time className="time" dateTime={m.received_at}>{formatTime(m.received_at, now, timeZone)}</time>
          </span>
          <span className="subject">{m.subject || "(ohne Betreff)"}</span>
          <BadgeList badges={cardBadges(m)} />
          {verdicts(m).length > 0 && (
            <span className="verdicts">
              {verdicts(m).map((v) => (
                <span key={v.key} className="verdict">
                  <strong>{v.text}</strong>
                  <span className="verdict-raw" title="Rohwert / Schwelle">{v.detail}</span>
                </span>
              ))}
            </span>
          )}
          {meta !== "" && <span className="meta">{meta}</span>}
        </span>
      </a>
    </li>
  );
}

export interface ReviewListProps {
  emails: ApiEmail[];
  view: ViewId;
  accounts: string[];
  account: string;
  now: Date;
  timeZone?: string;
  loading: boolean;
  error: string | null;
  canLoadMore: boolean;
  /** true once the API maximum (newest 200 mails) is loaded and the view cannot reach further back. */
  atApiLimit: boolean;
  onView?: (v: ViewId) => void;
  onAccount?: (a: string) => void;
  onReload?: () => void;
  onMore?: () => void;
  sentinelRef?: Ref<HTMLDivElement>;
}

const noop = (): void => {};

export function ReviewListView(p: ReviewListProps): React.JSX.Element {
  const visible = filterByView(p.emails, p.view, { now: p.now, timeZone: p.timeZone });
  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-row">
          <div className="title">
            <h1>Mails</h1>
            <p className="mode">Beobachtungsmodus · nur lesend</p>
          </div>
          <button type="button" className="btn btn-accent" onClick={p.onReload ?? noop} disabled={p.loading}>Neu laden</button>
        </div>
        <div className="segmented" role="group" aria-label="Ansicht">
          {availableViews().map((v) => (
            <button
              key={v}
              type="button"
              className="seg"
              aria-pressed={p.view === v}
              onClick={p.onView ? () => p.onView?.(v) : noop}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <select
          className="select"
          aria-label="Konto"
          value={p.account}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => (p.onAccount ?? noop)(e.target.value)}
        >
          <option value="">Alle Konten</option>
          {p.accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </header>
      {p.error !== null && (
        <div className="notice notice-error" role="alert">
          <p>{p.error}</p>
          <button type="button" className="btn" onClick={p.onReload ?? noop}>Erneut versuchen</button>
        </div>
      )}
      <main>
        {visible.length > 0 && (
          <ul className="cards">
            {visible.map((m) => (
              <EmailCard key={m.id} m={m} now={p.now} timeZone={p.timeZone} showAccount={p.account === ""} />
            ))}
          </ul>
        )}
        {visible.length === 0 && !p.loading && p.error === null && (
          <div className="empty">
            <p className="empty-icon" aria-hidden="true">✉</p>
            <p className="empty-title">{EMPTY_TITLE}</p>
            <p className="hint">{emptyText(p.view)}</p>
          </div>
        )}
        {p.loading && visible.length === 0 && (
          <ul className="cards skeletons" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <li key={i} className="skeleton" />)}
          </ul>
        )}
        {p.loading && <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>}
        {p.canLoadMore && !p.loading && (
          <button type="button" className="btn btn-wide" onClick={p.onMore ?? noop}>Mehr laden</button>
        )}
        {p.atApiLimit && (
          <p className="notice">Geladen sind die neuesten 200 Mails. Ältere folgen mit der Cursor-API.</p>
        )}
        <div ref={p.sentinelRef} aria-hidden="true" className="sentinel" />
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

export function EmailDetailView(
  { email: m, now, timeZone }: { email: ApiEmail; now: Date; timeZone?: string },
): React.JSX.Element {
  const a = m.classification?.answers ?? {};
  const classified = m.classification?.status === "classified";
  const imp = scoreLevel(a.importance?.value);
  const urg = scoreLevel(a.urgency?.value);
  const status = m.classification?.status ?? null;
  return (
    <div className="screen">
      <header className="bar">
        <a className="back" href="/"><span aria-hidden="true">‹</span> Liste</a>
      </header>
      <main className="detail">
        <h1 className="detail-subject">{m.subject || "(ohne Betreff)"}</h1>
        <p className="detail-from">{m.sender}</p>
        <p className="meta">
          {formatTime(m.received_at, now, timeZone)} · {m.account_id} · {locationText(m)}
        </p>

        <section className="panel" aria-label="Überblick">
          <h2>Überblick</h2>
          {classified ? (
            <dl className="facts">
              <dt>Kategorie</dt>
              <dd>{categoryLabel(a.category?.value)}</dd>
              <dt>Wichtigkeit</dt>
              <dd>{imp === null ? "-" : `Stufe ${imp} von 3: ${importanceText(imp)}`}</dd>
              <dt>Dringlichkeit</dt>
              <dd>{urg === null ? "-" : `Stufe ${urg} von 3: ${urgencyText(urg)}`}</dd>
            </dl>
          ) : (
            <p>
              {status === null ? "Nicht bewertet" : STATUS_LABEL[status] ?? "Nicht bewertet"}
              {m.classification?.failure_code ? ` (${m.classification.failure_code})` : ""}
            </p>
          )}
        </section>

        {m.disagreement !== null && (
          <section className="panel panel-warn" aria-label="Abweichung">
            <h2>Abweichung zum Provider</h2>
            <p>{DISAGREEMENT_LABEL[m.disagreement] ?? "Provider und Jev urteilen verschieden."}</p>
          </section>
        )}

        {m.shadow_quarantine && (
          <section className="panel" aria-label="Shadow">
            <h2>Shadow-Entscheidung</h2>
            <p>{m.shadow_quarantine.candidate ? "Spam-Kandidat" : "Kein Kandidat"}</p>
            <p className="hint">{shadowText(m.shadow_quarantine)}</p>
          </section>
        )}

        <section className="panel" aria-label="Jev-Antworten">
          <h2>Jev-Antworten</h2>
          {classified ? (
            <ul className="qas">{describeAnswers(a).map((i) => <AnswerBlock key={i.key} item={i} />)}</ul>
          ) : (
            <p>Noch keine Jev-Antworten vorhanden.</p>
          )}
        </section>
        <p className="hint foot">Beobachtungsmodus: Es wird nichts verschoben, gelöscht oder beantwortet.</p>
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
