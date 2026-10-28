'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionsView } from '../../components/actions.tsx'
import { csrfMutationHeaders } from 'veryfront/index.client'
import { fetchActions, fetchDetail, fetchPage, mapLimit, SessionExpired } from '../../lib/list-client.ts'
import { postEmailUnread, UNREAD_ERROR_TEXT, type MutationDeps } from '../../lib/mutate-client.ts'
import {
  ACTION_PAGE_SIZE,
  actionsUrl,
  afterUnread,
  defaultActionTab,
  listUrl,
  type ActionRow,
  type ActionsCounts,
  type ActionTab,
  type ApiAccount,
  type ApiAction,
  type AutoMode,
} from '../../lib/review-ui.ts'

const mutationDeps: MutationDeps = {
  fetch: (url, init) => fetch(url, init),
  headers: (path, token) => csrfMutationHeaders(path, { headers: { 'x-app-csrf': token } }),
}

const DETAIL_PARALLEL = 4

interface ToastState {
  text: string
  error?: boolean
}

// Shell only: action ids arrive from /api/actions and the mail cards from /api/emails/:id, both client-side.
export default function Aussortiert(): React.JSX.Element {
  const [tab, setTab] = useState<ActionTab>('dry_run')
  const [counts, setCounts] = useState<ActionsCounts | null>(null)
  const [actions, setActions] = useState<ApiAction[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [cards, setCards] = useState<Map<number, ActionRow['email']>>(new Map())
  const [accounts, setAccounts] = useState<ApiAccount[]>([])
  const [modes, setModes] = useState<Record<string, AutoMode>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [toast, setToast] = useState<ToastState | null>(null)
  const [now, setNow] = useState(() => new Date())
  const generation = useRef(0)
  const chosen = useRef(false)

  const expired = useCallback((e: unknown): boolean => {
    if (!(e instanceof SessionExpired)) return false
    window.location.replace('/welcome')
    return true
  }, [])

  // Mail cards for a batch of actions: a few requests at a time, the rows fill in as they arrive.
  const loadCards = useCallback((batch: ApiAction[], mine: number): void => {
    void mapLimit(batch, DETAIL_PARALLEL, async (a) => {
      let card: ActionRow['email']
      try {
        card = (await fetchDetail(a.email_id)) ?? 'missing'
      } catch (e) {
        if (expired(e)) return
        card = 'missing'
      }
      if (mine !== generation.current) return
      setCards((m) => new Map(m).set(a.email_id, card))
    })
  }, [expired])

  useEffect(() => {
    const mine = ++generation.current
    setLoading(true)
    setActions([])
    setCards(new Map())
    fetchActions(actionsUrl({ tab, limit: ACTION_PAGE_SIZE }))
      .then((r) => {
        if (mine !== generation.current) return
        setNow(new Date())
        setCounts(r.counts)
        const preferred = defaultActionTab(r.counts)
        if (!chosen.current && preferred !== tab) {
          chosen.current = true
          setTab(preferred)
          return
        }
        setActions(r.actions)
        setNext(r.next_cursor)
        setError(null)
        loadCards(r.actions, mine)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current || expired(e)) return
        setError('Daten nicht verfügbar')
        setLoading(false)
      })
  }, [tab, tick, expired, loadCards])

  // Accounts and their mode come with the list response (one small request).
  useEffect(() => {
    fetchPage(listUrl({ view: 'all', limit: 1 }))
      .then((r) => {
        setAccounts(r.accounts)
        if (r.auto_actions) setModes(r.auto_actions)
      })
      .catch((e: unknown) => {
        expired(e)
      })
  }, [tick, expired])

  const more = useCallback(() => {
    if (next === null) return
    const mine = generation.current
    setLoading(true)
    fetchActions(actionsUrl({ tab, limit: ACTION_PAGE_SIZE, cursor: next }))
      .then((r) => {
        if (mine !== generation.current) return
        setCounts(r.counts)
        setActions((cur) => {
          const have = new Set(cur.map((a) => a.id))
          return [...cur, ...r.actions.filter((a) => !have.has(a.id))]
        })
        setNext(r.next_cursor)
        loadCards(r.actions, mine)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current || expired(e)) return
        setError('Daten nicht verfügbar')
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false)
      })
  }, [next, tab, expired, loadCards])

  const unread = useCallback((emailId: number): void => {
    if (busy.has(emailId) || counts === null) return
    setBusy((b) => new Set(b).add(emailId))
    void postEmailUnread(emailId, mutationDeps).then((res) => {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(emailId)
        return n
      })
      if (!res.ok) {
        setToast({ text: UNREAD_ERROR_TEXT[res.reason], error: true })
        return
      }
      const r = afterUnread(actions, counts, tab, emailId)
      setActions(r.actions)
      setCounts(r.counts)
      setToast({
        text: res.mode === 'live' ? 'Wieder ungelesen. Auch auf dem Mailserver.' : 'Wird nicht markiert. Im Postfach wurde nichts geändert (Trockenlauf).',
      })
    })
  }, [busy, counts, actions, tab])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 6000)
    return () => clearTimeout(t)
  }, [toast])

  const rows: ActionRow[] = actions.map((a) => ({ action: a, email: cards.get(a.email_id) ?? null }))

  return (
    <ActionsView
      tab={tab}
      counts={counts}
      rows={rows}
      accounts={accounts}
      modes={modes}
      now={now}
      loading={loading}
      error={error}
      canLoadMore={next !== null}
      busy={busy}
      onTab={(t) => {
        chosen.current = true
        setTab(t)
      }}
      onMore={more}
      onReload={() => setTick((t) => t + 1)}
      onUnread={unread}
      toast={toast}
      onToastClose={() => setToast(null)}
    />
  )
}
