// "Konten verwalten" (R2): the section of the profile page that lists, adds, edits, tests and disables mailboxes.
// Stateless: the page passes data, the open form and callbacks. The password field is never prefilled and no secret is ever
// rendered; the list shows only whether a password is stored and since when.
import { ACCOUNTS_ERROR_TEXT, COLOR_CHOICES, formType, GOOGLE_DEFAULTS, TEST_RESULT_TEXT, workerText, type AccountForm, type AccountItem, type AccountsData } from "../lib/accounts-client.ts";
import { hostPlaceholder } from "../lib/mail-provider-hints.ts";
import { formatWhen } from "../lib/profile-client.ts";

const noop = (): void => {};

export interface AccountEditor {
  /** null = a new account. */
  id: string | null;
  form: AccountForm;
}

export interface AccountsSectionProps {
  data: AccountsData | null;
  editor: AccountEditor | null;
  busy: boolean;
  /** Result code of the last connection test per account id (this page visit). */
  testing: string | null;
  testResults: Record<string, string>;
  formError: string | null;
  timeZone?: string;
  onAdd?: () => void;
  onEdit?: (a: AccountItem) => void;
  onForm?: (patch: Partial<Omit<AccountForm, "touched">>) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onTest?: (id: string) => void;
  onEnabled?: (id: string, enabled: boolean) => void;
}

export function testText(code: string): string {
  return TEST_RESULT_TEXT[code] ?? TEST_RESULT_TEXT.connect_failed ?? "";
}

export function accountsErrorText(reason: keyof typeof ACCOUNTS_ERROR_TEXT): string {
  return ACCOUNTS_ERROR_TEXT[reason];
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && <p className="hint">{hint}</p>}
    </div>
  );
}

