// Profile settings (R3): "Postfach-Aktionen" (Spam als gelesen markieren per account, Not-Aus, daily limit, last actions),
// "Klassifikationsmodell" (only with the permission) and "Berechtigungen" (admins). Stateless: the page passes data, the open
// dialog and callbacks. Shows switches, counts and model names only; nothing from a mail.
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { costText, MODE_LABEL, modeSummary, quarantineSummary, type SettingsAccount, type SettingsData, type SpamSeenMode } from "../lib/settings-client.ts";
import { formatWhen } from "../lib/profile-client.ts";

const noop = (): void => {};
const MODES: readonly SpamSeenMode[] = ["off", "dry_run", "live"];

export type SettingsConfirm =
  | { kind: "live"; accountId: string; label: string }
  | { kind: "qlive"; accountId: string; label: string; yolo: boolean }
  | { kind: "yolo"; accountId: string; label: string }
  | { kind: "global"; stopped: boolean }
  | null;

export interface SettingsSectionProps {
  data: SettingsData | null;
  busy: boolean;
  confirm: SettingsConfirm;
  timeZone?: string;
  onMode?: (accountId: string, mode: SpamSeenMode) => void;
  onQuarantineMode?: (accountId: string, mode: SpamSeenMode) => void;
  onQuarantineDays?: (accountId: string, days: number) => void;
  onYolo?: (accountId: string, on: boolean) => void;
  onUserStop?: (stopped: boolean) => void;
  onGlobalStop?: (stopped: boolean) => void;
  onConfirm?: () => void;
  onCancelConfirm?: () => void;
  onModel?: (model: string) => void;
  onChoice?: (userId: number, granted: boolean) => void;
}

function StopBlock(p: SettingsSectionProps & { data: SettingsData }): React.JSX.Element {
  const { stop } = p.data;
  const userStopped = stop.user_stopped_at !== null;
  return (
    <div className="stop-block" data-testid="stop-block">
      <h3 className="sub-h">Not-Aus</h3>
      {stop.global_active && (
        <p className="notice-inline notice-warn" role="status" data-testid="global-stop-active">
          Der globale Not-Aus ist aktiv (Datei <code>auto-actions.disabled</code> auf dem Server). Für alle Nutzer ist jede Aktion am Postfach angehalten, auch das Rückgängigmachen.
        </p>
      )}
      <p className="hint">
        {userStopped
          ? `Dein Not-Aus ist an (seit ${formatWhen(stop.user_stopped_at ?? "", p.timeZone)}). Die App markiert nichts und merkt nichts vor.`
          : "Der Not-Aus hält sofort alle Aktionen deiner Konten an: nichts wird markiert oder vorgemerkt. Die Einstellungen bleiben erhalten."}
      </p>
      <div className="profile-actions">
        {userStopped ? (
          <button type="button" className="btn btn-wide" disabled={p.busy} onClick={() => (p.onUserStop ?? noop)(false)}>Aktionen wieder erlauben</button>
        ) : (
          <button type="button" className="btn btn-wide btn-danger" disabled={p.busy} onClick={() => (p.onUserStop ?? noop)(true)}>Not-Aus einschalten</button>
        )}
        {stop.can_toggle_global && (
          <button type="button" className="btn btn-wide" disabled={p.busy} onClick={() => (p.onGlobalStop ?? noop)(!stop.global_active)}>
            {stop.global_active ? "Globalen Not-Aus aufheben (Admin)" : "Globalen Not-Aus einschalten (Admin)"}
          </button>
        )}
      </div>
    </div>
  );
}

const DAY_OPTIONS: readonly number[] = Array.from({ length: 90 }, (_, i) => i + 1);

