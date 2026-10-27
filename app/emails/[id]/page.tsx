'use client'

import { useEffect, useState } from 'react'
import { usePageContext } from 'veryfront/context'
import { DetailMessage, EmailDetailView } from '../../../components/review.tsx'
import { API_MAX_LIMIT, type ApiEmail } from '../../../lib/review-ui.ts'

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; email: ApiEmail }

// There is no single-mail endpoint yet (T35): the row is taken from the newest API_MAX_LIMIT mails.
// The server renders only this shell; mail metadata arrives through the client-side /api/ call.
export default function EmailDetail(): React.JSX.Element {
  const { params } = usePageContext()
  const id = Number(params.id)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!Number.isInteger(id) || id < 1) {
      setState({ kind: 'missing' })
      return
    }
    let cancelled = false
    fetch(`/api/emails?limit=${API_MAX_LIMIT}`)
      .then((r) => r.json() as Promise<{ emails: ApiEmail[]; error?: string }>)
      .then((body) => {
        if (cancelled) return
        if (body.error) throw new Error('unavailable')
        const email = body.emails.find((m) => m.id === id)
        setNow(new Date())
        setState(email ? { kind: 'ready', email } : { kind: 'missing' })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (state.kind === 'loading') return <DetailMessage text="Lädt …" role="status" />
  if (state.kind === 'error') return <DetailMessage text="Daten nicht verfügbar" role="alert" />
  if (state.kind === 'missing') {
    return <DetailMessage text="Diese Mail ist nicht unter den neuesten 200 Mails. Ältere folgen mit der Einzelabruf-API." />
  }
  return <EmailDetailView email={state.email} now={now} />
}
