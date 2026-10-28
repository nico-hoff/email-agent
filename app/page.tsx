'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ReviewListView, type NoiseState } from '../components/review.tsx'
import { csrfMutationHeaders } from 'veryfront/index.client'
import { appendUnique, fetchPage, SessionExpired } from '../lib/list-client.ts'
import { DONE_ERROR_TEXT, postEmailDone, type MutationDeps } from '../lib/mutate-client.ts'
import { markDone, reinsert, type ListState } from '../lib/review-done.ts'
import {
  DEFAULT_VIEW,
  isViewId,
  listUrl,
  PAGE_SIZE,
  type ApiAccount,
  type ApiCounts,
  type ApiEmail,
  type AutoMode,
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

const mutationDeps: MutationDeps = {
  fetch: (url, init) => fetch(url, init),
  headers: (path, token) => csrfMutationHeaders(path, { headers: { 'x-app-csrf': token } }),
}

interface ToastState {
  text: string
  canUndo: boolean
  error?: boolean
}

// The shell renders no mail data on the server: rows arrive only through client-side /api/ calls.
export default function ReviewList(): React.JSX.Element {
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW)
  const [account, setAccount] = useState('')
  const [ready, setReady] = useState(false)
  const [tick, setTick] = useState(0)
  const [page, setPage] = useState<Page>(EMPTY_PAGE)
  const [counts, setCounts] = useState<ApiCounts | null>(null)
  const [accounts, setAccounts] = useState<ApiAccount[]>([])
  const [autoActions, setAutoActions] = useState<Record<string, AutoMode>>({})
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
        if (r.auto_actions) setAutoActions(r.auto_actions)
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

  // ---- Erledigt (T64): optimistic, with Undo; the write goes to the app database only ----
  const [toast, setToast] = useState<ToastState | null>(null)
  const latest = useRef<ListState | null>(null)
  latest.current = counts === null ? null : { emails: page.emails, counts, view }
  const undoItem = useRef<ApiEmail | null>(null)

  const apply = useCallback((next: ListState): void => {
    latest.current = next
    setPage((p) => ({ ...p, emails: next.emails }))
    setCounts(next.counts)
  }, [])

  const fail = useCallback((reason: keyof typeof DONE_ERROR_TEXT): void => {
    setToast({ text: DONE_ERROR_TEXT[reason], canUndo: false, error: true })
  }, [])

  const markAsDone = useCallback((id: number): void => {
    const s = latest.current
    if (!s) return
    const r = markDone(s, id, true)
    if (!r.item) return
    const before = r.item
    undoItem.current = before
    apply(r.state)
    setToast({ text: 'Als erledigt markiert', canUndo: true })
    void postEmailDone(id, true, mutationDeps).then((res) => {
      if (res.ok) return
      if (latest.current) apply(reinsert(latest.current, before))
      undoItem.current = null
      fail(res.reason)
    })
  }, [apply, fail])

  const undo = useCallback((): void => {
    const item = undoItem.current
    const s = latest.current
    if (!item || !s) return
    undoItem.current = null
    apply(reinsert(s, item))
    setToast(null)
    void postEmailDone(item.id, false, mutationDeps).then((res) => {
      if (res.ok) return
      if (latest.current) apply(markDone(latest.current, item.id, true).state)
      fail(res.reason)
    })
  }, [apply, fail])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 6000)
    return () => clearTimeout(t)
  }, [toast])

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
      autoActions={autoActions}
      onView={setView}
      onAccount={setAccount}
      onReload={() => setTick((t) => t + 1)}
      onMore={more}
      onNoiseToggle={() => setNoiseOpen((o) => !o)}
      onNoiseMore={moreNoise}
      onDone={markAsDone}
      toast={toast}
      onUndo={undo}
      onToastClose={() => setToast(null)}
      sentinelRef={sentinel}
    />
  )
}
