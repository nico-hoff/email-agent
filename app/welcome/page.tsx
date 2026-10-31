'use client'

import { useEffect, useState } from 'react'
import { csrfMutationHeaders } from 'veryfront/index.client'
import { loginFailureFromResponse, WelcomeView, welcomeStateFromSession, type LoginFailure, type WelcomeState } from '../../components/welcome.tsx'

const CSRF_HEADER = 'x-app-csrf'

// Public screen. Tailnet/synthetic mode: shows who Tailscale (or the dev mode) says you are and trades that for a session
// cookie. Password mode (public host): asks for the password. It renders no mail data and stores nothing in the browser.
export default function Welcome(): React.JSX.Element {
  const [state, setState] = useState<WelcomeState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<LoginFailure | null>(null)
  const [waitSeconds, setWaitSeconds] = useState(0)

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Parameters<typeof welcomeStateFromSession>[1]
        const next = welcomeStateFromSession(r.status, body)
        if (next.kind === 'signed_in') {
          window.location.replace('/')
          return
        }
        setState(next)
      })
      .catch(() => setState({ kind: 'error' }))
  }, [])

  async function submit(csrfToken: string, password: string | null): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      const headers = csrfMutationHeaders('/api/auth/login', { headers: { [CSRF_HEADER]: csrfToken, ...(password === null ? {} : { 'content-type': 'application/json' }) } })
      const r = await fetch('/api/auth/login', { method: 'POST', headers, body: password === null ? undefined : JSON.stringify({ password }) })
      if (r.ok) {
        window.location.replace('/')
        return
      }
      const f = loginFailureFromResponse(r.status, r.headers.get('retry-after'))
      setWaitSeconds(f.waitSeconds)
      setFailure(f.failure)
    } catch {
      setFailure('failed')
    }
    setBusy(false)
  }

  return (
    <WelcomeView
      state={state}
      busy={busy}
      failure={failure}
      waitSeconds={waitSeconds}
      onLogin={() => { if (state.kind === 'ready') void submit(state.csrfToken, null) }}
      onPassword={(password) => { if (state.kind === 'password') void submit(state.csrfToken, password) }}
    />
  )
}
