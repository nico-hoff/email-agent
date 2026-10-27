'use client'

import { useEffect, useState } from 'react'
import { usePageContext } from 'veryfront/context'
import { DetailMessage, EmailDetailView } from '../../../components/review.tsx'
import { csrfMutationHeaders } from 'veryfront/index.client'
import { fetchDetail, SessionExpired } from '../../../lib/list-client.ts'
import { DONE_ERROR_TEXT, postEmailDone, type MutationDeps } from '../../../lib/mutate-client.ts'
import { isCta } from '../../../lib/review-done.ts'
import type { ApiEmailDetail } from '../../../lib/review-ui.ts'

const mutationDeps: MutationDeps = {
  fetch: (url, init) => fetch(url, init),
  headers: (path, token) => csrfMutationHeaders(path, { headers: { 'x-app-csrf': token } }),
}

type State ={ kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; email: ApiEmailDetail }

// The server renders only this shell; mail metadata arrives through the client-side /api/emails/:id call.
export default function EmailDetail(): React.JSX.Element {
  const { params } = usePageContext()
  const id = Number(params.id)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!Number.isInteger(id) || id < 1) {
      setState({ kind: 'missing' })
      return
    }
    let cancelled = false
    fetchDetail(id)
      .then((email) => {
        if (cancelled) return
        setNow(new Date())
        setState(email ? { kind: 'ready', email } : { kind: 'missing' })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof SessionExpired) window.location.replace('/welcome')
        else setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function toggleDone(): Promise<void> {
    if (state.kind !== 'ready' || busy) return
    const before = state.email
    const done = !before.done
    const after = { ...before, done }
    after.open = isCta(after) && !after.seen && !after.done
    setState({ kind: 'ready', email: after })
    setBusy(true)
    setActionError(null)
    const res = await postEmailDone(before.id, done, mutationDeps)
    setBusy(false)
    if (!res.ok) {
      setState({ kind: 'ready', email: before })
      setActionError(DONE_ERROR_TEXT[res.reason])
    }
  }

  if (state.kind === 'loading') return <DetailMessage text="Lädt …" role="status" />
  if (state.kind === 'error') return <DetailMessage text="Daten nicht verfügbar" role="alert" />
  if (state.kind === 'missing') return <DetailMessage text="Diese Mail gibt es nicht." />
  return <EmailDetailView email={state.email} now={now} busy={busy} error={actionError} onToggleDone={() => void toggleDone()} />
}
