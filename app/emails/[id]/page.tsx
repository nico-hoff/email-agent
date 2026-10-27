'use client'

import { useEffect, useState } from 'react'
import { usePageContext } from 'veryfront/context'
import { DetailMessage, EmailDetailView } from '../../../components/review.tsx'
import { fetchDetail, SessionExpired } from '../../../lib/list-client.ts'
import type { ApiEmailDetail } from '../../../lib/review-ui.ts'

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; email: ApiEmailDetail }

// The server renders only this shell; mail metadata arrives through the client-side /api/emails/:id call.
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

  if (state.kind === 'loading') return <DetailMessage text="Lädt …" role="status" />
  if (state.kind === 'error') return <DetailMessage text="Daten nicht verfügbar" role="alert" />
  if (state.kind === 'missing') return <DetailMessage text="Diese Mail gibt es nicht." />
  return <EmailDetailView email={state.email} now={now} />
}
