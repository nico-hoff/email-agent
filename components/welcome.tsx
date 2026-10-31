// Welcome screen (public). Presentation plus the small pure mappings from API answers to screen states, so every mode
// can be rendered in tests. It renders no mail data. The password lives only in the uncontrolled field until submit: it is
// handed to the callback once, the field is emptied, and nothing is written to any browser storage.
import { useRef, useState } from 'react'

export type WelcomeState =
  | { kind: 'loading' }
  | { kind: 'ready'; login: string; csrfToken: string }
  | { kind: 'password'; csrfToken: string }
  | { kind: 'users'; csrfToken: string }
  | { kind: 'misconfigured' }
  | { kind: 'signed_in' }
  | { kind: 'no_identity' }
  | { kind: 'not_allowed' }
  | { kind: 'error' }

export type LoginFailure = 'invalid' | 'rate_limited' | 'misconfigured' | 'failed'
export type RegisterFailure = 'invalid_invite' | 'invalid_email' | 'weak_password' | 'email_taken' | 'rate_limited' | 'failed'

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
  if (body.mode === 'users') {
    if (body.configured !== true) return { kind: 'misconfigured' }
    if (body.signedIn === true) return { kind: 'signed_in' }
    return typeof body.csrfToken === 'string' ? { kind: 'users', csrfToken: body.csrfToken } : { kind: 'error' }
  }
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

/** POST /api/auth/register (not ok) -> failure kind (the body carries the code) and seconds to wait. */
export function registerFailureFromResponse(status: number, code: unknown, retryAfter: string | null): { failure: RegisterFailure; waitSeconds: number } {
  if (status === 429) {
    const n = Number(retryAfter)
    return { failure: 'rate_limited', waitSeconds: Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60 }
  }
  if (code === 'invalid_invite' || code === 'invalid_email' || code === 'weak_password' || code === 'email_taken') return { failure: code, waitSeconds: 0 }
  return { failure: 'failed', waitSeconds: 0 }
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} Sekunden`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? '1 Minute' : `${minutes} Minuten`
}

function failureText(failure: LoginFailure, waitSeconds: number, usersMode = false): string {
  switch (failure) {
    case 'invalid':
      return usersMode ? 'E-Mail oder Passwort stimmt nicht.' : 'Das Passwort ist falsch.'
    case 'rate_limited':
      return `Zu viele Versuche. Bitte in ${waitText(waitSeconds)} noch einmal versuchen.`
    case 'misconfigured':
      return 'Server nicht korrekt konfiguriert. Bitte den Betreiber informieren.'
    default:
      return 'Anmeldung fehlgeschlagen. Bitte neu laden und erneut versuchen.'
  }
}

function registerFailureText(failure: RegisterFailure, waitSeconds: number): string {
  switch (failure) {
    case 'invalid_invite':
      return 'Der Einladungscode ist ungültig, abgelaufen oder schon benutzt.'
    case 'invalid_email':
      return 'Bitte eine gültige E-Mail-Adresse eingeben.'
    case 'weak_password':
      return 'Das Passwort braucht mindestens 12 Zeichen.'
    case 'email_taken':
      return 'Diese E-Mail-Adresse ist schon registriert.'
    case 'rate_limited':
      return `Zu viele Versuche. Bitte in ${waitText(waitSeconds)} noch einmal versuchen.`
    default:
      return 'Registrierung fehlgeschlagen. Bitte neu laden und erneut versuchen.'
  }
}

export interface UsersCredentials { email: string; password: string }
export interface RegisterCredentials extends UsersCredentials { code: string }

export interface WelcomeViewProps {
  state: WelcomeState
  busy: boolean
  failure: LoginFailure | null
  waitSeconds: number
  /** Tailnet / synthetic mode: the Login button. */
  onLogin: () => void
  /** Password mode: submit with the typed password. */
  onPassword: (password: string) => void
  /** Users mode: sign in with email and password. */
  onUsersLogin?: (c: UsersCredentials) => void
  /** Users mode: register with an invitation code. */
  onRegister?: (c: RegisterCredentials) => void
  registerFailure?: RegisterFailure | null
  /** Users mode: start on the registration form (tests, deep link). */
  initialRegister?: boolean
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

/** Users mode: login form and, behind a toggle, the registration form. Values live in uncontrolled fields until submit. */
function UsersForms(
  { busy, failure, registerFailure, waitSeconds, initialRegister, onUsersLogin, onRegister }: {
    busy: boolean
    failure: LoginFailure | null
    registerFailure: RegisterFailure | null
    waitSeconds: number
    initialRegister: boolean
    onUsersLogin: (c: UsersCredentials) => void
    onRegister: (c: RegisterCredentials) => void
  },
): React.JSX.Element {
  const [registering, setRegistering] = useState(initialRegister)
  const email = useRef<HTMLInputElement>(null)
  const password = useRef<HTMLInputElement>(null)
  const code = useRef<HTMLInputElement>(null)
  const take = (): UsersCredentials => {
    const c = { email: email.current?.value ?? '', password: password.current?.value ?? '' }
    if (password.current) password.current.value = ''
    return c
  }
  return (
    <>
      <form
        className="welcome-form"
        aria-label={registering ? 'Registrieren' : 'Anmelden'}
        onSubmit={(e) => {
          e.preventDefault()
          if (registering) {
            const value = code.current?.value ?? ''
            onRegister({ code: value, ...take() })
          } else {
            onUsersLogin(take())
          }
        }}
      >
        {registering && (
          <>
            <label className="welcome-label" htmlFor="invite-code">Einladungscode</label>
            <input ref={code} id="invite-code" name="code" type="text" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} required disabled={busy} />
          </>
        )}
        <label className="welcome-label" htmlFor="user-email">E-Mail</label>
        <input ref={email} id="user-email" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} />
        <label className="welcome-label" htmlFor="app-password">{registering ? 'Passwort (mindestens 12 Zeichen)' : 'Passwort'}</label>
        <input ref={password} id="app-password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 12 : undefined} required disabled={busy} />
        <button type="submit" disabled={busy}>{registering ? 'Registrieren' : 'Anmelden'}</button>
      </form>
      {!registering && failure !== null && <p role="alert">{failureText(failure, waitSeconds, true)}</p>}
      {registering && registerFailure !== null && <p role="alert">{registerFailureText(registerFailure, waitSeconds)}</p>}
      <button type="button" className="welcome-link" disabled={busy} onClick={() => setRegistering((r) => !r)}>
        {registering ? 'Zurück zur Anmeldung' : 'Mit Einladungscode registrieren'}
      </button>
    </>
  )
}

const noop = (): void => {}

export function WelcomeView({ state, busy, failure, waitSeconds, onLogin, onPassword, onUsersLogin, onRegister, registerFailure, initialRegister }: WelcomeViewProps): React.JSX.Element {
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
      {state.kind === 'users' && (
        <UsersForms
          busy={busy}
          failure={failure}
          registerFailure={registerFailure ?? null}
          waitSeconds={waitSeconds}
          initialRegister={initialRegister === true}
          onUsersLogin={onUsersLogin ?? noop}
          onRegister={onRegister ?? noop}
        />
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
