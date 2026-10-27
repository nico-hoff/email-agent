'use client'

import { useEffect, useState } from 'react'
import { csrfMutationHeaders } from 'veryfront/index.client'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; login: string; csrfToken: string }
  | { kind: 'no_identity' }
  | { kind: 'not_allowed' }
  | { kind: 'error' }

const CSRF_HEADER = 'x-app-csrf'

// Public screen: shows who Tailscale says you are and trades that identity for a session cookie. It renders no mail data.
export default function Welcome(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) return setState({ kind: 'no_identity' })
        if (r.status === 403) return setState({ kind: 'not_allowed' })
        if (!r.ok) return setState({ kind: 'error' })
        const b = (await r.json()) as { login: string; csrfToken: string; signedIn: boolean }
        if (b.signedIn) {
          window.location.replace('/')
          return
        }
        setState({ kind: 'ready', login: b.login, csrfToken: b.csrfToken })
      })
      .catch(() => setState({ kind: 'error' }))
  }, [])

  async function login(csrfToken: string): Promise<void> {
    setBusy(true)
    setFailed(false)
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: csrfMutationHeaders('/api/auth/login', { headers: { [CSRF_HEADER]: csrfToken } }),
      })
      if (r.ok) {
        window.location.replace('/')
        return
      }
    } catch { /* shown below */ }
    setFailed(true)
    setBusy(false)
  }

  return (
    <main className="welcome">
      <img className="welcome-logo" src="/icon-192.png" alt="" width={72} height={72} />
      <h1>E-Mail-Agent</h1>
      <p className="welcome-sub">Dein ruhiger Blick auf die Mailbox. Nur lesend.</p>
      {state.kind === 'loading' && <p>Einen Moment ...</p>}
      {state.kind === 'ready' && (
        <>
          <p className="welcome-sub">Angemeldet als <strong>{state.login}</strong></p>
          <button type="button" disabled={busy} onClick={() => void login(state.csrfToken)}>Login</button>
          {failed && <p role="alert">Anmeldung fehlgeschlagen. Bitte neu laden und erneut versuchen.</p>}
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
