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
      <style>{CSS}</style>
      <h1>E-Mail-Agent</h1>
      {state.kind === 'loading' && <p>Einen Moment ...</p>}
      {state.kind === 'ready' && (
        <>
          <p>Angemeldet als <strong>{state.login}</strong></p>
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

const CSS = `
.welcome{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:2rem 1rem;text-align:center;font-family:system-ui,sans-serif;background:#fff;color:#111}
.welcome h1{font-size:1.5rem;margin:0}
.welcome p{margin:0;max-width:28rem}
.welcome button{min-width:12rem;min-height:48px;padding:0 1.5rem;font-size:1.125rem;border-radius:12px;border:0;background:#0a58ca;color:#fff;cursor:pointer}
.welcome button:disabled{opacity:.6}
@media (prefers-color-scheme:dark){.welcome{background:#0b0f14;color:#e8edf2}.welcome button{background:#4c8dff;color:#0b0f14}}
`
