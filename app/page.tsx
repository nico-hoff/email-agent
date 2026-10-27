'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ReviewListView, type NoiseState } from '../components/review.tsx'
import { appendUnique, fetchPage, SessionExpired } from '../lib/list-client.ts'
import {
  DEFAULT_VIEW,
  isViewId,
  listUrl,
  PAGE_SIZE,
  type ApiAccount,
  type ApiCounts,
  type ApiEmail,
  type ViewId,
} from '../lib/review-ui.ts'

const STORE_KEY = 'review-ui'

// Per-viewer convenience only (view and account); never mail data. Storage may be blocked or empty.
function restore(): { view?: ViewId; account?: string } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}') as { view?: string; account?: string }
    return { view: isViewId(raw.view) ? raw.view : undefined, account: typeof raw.account === 'string' ? raw.account : undefined }
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

interface Page {
  emails: ApiEmail[]
  next: string | null
}

const EMPTY_PAGE: Page = { emails: [], next: null }

// The shell renders no mail data on the server: rows arrive only through client-side /api/ calls.
export default function ReviewList(): React.JSX.Element {
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW)
  const [account, setAccount] = useState('')
  const [ready, setReady] = useState(false)
  const [tick, setTick] = useState(0)
  const [page, setPage] = useState<Page>(EMPTY_PAGE)
  const [counts, setCounts] = useState<ApiCounts | null>(null)
  const [accounts, setAccounts] = useState<ApiAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [noiseOpen, setNoiseOpen] = useState(false)
  const [noisePage, setNoisePage] = useState<Page>(EMPTY_PAGE)
  const [noiseLoading, setNoiseLoading] = useState(false)
  const [noiseError, setNoiseError] = useState(false)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const loadingMore = useRef(false)
  const generation = useRef(0)
  const noiseGeneration = useRef(0)

  const expired = useCallback((e: unknown): boolean => {
    if (!(e instanceof SessionExpired)) return false
    window.location.replace('/welcome')
    return true
  }, [])

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
    const mine = ++generation.current
    loadingMore.current = false
    setLoading(true)
    fetchPage(listUrl({ view, account, limit: PAGE_SIZE }))
      .then((r) => {
        if (mine !== generation.current) return
        setPage({ emails: r.emails, next: r.next_cursor })
        setCounts(r.counts)
        if (r.accounts.length > 0) setAccounts(r.accounts)
        setNow(new Date())
        setError(null)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current || expired(e)) return
        setError('Daten nicht verfügbar')
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false)
      })
  }, [ready, view, account, tick, expired])

  // The folded section loads only once it is opened (view=noise) and follows account and reload.
  useEffect(() => {
    if (!ready || !noiseOpen || view !== 'important') return
    const mine = ++noiseGeneration.current
    setNoiseLoading(true)
    setNoiseError(false)
    fetchPage(listUrl({ view: 'noise', account, limit: PAGE_SIZE }))
      .then((r) => {
        if (mine === noiseGeneration.current) setNoisePage({ emails: r.emails, next: r.next_cursor })
      })
      .catch((e: unknown) => {
        if (mine !== noiseGeneration.current || expired(e)) return
        setNoiseError(true)
      })
      .finally(() => {
        if (mine === noiseGeneration.current) setNoiseLoading(false)
      })
  }, [ready, noiseOpen, view, account, tick, expired])

  const more = useCallback(() => {
    const cursor = page.next
    if (cursor === null || loadingMore.current) return
    loadingMore.current = true
    const mine = generation.current
    setLoading(true)
    fetchPage(listUrl({ view, account, cursor, limit: PAGE_SIZE }))
      .then((r) => {
        if (mine !== generation.current) return
        setPage((p) => ({ emails: appendUnique(p.emails, r.emails), next: r.next_cursor }))
        setCounts(r.counts)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current || expired(e)) return
        setError('Daten nicht verfügbar')
      })
      .finally(() => {
        loadingMore.current = false
        if (mine === generation.current) setLoading(false)
      })
  }, [page.next, view, account, expired])

  const moreNoise = useCallback(() => {
    const cursor = noisePage.next
    if (cursor === null) return
    const mine = noiseGeneration.current
    setNoiseLoading(true)
    fetchPage(listUrl({ view: 'noise', account, cursor, limit: PAGE_SIZE }))
      .then((r) => {
        if (mine === noiseGeneration.current) setNoisePage((p) => ({ emails: appendUnique(p.emails, r.emails), next: r.next_cursor }))
      })
      .catch((e: unknown) => {
        if (mine !== noiseGeneration.current || expired(e)) return
        setNoiseError(true)
      })
      .finally(() => {
        if (mine === noiseGeneration.current) setNoiseLoading(false)
      })
  }, [noisePage.next, account, expired])

  const canLoadMore = !loading && page.next !== null

  useEffect(() => {
    const el = sentinel.current
    if (!el || !canLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) more()
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [canLoadMore, more, page.emails.length, view])

  const noise: NoiseState = {
    open: noiseOpen,
    emails: noisePage.emails,
    loading: noiseLoading,
    canLoadMore: noisePage.next !== null,
    error: noiseError,
  }

  return (
    <ReviewListView
      emails={page.emails}
      view={view}
      counts={counts}
      accounts={accounts}
      account={account}
      now={now}
      loading={loading}
      error={error}
      canLoadMore={canLoadMore}
      noise={noise}
      onView={setView}
      onAccount={setAccount}
      onReload={() => setTick((t) => t + 1)}
      onMore={more}
      onNoiseToggle={() => setNoiseOpen((o) => !o)}
      onNoiseMore={moreNoise}
      sentinelRef={sentinel}
    />
  )
}
