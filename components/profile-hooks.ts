'use client'
// Client state of the profile sections "Themen" (R8) and "Benachrichtigungen" (R6). Nothing is stored in the browser; the
// data comes from /api/topics and /api/push/*. The permission prompt is requested only inside enablePush, which runs
// directly in the tap handler (onEnable).
import { useCallback, useEffect, useRef, useState } from 'react'
import { mutationDeps } from './hooks.ts'
import type { PushSectionProps } from './push-manager.tsx'
import type { TopicEditor, TopicsSectionProps } from './topics-manager.tsx'
import {
  createBrowserPushEnv,
  currentPushDevice,
  disablePush,
  enablePush,
  fetchPushConfig,
  fetchPushDevices,
  PUSH_ERROR_TEXT,
  pushSupport,
  removePushDevice,
  sendTestPush,
  updatePushKinds,
  type PushConfigInfo,
  type PushDevice,
  type PushEnv,
  type PushKindName,
  type PushKinds,
  type PushSupport,
} from '../lib/push-client.ts'
import { pushSectionState } from '../lib/push-section.ts'
import { fetchTopics, postTopicChange, topicErrorText, type TopicChange, type TopicsData } from '../lib/topics-client.ts'

export function useTopicsSection(onNotice: (text: string, error?: boolean) => void): TopicsSectionProps {
  const [data, setData] = useState<TopicsData | null>(null)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<TopicEditor | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    void fetchTopics(fetch).then(setData).catch(() => {})
  }, [])

  const run = useCallback((change: TopicChange, done: string, inForm: boolean): void => {
    setBusy(true)
    void postTopicChange(change, mutationDeps).then((res) => {
      setBusy(false)
      if (!res.ok) {
        const text = topicErrorText(res.reason, data?.limits)
        if (inForm) setFormError(text)
        else onNotice(text, true)
        return
      }
      setData(res.data)
      setEditor(null)
      setFormError(null)
      onNotice(done)
    })
  }, [data, onNotice])

  return {
    data,
    busy,
    editor,
    formError,
    onEnabled: (enabled) => run({ action: 'set_enabled', enabled }, enabled ? 'Themen sortieren ist an. Neue Mails bekommen ein Thema.' : 'Themen sortieren ist aus.', false),
    onAdd: () => {
      setFormError(null)
      setEditor({ key: null, label: '', hint: '' })
    },
    onEdit: (t) => {
      setFormError(null)
      setEditor({ key: t.key, label: t.label, hint: t.hint ?? '' })
    },
    onForm: (patch) => setEditor((e) => (e ? { ...e, ...patch } : e)),
    onCancel: () => {
      setEditor(null)
      setFormError(null)
    },
    onSave: () => {
      if (!editor) return
      const hint = editor.hint.trim()
      if (editor.key === null) run({ action: 'create', label: editor.label, ...(hint !== '' ? { hint } : {}) }, 'Thema gespeichert.', true)
      else run({ action: 'update', key: editor.key, label: editor.label, hint: hint === '' ? null : hint }, 'Thema geändert.', true)
    },
    onActive: (key, active) => run({ action: 'set_active', key, active }, active ? 'Thema wieder aktiv.' : 'Thema abgewählt.', false),
  }
}

const NO_KINDS: PushKinds = { important_mail: true, briefing_ready: true }

export function usePushSection(): PushSectionProps {
  const envRef = useRef<PushEnv | null>(null)
  const [config, setConfig] = useState<PushConfigInfo | null>(null)
  const [devices, setDevices] = useState<PushDevice[]>([])
  const [thisDevice, setThisDevice] = useState<PushDevice | null>(null)
  const [support, setSupport] = useState<PushSupport>('supported')
  const [permission, setPermission] = useState<'default' | 'granted' | 'denied'>('default')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const env = (envRef.current ??= createBrowserPushEnv())
    setSupport(pushSupport(env))
    setPermission(env.permission())
    const cfg = await fetchPushConfig(fetch)
    // The silent sync comes first, so a row it registers is part of the list that follows.
    const mine = cfg.available ? await currentPushDevice(env, mutationDeps) : { ok: true as const, device: null }
    const list = cfg.available ? await fetchPushDevices(fetch).catch(() => [] as PushDevice[]) : []
    setConfig(cfg)
    setDevices(list)
    setThisDevice(mine.ok ? mine.device : null)
  }, [])

  useEffect(() => {
    void refresh().catch(() => setConfig({ available: false, publicKey: null, reason: null, maxDevices: null }))
  }, [refresh])

  const done = useCallback(async (text: string): Promise<void> => {
    await refresh().catch(() => {})
    setMessage({ text })
  }, [refresh])

  const fail = useCallback((reason: keyof typeof PUSH_ERROR_TEXT): void => {
    setMessage({ text: PUSH_ERROR_TEXT[reason], error: true })
  }, [])

  const subscribed = thisDevice !== null
  return {
    state: pushSectionState({ config, support, permission, subscribed }),
    reason: config?.reason ?? null,
    devices,
    thisDeviceId: thisDevice?.id ?? null,
    kinds: thisDevice?.kinds ?? NO_KINDS,
    busy,
    maxDevices: config?.maxDevices ?? undefined,
    timeZone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
    message,
    // Called straight from the tap: enablePush asks for the permission as its first action.
    onEnable: () => {
      const e = envRef.current
      if (!e) return
      setBusy(true)
      setMessage(null)
      void enablePush(e, mutationDeps).then(async (res) => {
        setBusy(false)
        if (!res.ok) {
          setPermission(e.permission())
          fail(res.reason)
          return
        }
        await done('Benachrichtigungen sind auf diesem Gerät an.')
      })
    },
    onDisable: () => {
      const e = envRef.current
      if (!e) return
      setBusy(true)
      void disablePush(e, mutationDeps).then(async (res) => {
        setBusy(false)
        if (!res.ok) return fail(res.reason)
        await done('Auf diesem Gerät ausgeschaltet.')
      })
    },
    onKind: (kind: PushKindName, on: boolean) => {
      const e = envRef.current
      if (!e) return
      setBusy(true)
      void updatePushKinds(e, mutationDeps, { [kind]: on }).then(async (res) => {
        setBusy(false)
        if (!res.ok) return fail(res.reason)
        await done('Gespeichert.')
      })
    },
    onTest: () => {
      setBusy(true)
      void sendTestPush(mutationDeps).then((res) => {
        setBusy(false)
        if (!res.ok) return fail(res.reason)
        setMessage(res.delivered ? { text: 'Test gesendet. Er sollte in wenigen Sekunden ankommen.' } : { text: 'Der Test konnte nicht zugestellt werden. Prüfe die Einstellungen des Geräts.', error: true })
        void refresh().catch(() => {})
      })
    },
    onRemove: (id: number) => {
      const e = envRef.current
      if (!e) return
      setBusy(true)
      // This device: also drop the browser subscription; any other device: only the server row.
      const run = thisDevice !== null && thisDevice.id === id ? disablePush(e, mutationDeps) : removePushDevice(id, mutationDeps)
      void run.then(async (res) => {
        setBusy(false)
        if (!res.ok) return fail(res.reason)
        await done('Gerät entfernt.')
      })
    },
  }
}
