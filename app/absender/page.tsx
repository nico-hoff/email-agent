'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SendersView, type RuleForm } from '../../components/senders.tsx'
import { mutationDeps, useHitl } from '../../components/hooks.ts'
import {
  fetchRules,
  guessMatch,
  KIND_LABEL,
  postDeactivate,
  postRule,
  SENDER_ERROR_TEXT,
  type SenderRule,
} from '../../lib/senders-client.ts'

const EMPTY_FORM: RuleForm = { value: '', kind: 'blacklist', busy: false, error: null }

// Shell only: rules and questions arrive through client-side /api/senders calls (addresses, domains and counts).
export default function Absender(): React.JSX.Element {
  const [rules, setRules] = useState<SenderRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set())
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const generation = useRef(0)

  const loadRules = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setLoading(true)
    try {
      const list = await fetchRules()
      if (mine !== generation.current) return
      setRules(list)
      setError(null)
    } catch (e) {
      if (mine !== generation.current) return
      if (e instanceof Error && e.message === 'session') {
        window.location.replace('/welcome')
        return
      }
      setError('Daten nicht verfügbar')
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [])

  const notify = useCallback((text: string, isError?: boolean): void => setToast({ text, error: isError }), [])
  const hitl = useHitl(notify, () => void loadRules())

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [toast])

  const remove = useCallback((id: number): void => {
    const key = `rule:${id}`
    setBusyKeys((b) => new Set(b).add(key))
    void postDeactivate(id, mutationDeps).then((res) => {
      setBusyKeys((b) => {
        const n = new Set(b)
        n.delete(key)
        return n
      })
      if (!res.ok) {
        notify(SENDER_ERROR_TEXT[res.reason], true)
        return
      }
      setRules((list) => list.filter((r) => r.id !== id))
      notify('Regel entfernt')
      // A removed rule can make a sender a question again.
      void hitl.reload()
    })
  }, [notify, hitl])

  const submit = useCallback((): void => {
    const value = form.value.trim()
    if (value === '' || form.busy) return
    setForm((f) => ({ ...f, busy: true, error: null }))
    void postRule({ match: guessMatch(value), value, kind: form.kind }, mutationDeps).then((res) => {
      if (!res.ok) {
        setForm((f) => ({ ...f, busy: false, error: res.reason }))
        return
      }
      setForm((f) => ({ ...EMPTY_FORM, kind: f.kind }))
      notify(`${KIND_LABEL[form.kind]}: ${value.toLowerCase()}`)
      void loadRules()
      void hitl.reload()
    })
  }, [form, notify, loadRules, hitl])

  return (
    <SendersView
      rules={rules}
      candidates={hitl.candidates}
      loading={loading}
      error={error}
      busyKeys={new Set([...busyKeys, ...hitl.busy])}
      form={form}
      expanded={hitl.expanded}
      onExpand={hitl.expand}
      onFormChange={(patch) => setForm((f) => ({ ...f, ...patch, error: null }))}
      onSubmit={submit}
      onRemove={remove}
      onDecide={hitl.decide}
      onReload={() => {
        void loadRules()
        void hitl.reload()
      }}
      toast={toast}
      onToastClose={() => setToast(null)}
    />
  )
}
