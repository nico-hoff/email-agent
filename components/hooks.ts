'use client'
// Client state for the briefing box (T56) and the sender questions (T54). The briefing text and the sender data live in
// component state only; sessionStorage holds nothing but the collapsed flag of the box.
import { useCallback, useEffect, useRef, useState } from 'react'
import { csrfMutationHeaders } from 'veryfront/index.client'
import { INITIAL_BRIEFING, reduceBriefing, runBriefing, type BriefingState } from '../lib/briefing-client.ts'
import type { MutationDeps } from '../lib/mutate-client.ts'
import { fetchHitl, postDismiss, postRule, SENDER_ERROR_TEXT, KIND_LABEL, type HitlCandidate } from '../lib/senders-client.ts'
import type { HitlDecision } from './briefing.tsx'

export const mutationDeps: MutationDeps = {
  fetch: (url, init) => fetch(url, init),
  headers: (path, token) => csrfMutationHeaders(path, { headers: { 'x-app-csrf': token } }),
}

const COLLAPSED_KEY = 'briefing-collapsed'

function readCollapsed(): boolean {
  try {
    return sessionStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    // storage may be blocked; the box then simply opens expanded next time
  }
}

export interface BriefingHook {
  state: BriefingState
  collapsed: boolean
  showAll: boolean
  toggle: () => void
  expandAll: () => void
  retry: () => void
}

/** Starts the briefing once per page load (the backend caches for five minutes); `retry` runs it again. */
export function useBriefing(): BriefingHook {
  const [state, setState] = useState<BriefingState>(INITIAL_BRIEFING)
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const started = useRef(false)

  const run = useCallback((): void => {
    setState({ ...INITIAL_BRIEFING, phase: 'loading' })
    setShowAll(false)
    void runBriefing(mutationDeps, (e) => setState((s) => reduceBriefing(s, e))).then((res) => {
      if (!res.ok) {
        if (res.reason === 'forbidden') {
          window.location.replace('/welcome')
          return
        }
        setState((s) => ({ ...s, phase: 'error', error: { code: res.reason, fallback: false } }))
        return
      }
      // A stream that ends without done or error is a broken connection.
      setState((s) => (s.phase === 'done' || s.phase === 'error' ? s : { ...s, phase: 'error', error: { code: 'stream_ended', fallback: false } }))
    })
  }, [])

  useEffect(() => {
    setCollapsed(readCollapsed())
    if (started.current) return
    started.current = true
    run()
  }, [run])

  return {
    state,
    collapsed,
    showAll,
    toggle: () => setCollapsed((c) => {
      writeCollapsed(!c)
      return !c
    }),
    expandAll: () => setShowAll(true),
    retry: run,
  }
}

export interface HitlHook {
  candidates: HitlCandidate[]
  busy: ReadonlySet<string>
  expanded: boolean
  expand: () => void
  reload: () => Promise<void>
  decide: (c: HitlCandidate, d: HitlDecision) => void
}

/**
 * Open sender questions with optimistic answers: the card leaves at once and comes back with an error toast when the
 * write fails. `onChanged` runs after a saved answer (the Absender page reloads its rules).
 */
export function useHitl(notify: (text: string, error?: boolean) => void, onChanged?: () => void): HitlHook {
  const [candidates, setCandidates] = useState<HitlCandidate[]>([])
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setCandidates(await fetchHitl())
    } catch {
      // The questions are optional: a failed load simply shows none.
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const decide = useCallback((c: HitlCandidate, d: HitlDecision): void => {
    setBusy((b) => new Set(b).add(c.key))
    let index = 0
    setCandidates((list) => {
      index = Math.max(list.findIndex((x) => x.key === c.key), 0)
      return list.filter((x) => x.key !== c.key)
    })
    const request = d === 'dismiss' ? postDismiss({ match: c.match, value: c.value }, mutationDeps) : postRule({ match: c.match, value: c.value, kind: d }, mutationDeps)
    void request.then((res) => {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(c.key)
        return n
      })
      if (!res.ok) {
        setCandidates((list) => (list.some((x) => x.key === c.key) ? list : [...list.slice(0, index), c, ...list.slice(index)]))
        notify(SENDER_ERROR_TEXT[res.reason], true)
        return
      }
      notify(d === 'dismiss' ? 'Später wieder fragen' : `${KIND_LABEL[d]}: ${c.value}`)
      onChanged?.()
    })
  }, [notify, onChanged])

  return { candidates, busy, expanded, expand: () => setExpanded(true), reload, decide }
}
