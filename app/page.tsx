'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ReviewListView } from '../components/review.tsx'
import {
  API_MAX_LIMIT,
  availableViews,
  defaultView,
  PAGE_SIZE,
  type ApiEmail,
  type ViewId,
} from '../lib/review-ui.ts'

interface StatusBody { workers: { account_id: string }[] }

const STORE_KEY = 'review-ui'

// Per-viewer convenience only (view and account); never mail data. Storage may be blocked or empty.
function restore(): { view?: ViewId; account?: string } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}') as { view?: string; account?: string }
    const view = availableViews().find((v) => v === raw.view)
    return { view, account: typeof raw.account === 'string' ? raw.account : undefined }
  } catch {
    return {}
  }
}

function persist(view: ViewId, account: string): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ view, account }))
  } catch {
    // ignore
  }
}

// The shell renders no mail data on the server: rows arrive only through client-side /api/ calls.
export default function ReviewList(): React.JSX.Element {
  const [emails, setEmails] = useState<ApiEmail[]>([])
  const [accounts, setAccounts] = useState<string[]>([])
  const [view, setView] = useState<ViewId>(defaultView())
  const [account, setAccount] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [tick, setTick] = useState(0)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const saved = restore()
    if (saved.view) setView(saved.view)
    if (saved.account !== undefined) setAccount(saved.account)
    setReady(true)
  }, [])

  useEffect(() => {
    if (ready) persist(view, account)
  }, [ready, view, account])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    const q = new URLSearchParams({ limit: String(limit) })
    if (account) q.set('account', account)
    Promise.all([
      fetch('/api/status').then((r) => r.json() as Promise<StatusBody & { error?: string }>),
      fetch(`/api/emails?${q}`).then((r) => r.json() as Promise<{ emails: ApiEmail[]; error?: string }>),
    ])
      .then(([s, e]) => {
        if (cancelled) return
        if (s.error || e.error) throw new Error('unavailable')
        setAccounts(s.workers.map((w) => w.account_id))
        setEmails(e.emails)
        setNow(new Date())
        setError(null)
      })
      .catch(() => {
        if (!cancelled) setError('Daten nicht verfügbar')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ready, account, limit, tick])

  // The API returns exactly `limit` rows while more exist (up to its maximum).
  const canLoadMore = !loading && emails.length >= limit && limit < API_MAX_LIMIT
  const atApiLimit = !loading && emails.length >= API_MAX_LIMIT

  const more = useCallback(() => setLimit((l) => Math.min(l + PAGE_SIZE, API_MAX_LIMIT)), [])

  useEffect(() => {
    const el = sentinel.current
    if (!el || !canLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) more()
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [canLoadMore, more, emails.length, view])

  return (
    <ReviewListView
      emails={emails}
      view={view}
      accounts={accounts}
      account={account}
      now={now}
      loading={loading}
      error={error}
      canLoadMore={canLoadMore}
      atApiLimit={atApiLimit}
      onView={setView}
      onAccount={(a) => {
        setAccount(a)
        setLimit(PAGE_SIZE)
      }}
      onReload={() => setTick((t) => t + 1)}
      onMore={more}
      sentinelRef={sentinel}
    />
  )
}