/** "Spam in Quarantäne verschieben" (ADR 0025 Teil 2) with cleanup days and YOLO, per account. All switches default to off. */
function QuarantineBlock(p: SettingsSectionProps & { a: SettingsAccount }): React.JSX.Element | null {
  const { a } = p;
  const q = a.quarantine;
  if (q === null) return null;
  return (
    <div className="quarantine-block" data-testid="quarantine-block">
      <h3 className="sub-h">Spam in Quarantäne verschieben</h3>
      <div className="choices" role="group" aria-label={`Spam in Quarantäne verschieben für ${a.label}`}>
        {MODES.map((m) => (
          <button key={m} type="button" className="btn choice" aria-pressed={q.mode === m} disabled={p.busy} onClick={() => { if (q.mode !== m) (p.onQuarantineMode ?? noop)(a.id, m); }}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="hint" data-testid="quarantine-summary">{quarantineSummary(q)}</p>
      {q.mode !== "off" && (
        <>
          <label className="field" htmlFor={`days-${a.id}`}>
            <span className="field-label">Aufräumen nach</span>
            <select id={`days-${a.id}`} className="select" value={q.days} disabled={p.busy} data-testid="cleanup-days" onChange={(e) => (p.onQuarantineDays ?? noop)(a.id, Number(e.target.value))}>
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d === 1 ? "1 Tag" : `${d} Tage`}</option>)}
            </select>
          </label>
          <p className="hint">Nach dieser Frist wandern Mails aus der Quarantäne in den Papierkorb deines Anbieters. Endgültig gelöscht wird nie von der App.</p>
          <button type="button" className={`btn btn-wide${q.yolo ? " btn-danger" : ""}`} aria-pressed={q.yolo} disabled={p.busy} data-testid="yolo-toggle" onClick={() => (p.onYolo ?? noop)(a.id, !q.yolo)}>
            {q.yolo ? "YOLO ist an: Spam sofort in den Papierkorb" : "YOLO: Spam sofort in den Papierkorb"}
          </button>
          {q.yolo && <p className="hint hint-warn" role="status">Spam landet ohne Quarantäne im Papierkorb. Falsch erkannte Mails musst du dort selbst zurückholen oder hier mit „Rückgängig“.</p>}
        </>
      )}
    </div>
  );
}

