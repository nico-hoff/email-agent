// "Profil" (R1): sections for account, sessions and invitations (admin). Later milestones add sections (Konten,
// Einstellungen, Themen). Stateless: the page passes state and callbacks. Renders no mail data; an invite code is shown
// once, from state, and is never part of a list.
import { UndoToast } from "./review.tsx";
import { formatWhen, PROFILE_ERROR_TEXT, type CreatedInvite, type OpenInvite, type Profile, type ProfileReason } from "../lib/profile-client.ts";

const noop = (): void => {};

export interface ProfileViewProps {
  profile: Profile | null;
  invites: OpenInvite[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** The invitation that was just created (its code is visible until the page is left). */
  created: CreatedInvite | null;
  notice: { text: string; error?: boolean } | null;
  inviteRole: "user" | "admin";
  onInviteRole?: (role: "user" | "admin") => void;
  onCreateInvite?: () => void;
  onLogout?: () => void;
  onLogoutAll?: () => void;
  onReload?: () => void;
  onNoticeClose?: () => void;
  timeZone?: string;
}

export function reasonText(reason: ProfileReason): string {
  return PROFILE_ERROR_TEXT[reason];
}

function AccountSection({ profile }: { profile: Profile }): React.JSX.Element {
  return (
    <section className="panel" aria-label="Konto">
      <h2>Konto</h2>
      {profile.managed ? (
        <dl className="kv">
          <div><dt>E-Mail</dt><dd>{profile.email}</dd></div>
          <div><dt>Rolle</dt><dd>{profile.role === "admin" ? "Admin" : "Nutzer"}</dd></div>
        </dl>
      ) : (
        <p className="hint">Diese Installation läuft ohne Nutzerkonten (Zugang über Passwort oder Tailnet). Konten, Einladungen und die Abmeldung auf allen Geräten gibt es mit <code>AUTH_MODE=users</code>.</p>
      )}
    </section>
  );
}

function SessionSection({ profile, busy, onLogout, onLogoutAll }: Pick<ProfileViewProps, "busy" | "onLogout" | "onLogoutAll"> & { profile: Profile }): React.JSX.Element {
  return (
    <section className="panel" aria-label="Sitzungen">
      <h2>Sitzungen</h2>
      {profile.managed && typeof profile.live_sessions === "number" && (
        <p className="hint">{profile.live_sessions === 1 ? "1 aktive Sitzung" : `${profile.live_sessions} aktive Sitzungen`}</p>
      )}
      <div className="profile-actions">
        <button type="button" className="btn btn-wide" disabled={busy} onClick={onLogout ?? noop}>Abmelden</button>
        {profile.managed && (
          <button type="button" className="btn btn-wide" disabled={busy} onClick={onLogoutAll ?? noop}>Auf allen Geräten abmelden</button>
        )}
      </div>
    </section>
  );
}

function InviteSection(p: ProfileViewProps): React.JSX.Element {
  return (
    <section className="panel" aria-label="Einladungen">
      <h2>Einladungen</h2>
      <p className="hint">Registrierung geht nur mit einem Einladungscode. Er gilt einmal und läuft nach 7 Tagen ab.</p>
      <div className="choices" role="group" aria-label="Rolle der Einladung">
        {(["user", "admin"] as const).map((r) => (
          <button key={r} type="button" className="btn choice" aria-pressed={p.inviteRole === r} onClick={() => (p.onInviteRole ?? noop)(r)}>
            {r === "admin" ? "Admin" : "Nutzer"}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-accent btn-wide" disabled={p.busy} onClick={p.onCreateInvite ?? noop}>Einladung erstellen</button>
      {p.created !== null && (
        <div className="invite-new" role="status">
          <p className="hint">Dieser Code wird nur jetzt angezeigt. Bitte weitergeben, bevor du die Seite verlässt.</p>
          <p className="invite-code" data-testid="invite-code">{p.created.code}</p>
          <p className="hint">Gilt bis {formatWhen(p.created.expires_at, p.timeZone)} ({p.created.role === "admin" ? "Admin" : "Nutzer"})</p>
        </div>
      )}
      <h3 className="sub-h">Offene Einladungen</h3>
      {p.invites.length === 0 ? (
        <p className="hint">Keine offenen Einladungen.</p>
      ) : (
        <ul className="rules">
          {p.invites.map((i) => (
            <li key={i.id} className="rule">
              <span className="rule-main">
                <span className="rule-value">{i.role === "admin" ? "Admin" : "Nutzer"}</span>
                <span className="hint">erstellt {formatWhen(i.created_at, p.timeZone)}, läuft ab {formatWhen(i.expires_at, p.timeZone)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProfileView(p: ProfileViewProps): React.JSX.Element {
  return (
    <div className="screen">
      <header className="bar">
        <div className="bar-row">
          <a className="back" href="/"><span aria-hidden="true">‹</span> Mails</a>
          <button type="button" className="btn" onClick={p.onReload ?? noop} disabled={p.loading}>Neu laden</button>
        </div>
        <div className="title">
          <h1>Profil</h1>
          <p className="mode">Konto und Sitzungen</p>
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
        {p.profile !== null && (
          <>
            <AccountSection profile={p.profile} />
            <SessionSection profile={p.profile} busy={p.busy} onLogout={p.onLogout} onLogoutAll={p.onLogoutAll} />
            {p.profile.managed && p.profile.role === "admin" && <InviteSection {...p} />}
          </>
        )}
      </main>
      {p.notice !== null && <UndoToast text={p.notice.text} error={p.notice.error} onClose={p.onNoticeClose ?? noop} />}
    </div>
  );
}
