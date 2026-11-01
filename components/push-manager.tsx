// Profile → Benachrichtigungen (R6, ADR 0027/0036): per-device Web Push. Stateless: the page passes the state and callbacks.
// The permission prompt is requested only by the tap on "Auf diesem Gerät aktivieren" (the page calls enablePush from that
// handler). A push never carries a subject, sender or text; the device learns only kind and count.
import { formatWhen } from "../lib/profile-client.ts";
import type { PushDevice, PushKindName, PushKinds } from "../lib/push-client.ts";
import { kindsSummary, REASON_TEXT, type PushSectionState } from "../lib/push-section.ts";

const noop = (): void => {};

export interface PushSectionProps {
  state: PushSectionState;
  /** Why the server is unavailable (code from GET /api/push/config), if known. */
  reason?: string | null;
  devices: PushDevice[];
  /** The entry of `devices` that is this browser, if any. */
  thisDeviceId: number | null;
  /** Kinds of this device (switches); only meaningful in state "on". */
  kinds: PushKinds;
  busy: boolean;
  maxDevices?: number;
  timeZone?: string;
  /** Result of the last "Test senden" or other action, shown inline. */
  message?: { text: string; error?: boolean } | null;
  onEnable?: () => void;
  onDisable?: () => void;
  onKind?: (kind: PushKindName, on: boolean) => void;
  onTest?: () => void;
  onRemove?: (id: number) => void;
}

const KIND_ROWS: readonly { kind: PushKindName; label: string; hint: string }[] = [
  { kind: "important_mail", label: "Wichtige Mail", hint: "Eine kurze Meldung, wenn neue wichtige Mails da sind (höchstens eine je 10 Minuten)." },
  { kind: "briefing_ready", label: "Briefing bereit", hint: "Morgens ab 7:30 Uhr, wenn Mails offen sind." },
];

function StateBlock(p: PushSectionProps): React.JSX.Element | null {
  switch (p.state) {
    case "loading":
      return <p className="notice" role="status"><span className="spinner" aria-hidden="true" />Lädt …</p>;
    case "server_unavailable":
      return (
        <div data-testid="push-unavailable">
          <p className="notice-inline notice-warn" role="status">
            Benachrichtigungen sind noch nicht eingerichtet: Der Server hat noch keine Push-Schlüssel (VAPID). Sobald sie eingetragen sind, kannst du sie hier einschalten.
          </p>
          {p.reason != null && REASON_TEXT.has(p.reason) && <p className="hint">{REASON_TEXT.get(p.reason)}</p>}
        </div>
      );
    case "unsupported":
      return <p className="notice-inline notice-warn" role="status" data-testid="push-unsupported">Dieser Browser unterstützt keine Benachrichtigungen. Auf dem iPhone brauchst du iOS 16.4 oder neuer und die App auf dem Home-Bildschirm.</p>;
    case "needs_install":
      return (
        <div data-testid="push-install">
          <p className="notice-inline notice-warn" role="status">Auf dem iPhone und iPad funktionieren Benachrichtigungen nur in der installierten App.</p>
          <ol className="hint-steps">
            <li>In Safari auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.</li>
            <li>Die App <strong>vom Home-Bildschirm</strong> öffnen (nicht in Safari).</li>
            <li>Hier unter Profil → Benachrichtigungen aktivieren.</li>
          </ol>
        </div>
      );
    case "permission_denied":
      return <p className="notice-inline notice-warn" role="status" data-testid="push-denied">Benachrichtigungen sind für diese App blockiert. Erlaube sie in den Einstellungen des Geräts (iPhone: Einstellungen → Mitteilungen → diese App) und öffne die Seite danach neu.</p>;
    case "off":
      return (
        <>
          <p className="hint">Die Systemabfrage „Mitteilungen erlauben“ erscheint erst, wenn du unten tippst.</p>
          <button type="button" className="btn btn-accent btn-wide" disabled={p.busy} onClick={p.onEnable ?? noop}>Auf diesem Gerät aktivieren</button>
        </>
      );
    case "on":
      return (
        <>
          <p className="hint" data-testid="push-on">Benachrichtigungen sind auf diesem Gerät an.</p>
          <div className="switches" role="group" aria-label="Benachrichtigungsarten">
            {KIND_ROWS.map((k) => (
              <div key={k.kind} className="switch-row">
                <span className="rule-main">
                  <span className="rule-value">{k.label}</span>
                  <span className="hint">{k.hint}</span>
                </span>
                <button type="button" className="btn" aria-pressed={p.kinds[k.kind]} disabled={p.busy} data-testid={`kind-${k.kind}`} onClick={() => (p.onKind ?? noop)(k.kind, !p.kinds[k.kind])}>
                  {p.kinds[k.kind] ? "An" : "Aus"}
                </button>
              </div>
            ))}
          </div>
          <div className="profile-actions">
            <button type="button" className="btn btn-wide" disabled={p.busy} onClick={p.onTest ?? noop}>Test senden</button>
            <button type="button" className="btn btn-wide" disabled={p.busy} onClick={p.onDisable ?? noop}>Auf diesem Gerät ausschalten</button>
          </div>
          <p className="hint">„Test senden“ geht an alle deine angemeldeten Geräte.</p>
        </>
      );
  }
}

function Devices(p: PushSectionProps): React.JSX.Element | null {
  if (p.state === "loading" || p.state === "server_unavailable") return null;
  return (
    <>
      <h3 className="sub-h">Meine Geräte</h3>
      {p.devices.length === 0 ? <p className="hint" data-testid="no-devices">Noch kein Gerät angemeldet.</p> : (
        <ul className="rules" data-testid="push-devices">
          {p.devices.map((d) => {
            const here = d.id === p.thisDeviceId;
            return (
              <li key={d.id} className="device-row" data-testid="push-device">
                <div className="device-head">
                  <span className="rule-value">{d.agent_family}{here ? " (dieses Gerät)" : ""}</span>
                  <button type="button" className="btn" disabled={p.busy} aria-label={`Gerät entfernen: ${d.agent_family}`} onClick={() => (p.onRemove ?? noop)(d.id)}>Entfernen</button>
                </div>
                <span className="hint">Seit {formatWhen(d.created_at, p.timeZone)}</span>
                <span className="hint">{(d.last_success_at === null ? "Noch keine Zustellung" : `Letzte Zustellung ${formatWhen(d.last_success_at, p.timeZone)}`) + (d.failing ? ". Zuletzt fehlgeschlagen." : ".")}</span>
                <span className="hint">{kindsSummary(d)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {p.maxDevices !== undefined && <p className="hint">Höchstens {p.maxDevices} Geräte.</p>}
    </>
  );
}

export function PushSection(p: PushSectionProps): React.JSX.Element {
  return (
    <section className="panel" aria-label="Benachrichtigungen">
      <h2>Benachrichtigungen</h2>
      <p className="hint">Eine kurze Meldung aufs Gerät, wenn etwas Wichtiges da ist. Sie enthält nie Betreff, Absender oder Text, nur die Art und die Anzahl.</p>
      <StateBlock {...p} />
      {p.message != null && <p className={p.message.error ? "notice-inline" : "hint"} role={p.message.error ? "alert" : "status"} data-testid="push-message">{p.message.text}</p>}
      <Devices {...p} />
    </section>
  );
}