function Editor(p: AccountsSectionProps & { editor: AccountEditor }): React.JSX.Element {
  const f = p.editor.form;
  const creating = p.editor.id === null;
  const google = formType(f) === "google";
  const set = p.onForm ?? noop;
  return (
    <form className="acct-form" aria-label={creating ? "Konto hinzufügen" : "Konto bearbeiten"} onSubmit={(e) => { e.preventDefault(); (p.onSave ?? noop)(); }}>
      <h3 className="sub-h">{creating ? "Konto hinzufügen" : "Konto bearbeiten"}</h3>
      <Field id="acct-email" label="E-Mail-Adresse">
        <input id="acct-email" type="email" className="input" value={f.email} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="email" onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field
        id="acct-pass"
        label={google ? "App-Passwort" : "IMAP-Passwort"}
        hint={creating ? "Wird verschlüsselt gespeichert und nie wieder angezeigt." : "Leer lassen, um das gespeicherte Passwort zu behalten."}
      >
        <input id="acct-pass" type="password" className="input" value={f.password} autoComplete="new-password" onChange={(e) => set({ password: e.target.value })} />
      </Field>
      {google && (
        <p className="hint hint-info" role="note">Für Gmail braucht es ein App-Passwort (16 Zeichen), nicht das normale Passwort. Es gibt es unter Google-Konto, Sicherheit, Bestätigung in zwei Schritten, App-Passwörter. Leerzeichen sind egal.</p>
      )}
      <Field id="acct-host" label="IMAP-Server" hint={google ? `Gmail erkannt: ${GOOGLE_DEFAULTS.host}, Port ${GOOGLE_DEFAULTS.port}, TLS an.` : undefined}>
        <input id="acct-host" type="text" className="input" value={f.host} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={hostPlaceholder(f.email)} onChange={(e) => set({ host: e.target.value })} />
      </Field>
      <details className="acct-advanced">
        <summary>Erweitert</summary>
        <div className="acct-advanced-body">
          <Field id="acct-label" label="Bezeichnung" hint="Kurzer Name auf den Mail-Karten. Standard: die E-Mail-Adresse.">
            <input id="acct-label" type="text" className="input" value={f.label} maxLength={40} autoComplete="off" onChange={(e) => set({ label: e.target.value })} />
          </Field>
          <div className="field">
            <span className="field-label" id="acct-color-label">Farbe</span>
            <div className="swatches" role="group" aria-labelledby="acct-color-label">
              {COLOR_CHOICES.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Farbe ${c}`} aria-pressed={f.color === c} onClick={() => set({ color: f.color === c ? null : c })} />
              ))}
            </div>
          </div>
          <Field id="acct-user" label="Benutzername" hint="Standard: die E-Mail-Adresse.">
            <input id="acct-user" type="text" className="input" value={f.username} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ username: e.target.value })} />
          </Field>
          {!google && (
            <>
              <div className="field-row">
                <Field id="acct-port" label="Port">
                  <input id="acct-port" type="text" className="input" inputMode="numeric" value={f.port} onChange={(e) => set({ port: e.target.value })} />
                </Field>
                <div className="field">
                  <span className="field-label" id="acct-tls-label">Verschlüsselung</span>
                  <div className="choices" role="group" aria-labelledby="acct-tls-label">
                    <button type="button" className="btn choice" aria-pressed={f.tls} onClick={() => set({ tls: true })}>TLS</button>
                    <button type="button" className="btn choice" aria-pressed={!f.tls} onClick={() => set({ tls: false })}>Aus</button>
                  </div>
                </div>
              </div>
              {!f.tls && <p className="hint hint-warn">Ohne TLS wird das Passwort womöglich unverschlüsselt übertragen. Nur im eigenen Netz verwenden.</p>}
            </>
          )}
          <Field id="acct-box" label="Ordner Posteingang">
            <input id="acct-box" type="text" className="input" value={f.mailbox} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ mailbox: e.target.value })} />
          </Field>
          <Field id="acct-spam" label="Ordner Spam" hint={google ? "Standard: [Gmail]/Spam." : "Leer = wird bei „Verbindung testen“ erkannt (Junk-Ordner des Servers)."}>
            <input id="acct-spam" type="text" className="input" value={f.spam_mailbox} placeholder={google ? GOOGLE_DEFAULTS.spam_mailbox : "automatisch"} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ spam_mailbox: e.target.value })} />
          </Field>
          <Field id="acct-context" label="Kontext (optional)" hint="Ein, zwei Sätze, die der Bewertung helfen: wofür dieses Postfach gedacht ist. Keine Mailinhalte.">
            <textarea id="acct-context" className="input textarea" rows={3} maxLength={1000} value={f.context} onChange={(e) => set({ context: e.target.value })} />
          </Field>
        </div>
      </details>
      {p.formError !== null && <p className="notice notice-error" role="alert">{p.formError}</p>}
      <div className="profile-actions">
        <button type="submit" className="btn btn-accent btn-wide" disabled={p.busy}>{creating ? "Konto speichern" : "Änderungen speichern"}</button>
        <button type="button" className="btn btn-wide" disabled={p.busy} onClick={p.onCancel ?? noop}>Abbrechen</button>
      </div>
    </form>
  );
}

function TestBadge({ a, result, tz }: { a: AccountItem; result: string | undefined; tz: string | undefined }): React.JSX.Element | null {
  const code = result ?? a.last_test_code;
  if (code === null || code === undefined || code === "synthetic_no_network") return null;
  const ok = code === "ok";
  return (
    <span className={`badge ${ok ? "badge-good" : "badge-warn"}`} data-testid="test-badge">
      {ok ? "Test ok" : "Test fehlgeschlagen"}
      {result === undefined && a.last_test_at !== null ? ` (${formatWhen(a.last_test_at, tz)})` : ""}
    </span>
  );
}

function Row(p: AccountsSectionProps & { a: AccountItem }): React.JSX.Element {
  const { a } = p;
  const result = p.testResults[a.id];
  return (
    <li className="acct-row" data-testid="acct-row">
      <div className="acct-head">
        <span className="acct-dot" style={{ background: a.color }} aria-hidden="true" />
        <span className="acct-name">{a.label}</span>
        <span className="badge badge-neutral">{a.type === "google" ? "Google" : a.type === "imap" ? "IMAP" : "Demo"}</span>
      </div>
      <div className="badges">
        <span className={`badge ${a.enabled && a.worker?.state === "connected" ? "badge-good" : a.enabled && a.worker?.state === "paused" ? "badge-warn" : "badge-neutral"}`}>{workerText(a)}</span>
        <TestBadge a={a} result={result} tz={p.timeZone} />
      </div>
      {a.managed && <p className="hint">{a.username} · {a.host}:{a.port}{a.secret_set_at !== null ? ` · Passwort gespeichert seit ${formatWhen(a.secret_set_at, p.timeZone)}` : ""}</p>}
      {!a.managed && <p className="hint">Keine gespeicherten Zugangsdaten. Dieses Konto lässt sich hier nur ansehen.</p>}
      {result !== undefined && <p className={result === "ok" || result === "synthetic_no_network" ? "hint hint-info" : "notice notice-inline notice-error"} role="status" data-testid="test-result">{testText(result)}</p>}
      {a.managed && (
        <div className="acct-actions">
          <button type="button" className="btn" disabled={p.busy || p.testing !== null} onClick={() => (p.onTest ?? noop)(a.id)}>
            {p.testing === a.id ? "Teste …" : "Verbindung testen"}
          </button>
          <button type="button" className="btn" disabled={p.busy} onClick={() => (p.onEdit ?? noop)(a)}>Bearbeiten</button>
          <button type="button" className="btn" disabled={p.busy} onClick={() => (p.onEnabled ?? noop)(a.id, !a.enabled)}>{a.enabled ? "Deaktivieren" : "Aktivieren"}</button>
        </div>
      )}
    </li>
  );
}

export function AccountsSection(p: AccountsSectionProps): React.JSX.Element {
  const d = p.data;
  return (
    <section className="panel" aria-label="Konten verwalten">
      <h2>Konten verwalten</h2>
      {d !== null && !d.encryptionReady && (
        <div className="notice notice-error" role="alert">
          <p>Auf dem Server ist kein Schlüssel für Passwörter eingerichtet (<code>ACCOUNTS_ENCRYPTION_KEY</code>). Solange er fehlt, laufen keine Postfächer und neue Konten lassen sich nicht speichern.</p>
        </div>
      )}
      {d !== null && d.accounts.length === 0 && p.editor === null && <p className="hint">Noch kein Konto. Mit „Konto hinzufügen“ geht es los.</p>}
      {d !== null && d.accounts.length > 0 && (
        <ul className="acct-list">
          {d.accounts.map((a) => <Row key={a.id} {...p} a={a} />)}
        </ul>
      )}
      {p.editor !== null ? (
        <Editor {...p} editor={p.editor} />
      ) : (
        <button type="button" className="btn btn-accent btn-wide" disabled={p.busy || d === null || !d.encryptionReady} onClick={p.onAdd ?? noop}>Konto hinzufügen</button>
      )}
      <p className="hint">Änderungen wirken nach wenigen Sekunden. Die App liest Mails nur; Passwörter verlassen den Server nie.</p>
    </section>
  );
}
