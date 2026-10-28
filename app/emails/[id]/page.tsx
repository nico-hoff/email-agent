'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageContext } from 'veryfront/context'
import { DetailMessage, EmailDetailView, UndoToast } from '../../../components/review.tsx'
import { DraftPanel, type DraftViewState } from '../../../components/draft.tsx'
import { FeedbackPanel } from '../../../components/feedback.tsx'
import { mutationDeps } from '../../../components/hooks.ts'
import { browserClipboardEnv, copyToClipboard, postDraft, showDraftButton } from '../../../lib/draft-client.ts'
import {
  applyFeedback,
  EMPTY_FEEDBACK,
  FEEDBACK_ERROR_TEXT,
  FEEDBACK_SAVED_TEXT,
  fetchFeedback,
  postFeedback,
  type FeedbackKind,
  type FeedbackState,
} from '../../../lib/feedback-client.ts'
import { fetchDetail, SessionExpired } from '../../../lib/list-client.ts'
import { DONE_ERROR_TEXT, postEmailDone, postEmailUnread, UNREAD_ERROR_TEXT } from '../../../lib/mutate-client.ts'
import { isCta } from '../../../lib/review-done.ts'
import type { ApiEmailDetail } from '../../../lib/review-ui.ts'

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; email: ApiEmailDetail }

// The server renders only this shell; mail metadata arrives through the client-side /api/emails/:id call.
export default function EmailDetail(): React.JSX.Element {
  const { params } = usePageContext()
  const id = Number(params.id)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [unreadBusy, setUnreadBusy] = useState(false)
  const [unreadMessage, setUnreadMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [feedback, setFeedback] = useState<FeedbackState | null>(null)
  const feedbackRef = useRef<FeedbackState | null>(null)
  feedbackRef.current = feedback
  const [draft, setDraft] = useState<DraftViewState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)

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

  useEffect(() => {
    if (!Number.isInteger(id) || id < 1) return
    let cancelled = false
    fetchFeedback(id)
      .then((f) => {
        if (!cancelled) setFeedback(f ?? EMPTY_FEEDBACK)
      })
      .catch(() => {
        // Without the stored answers the buttons still work; they just start unpressed.
        if (!cancelled) setFeedback(EMPTY_FEEDBACK)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Optimistic: the button flips at once and flips back with a toast when the write fails.
  const answer = useCallback((kind: FeedbackKind, value?: string): void => {
    const before = feedbackRef.current
    if (before === null) return
    setFeedback(applyFeedback(before, kind, value))
    void postFeedback(id, kind, value, mutationDeps).then((res) => {
      if (res.ok) {
        setFeedback(res.feedback)
        setToast({ text: FEEDBACK_SAVED_TEXT })
      } else {
        setFeedback(before)
        setToast({ text: FEEDBACK_ERROR_TEXT[res.reason], error: true })
      }
    })
  }, [id])

  // The draft lives in this component's state only: nothing is written to any storage.
  const createDraft = useCallback((): void => {
    setDraft({ kind: 'loading' })
    setCopied(false)
    void postDraft(id, mutationDeps).then((r) => {
      setDraft(r.ok ? { kind: 'ok', result: r } : { kind: 'error', result: r })
    })
  }, [id])

  const copyDraft = useCallback((): void => {
    if (draft.kind !== 'ok') return
    void copyToClipboard(draft.result.draft, browserClipboardEnv()).then((done) => {
      if (done) {
        setCopied(true)
        setTimeout(() => setCopied(false), 3000)
      } else {
        setToast({ text: 'Kopieren nicht möglich. Bitte den Text markieren und kopieren.', error: true })
      }
    })
  }, [draft])

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

  // "Wieder ungelesen": the server decides (live: removes \Seen on the mailbox, dry run: app status only).
  async function markUnread(): Promise<void> {
    if (state.kind !== 'ready' || unreadBusy) return
    const before = state.email
    setUnreadBusy(true)
    setUnreadMessage(null)
    const res = await postEmailUnread(before.id, mutationDeps)
    setUnreadBusy(false)
    if (!res.ok) {
      setUnreadMessage({ text: UNREAD_ERROR_TEXT[res.reason], error: true })
      return
    }
    const action = before.mailbox_action ? { ...before.mailbox_action, status: 'undone' } : before.mailbox_action
    const after = { ...before, mailbox_action: action, seen: false }
    after.open = isCta(after) && !after.seen && !after.done
    setState({ kind: 'ready', email: after })
    setUnreadMessage({
      text: res.mode === 'live' ? 'Wieder ungelesen. Die Regel markiert diese Mail nicht erneut.' : 'Wieder ungelesen (Trockenlauf: im Postfach wurde nichts geändert). Die Regel greift bei dieser Mail nicht mehr.',
    })
  }

  if (state.kind === 'loading') return <DetailMessage text="Lädt …" role="status" />
  if (state.kind === 'error') return <DetailMessage text="Daten nicht verfügbar" role="alert" />
  if (state.kind === 'missing') return <DetailMessage text="Diese Mail gibt es nicht." />
  return (
    <>
      <EmailDetailView
        email={state.email}
        now={now}
        busy={busy}
        error={actionError}
        onToggleDone={() => void toggleDone()}
        onUnread={() => void markUnread()}
        unreadBusy={unreadBusy}
        unreadMessage={unreadMessage}
        feedback={<FeedbackPanel state={feedback} onAnswer={answer} />}
        draft={<DraftPanel state={draft} copied={copied} onCreate={createDraft} onCopy={copyDraft} />}
        draftPrimary={showDraftButton(state.email)}
      />
      {toast && <UndoToast text={toast.text} error={toast.error} onClose={() => setToast(null)} />}
    </>
  )
}