function AccountRow(p: SettingsSectionProps & { data: SettingsData; a: SettingsAccount }): React.JSX.Element {
  const { a, data } = p;
  const limitReached = a.actions_24h >= data.daily_limit;
  return (
    <li className="acct-row" data-testid="settings-account-row">
      <div className="acct-head">
        <span className="acct-dot" style={{ background: a.color }} aria-hidden="true" />
        <span className="acct-name">{a.label}</span>
      </div>
      {a.managed ? (
        <>
          <div className="choices" role="group" aria-label={`Spam als gelesen markieren für ${a.label}`}>
            {MODES.map((m) => (
              <button key={m} type="button" className="btn choice" aria-pressed={a.spam_seen_mode === m} disabled={p.busy} onClick={() => { if (a.spam_seen_mode !== m) (p.onMode ?? noop)(a.id, m); }}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="hint" data-testid="mode-summary">{modeSummary(a.spam_seen_mode)}</p>
          <QuarantineBlock {...p} a={a} />
          <p className={`hint${limitReached ? " hint-warn" : ""}`} data-testid="daily-count">
            Heute {a.actions_24h} von {data.daily_limit} Aktionen (letzte 24 Stunden){limitReached ? ". Das Limit ist erreicht, weitere Mails warten." : "."}
          </p>
        </>
      ) : (
        <p className="hint">Keine gespeicherten Zugangsdaten (Demo-Konto). Hier lässt sich nichts einstellen.</p>
      )}
    </li>
  );
}

function ActionsSection(p: SettingsSectionProps & { data: SettingsData }): React.JSX.Element {
  const d = p.data;
  return (
    <section className="panel" aria-label="Postfach-Aktionen">
      <h2>Postfach-Aktionen</h2>
      <p className="hint">Standard ist <strong>Aus</strong>. „Spam als gelesen markieren“ setzt auf dem Mailserver nur das Merkmal „gelesen“ bei Mails, die als Spam erkannt wurden. Es wird nichts gelöscht, verschoben oder gesendet. Geschützt bleiben Sicherheits- und Systemmails sowie Absender auf deiner Positivliste.</p>
      {d.accounts.length === 0 ? <p className="hint">Noch kein Konto.</p> : (
        <ul className="acct-list">
          {d.accounts.map((a) => <AccountRow key={a.id} {...p} a={a} />)}
        </ul>
      )}
      <StopBlock {...p} />
      <p className="hint">Tageslimit: höchstens {d.daily_limit} Aktionen je Konto in 24 Stunden (rollierend).</p>
      <a className="btn btn-wide" href="/aussortiert" data-testid="actions-link">Letzte Aktionen ansehen</a>
    </section>
  );
}

function ModelSection(p: SettingsSectionProps & { data: SettingsData }): React.JSX.Element | null {
  const c = p.data.classifier;
  if (!c.permitted) return null;
  return (
    <section className="panel" aria-label="Klassifikationsmodell">
      <h2>Klassifikationsmodell</h2>
      <p className="hint">Welches Modell neue Mails bewertet. Bereits bewertete Mails bleiben unverändert. Gilt für alle deine Konten.</p>
      <ul className="model-list">
        {c.models.map((m) => (
          <li key={m.id} className="model-row" data-testid="model-row">
            <button type="button" className="btn choice" aria-pressed={c.model === m.id} disabled={p.busy || !m.selectable} onClick={() => { if (c.model !== m.id) (p.onModel ?? noop)(m.id); }}>
              {m.label}
            </button>
            <p className="hint">{m.description}</p>
            <p className="hint">{costText(m)}</p>
            {!m.selectable && <p className="hint hint-warn">Noch nicht kalibriert: nicht wählbar.</p>}
          </li>
        ))}
      </ul>
      <p className="hint">Preise aus dem Vergleichslauf mit synthetischen Mails; echte Kosten können abweichen.</p>
    </section>
  );
}

function PermissionsSection(p: SettingsSectionProps & { data: SettingsData }): React.JSX.Element | null {
  const members = p.data.members;
  if (members === null) return null;
  return (
    <section className="panel" aria-label="Berechtigungen">
      <h2>Berechtigungen</h2>
      <p className="hint">„Modellwahl“ erlaubt einer Person, ihr Klassifikationsmodell selbst zu wählen. Standard ist aus; ohne Berechtigung wird Jev verwendet.</p>
      <ul className="rules">
        {members.map((m) => (
          <li key={m.id} className="rule" data-testid="member-row">
            <span className="rule-main">
              <span className="rule-value">{m.email ?? "Eigentümer (noch nicht angemeldet)"}</span>
              <span className="hint">{m.role === "admin" ? "Admin" : "Nutzer"}</span>
            </span>
            <button type="button" className="btn" aria-pressed={m.classifier_choice} disabled={p.busy} onClick={() => (p.onChoice ?? noop)(m.id, !m.classifier_choice)}>
              {m.classifier_choice ? "Modellwahl: an" : "Modellwahl: aus"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dialogs(p: SettingsSectionProps): React.JSX.Element | null {
  const c = p.confirm;
  if (c === null) return null;
  if (c.kind === "live") {
    return (
      <ConfirmDialog title="Spam auf dem Server als gelesen markieren?" confirmLabel="Ja, einschalten" danger busy={p.busy} onConfirm={p.onConfirm} onCancel={p.onCancelConfirm}>
        <p>Für <strong>{c.label}</strong> verbindet sich die App danach mit dem Mailserver und ändert dort Mails.</p>
        <ul className="dialog-list">
          <li>Es wird nur das Merkmal „gelesen“ gesetzt, bei Mails, die als Spam erkannt wurden. Nichts wird gelöscht, verschoben oder gesendet.</li>
          <li>Du kannst jede Mail in der Liste wieder auf „ungelesen“ stellen; das wirkt ebenfalls auf dem Server.</li>
          <li>Höchstens {p.data?.daily_limit ?? 200} Aktionen je Konto in 24 Stunden.</li>
          <li>Sicherheits- und Systemmails und Absender auf deiner Positivliste bleiben unberührt.</li>
          <li>Der Not-Aus hält alles sofort an. Empfohlen: erst einige Tage im Trockenlauf prüfen.</li>
        </ul>
      </ConfirmDialog>
    );
  }
  if (c.kind === "qlive") {
    return (
      <ConfirmDialog title="Spam in Quarantäne verschieben?" confirmLabel="Ja, einschalten" danger busy={p.busy} onConfirm={p.onConfirm} onCancel={p.onCancelConfirm}>
        <p>Für <strong>{c.label}</strong> verbindet sich die App danach mit dem Mailserver und <strong>verschiebt</strong> Mails dort.</p>
        <ul className="dialog-list">
          <li>{c.yolo
            ? "YOLO ist an: Spam wird sofort in den Papierkorb des Anbieters verschoben, ohne Quarantäne."
            : "Als Spam erkannte Mails aus dem Posteingang werden in den Ordner „Quarantäne“ verschoben. Der Ordner wird bei Bedarf angelegt."}</li>
          <li>Nach der eingestellten Frist (Standard 14 Tage) wandert die Mail aus der Quarantäne in den Papierkorb. Die App löscht nie endgültig und sendet nichts.</li>
          <li>Unter „Letzte Aktionen“ kannst du jede Verschiebung zurück in den Posteingang holen.</li>
          <li>Höchstens {p.data?.daily_limit ?? 200} Aktionen je Konto in 24 Stunden. Sicherheits- und Systemmails und Absender auf deiner Positivliste bleiben unberührt.</li>
          <li>Der Not-Aus hält alles sofort an. Empfohlen: erst einige Tage im Trockenlauf prüfen.</li>
        </ul>
      </ConfirmDialog>
    );
  }
  if (c.kind === "yolo") {
    return (
      <ConfirmDialog title="YOLO wirklich einschalten?" confirmLabel="Ja, YOLO einschalten" danger busy={p.busy} onConfirm={p.onConfirm} onCancel={p.onCancelConfirm}>
        <p className="hint-warn"><strong>Achtung: Für {c.label} wird Spam ohne Zwischenstation in den Papierkorb verschoben.</strong></p>
        <ul className="dialog-list">
          <li>Es gibt keine Quarantäne und keine Frist. Eine falsch erkannte Mail liegt sofort im Papierkorb, auch eine wichtige.</li>
          <li>Wann der Anbieter den Papierkorb leert, bestimmt der Anbieter, nicht die App. Danach ist die Mail weg.</li>
          <li>Du kannst eine Mail unter „Letzte Aktionen“ zurück in den Posteingang holen, solange sie im Papierkorb liegt.</li>
          <li>Die Schutzregeln (Sicherheits- und Systemmails, Positivliste), das Tageslimit und der Not-Aus gelten weiter.</li>
          <li>Empfohlen: erst Quarantäne mit Frist nutzen und die Treffer prüfen.</li>
        </ul>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      title={c.stopped ? "Globalen Not-Aus einschalten?" : "Globalen Not-Aus aufheben?"}
      confirmLabel={c.stopped ? "Ja, anhalten" : "Ja, aufheben"}
      danger={c.stopped}
      busy={p.busy}
      onConfirm={p.onConfirm}
      onCancel={p.onCancelConfirm}
    >
      <p>{c.stopped
        ? "Das hält die Aktionen am Postfach für alle Nutzer an, auch das Rückgängigmachen. Mails werden weiter gelesen und bewertet."
        : "Danach dürfen die Aktionen der Nutzer wieder laufen, soweit sie nicht selbst ihren Not-Aus eingeschaltet haben."}</p>
    </ConfirmDialog>
  );
}

export function SettingsSections(p: SettingsSectionProps): React.JSX.Element | null {
  if (p.data === null) return null;
  const d = p.data;
  return (
    <>
      <ActionsSection {...p} data={d} />
      <ModelSection {...p} data={d} />
      <PermissionsSection {...p} data={d} />
      <Dialogs {...p} />
    </>
  );
}
