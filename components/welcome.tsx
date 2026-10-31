// Welcome screen (public). Presentation plus the small pure mappings from API answers to screen states, so every mode
// can be rendered in tests. It renders no mail data. The password lives only in the uncontrolled field until submit: it is
// handed to the callback once, the field is emptied, and nothing is written to any browser storage.
import { useRef } from 'react'

export type WelcomeState =
  | { kind: 'loading' }
  | { kind: 'ready'; login: string; csrfToken: string }
  | { kind: 'password'; csrfToken: string }
  | { kind: 'misconfigured' }
  | { kind: 'signed_in' }
  | { kind: 'no_identity' }
  | { kind: 'not_allowed' }
  | { kind: 'error' }

export type LoginFailure = 'invalid' | 'rate_limited' | 'misconfigured' | 'failed'

export interface SessionBody {
  error?: string
  mode?: string
  configured?: boolean
  login?: string
  csrfToken?: string
  signedIn?: boolean
}

/** GET /api/auth/session -> screen state. Password mode never carries a login. */
export function welcomeStateFromSession(status: number, body: SessionBody): WelcomeState {
  if (status === 401) return { kind: 'no_identity' }
  if (status === 403) return { kind: 'not_allowed' }
  if (status !== 200) return { kind: 'error' }
  if (body.mode === 'password') {
    if (body.configured !== true) return { kind: 'misconfigured' }
    if (body.signedIn === true) return { kind: 'signed_in' }
    return typeof body.csrfToken === 'string' ? { kind: 'password', csrfToken: body.csrfToken } : { kind: 'error' }
  }
  if (body.signedIn === true) return { kind: 'signed_in' }
  if (typeof body.login !== 'string' || typeof body.csrfToken !== 'string') return { kind: 'error' }
  return { kind: 'ready', login: body.login, csrfToken: body.csrfToken }
}

/** POST /api/auth/login (not ok) -> failure kind and seconds to wait. */
export function loginFailureFromResponse(status: number, retryAfter: string | null): { failure: LoginFailure; waitSeconds: number } {
  if (status === 401) return { failure: 'invalid', waitSeconds: 0 }
  if (status === 429) {
    const n = Number(retryAfter)
    return { failure: 'rate_limited', waitSeconds: Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60 }
  }
  if (status === 503) return { failure: 'misconfigured', waitSeconds: 0 }
  return { failure: 'failed', waitSeconds: 0 }
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} Sekunden`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? '1 Minute' : `${minutes} Minuten`
}

function failureText(failure: LoginFailure, waitSeconds: number): string {
  switch (failure) {
    case 'invalid':
      return 'Das Passwort ist falsch.'
    case 'rate_limited':
      return `Zu viele Versuche. Bitte in ${waitText(waitSeconds)} noch einmal versuchen.`
    case 'misconfigured':
      return 'Server nicht korrekt konfiguriert. Bitte den Betreiber informieren.'
    default:
      return 'Anmeldung fehlgeschlagen. Bitte neu laden und erneut versuchen.'
  }
}

export interface WelcomeViewProps {
  state: WelcomeState
  busy: boolean
  failure: LoginFailure | null
  waitSeconds: number
  /** Tailnet / synthetic mode: the Login button. */
  onLogin: () => void
  /** Password mode: submit with the typed password. */
  onPassword: (password: string) => void
}

function PasswordForm({ busy, onPassword }: { busy: boolean; onPassword: (password: string) => void }): React.JSX.Element {
  const field = useRef<HTMLInputElement>(null)
  return (
    <form
      className="welcome-form"
      onSubmit={(e) => {
        e.preventDefault()
        const password = field.current?.value ?? ''
        if (field.current) field.current.value = ''
        onPassword(password)
      }}
    >
      <label className="welcome-label" htmlFor="app-password">Passwort</label>
      <input
        ref={field}
        id="app-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        disabled={busy}
      />
      <button type="submit" disabled={busy}>Anmelden</button>
    </form>
  )
}

export function WelcomeView({ state, busy, failure, waitSeconds, onLogin, onPassword }: WelcomeViewProps): React.JSX.Element {
  return (
    <main className="welcome">
      <img className="welcome-logo" src="/icon-192.png" alt="" width={72} height={72} />
      <h1>E-Mail-Agent</h1>
      <p className="welcome-sub">Dein ruhiger Blick auf die Mailbox. Nur lesend.</p>
      {state.kind === 'loading' && <p>Einen Moment ...</p>}
      {state.kind === 'signed_in' && <p>Du bist angemeldet.</p>}
      {state.kind === 'password' && (
        <>
          <PasswordForm busy={busy} onPassword={onPassword} />
          {failure !== null && <p role="alert">{failureText(failure, waitSeconds)}</p>}
        </>
      )}
      {state.kind === 'misconfigured' && <p role="alert">{failureText('misconfigured', 0)}</p>}
      {state.kind === 'ready' && (
        <>
          <p className="welcome-sub">Angemeldet als <strong>{state.login}</strong></p>
          <button type="button" disabled={busy} onClick={onLogin}>Login</button>
          {failure !== null && <p role="alert">Anmeldung fehlgeschlagen. Bitte neu laden und erneut versuchen.</p>}
        </>
      )}
      {state.kind === 'no_identity' && (
        <p role="alert">Keine Tailnet-Identit&auml;t erkannt. Bitte die App &uuml;ber die Tailscale-Adresse (HTTPS) &ouml;ffnen, w&auml;hrend das Ger&auml;t im Tailnet ist.</p>
      )}
      {state.kind === 'not_allowed' && (
        <p role="alert">Diese Tailnet-Identit&auml;t ist nicht freigegeben.</p>
      )}
      {state.kind === 'error' && <p role="alert">Die Anmeldung ist derzeit nicht verf&uuml;gbar.</p>}
    </main>
  )
}
