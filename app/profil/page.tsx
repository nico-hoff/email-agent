'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ProfileView, reasonText } from '../../components/profile.tsx'
import { accountsErrorText, type AccountEditor } from '../../components/accounts-manager.tsx'
import type { SettingsConfirm } from '../../components/settings-manager.tsx'
import { mutationDeps } from '../../components/hooks.ts'
import {
  fetchInvites,
  fetchProfile,
  postInvite,
  postLogout,
  postLogoutAll,
  type CreatedInvite,
  type OpenInvite,
  type Profile,
} from '../../lib/profile-client.ts'
import {
  applyPatch,
  emptyForm,
  fetchAccounts,
  formFromItem,
  postAccountEnabled,
  postCreateAccount,
  postTestAccount,
  postUpdateAccount,
  type AccountForm,
  type AccountsData,
} from '../../lib/accounts-client.ts'
import { fetchSync, isActivePhase, postSyncRestart, RESTART_ERROR_TEXT, SYNC_POLL_MS, type SyncData } from '../../lib/sync-client.ts'
import {
  fetchSettings,
  postClassifierChoice,
  postClassifierModel,
  postGlobalStop,
  postQuarantine,
  postSpamSeenMode,
  postUserStop,
  SETTINGS_ERROR_TEXT,
  type SettingsData,
  type SettingsResult,
  type SpamSeenMode,
} from '../../lib/settings-client.ts'

// Shell only: account data, invitations and the one-time invite code arrive through client-side /api calls and live in
// component state; nothing is written to browser storage.
export default function Profil(): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [invites, setInvites] = useState<OpenInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [inviteRole, setInviteRole] = useState<'user' | 'admin'>('user')
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [accounts, setAccounts] = useState<AccountsData | null>(null)
  const [editor, setEditor] = useState<AccountEditor | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [syncs, setSyncs] = useState<Record<string, SyncData>>({})
  const [sawActive, setSawActive] = useState<Record<string, boolean>>({})
  const [syncRestarting, setSyncRestarting] = useState<string | null>(null)
  const [syncRestartError, setSyncRestartError] = useState<Record<string, string>>({})
  const [syncTick, setSyncTick] = useState(0)
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [confirm, setConfirm] = useState<SettingsConfirm>(null)
  const generation = useRef(0)
  const syncsRef = useRef<Record<string, SyncData>>({})

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setLoading(true)
    try {
      const p = await fetchProfile(fetch)
      const list = p.managed && p.role === 'admin' ? await fetchInvites(fetch) : []
      if (mine !== generation.current) return
      const acc = await fetchAccounts(fetch).catch(() => null)
      const set = await fetchSettings(fetch).catch(() => null)
      if (mine !== generation.current) return
      setProfile(p)
      setInvites(list)
      setAccounts(acc)
      setSettings(set)
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

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), notice.error ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [notice])

  // Initial import (ADR 0043): ask for the progress of every own account once, then every 1.5 s while one is active.
  const managedIds = accounts ? accounts.accounts.filter((a) => a.managed && a.enabled).map((a) => a.id).join(',') : ''
  useEffect(() => {
    if (managedIds === '') return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ids = managedIds.split(',')
    const poll = async (): Promise<void> => {
      let anyActive = false
      if (!document.hidden) {
        for (const id of ids) {
          const known = syncsRef.current[id]
          if (known && !isActivePhase(known.phase)) continue
          try {
            const s = await fetchSync(fetch, id)
            if (stop || !s) continue
            syncsRef.current = { ...syncsRef.current, [id]: s }
            setSyncs(syncsRef.current)
            if (isActivePhase(s.phase)) {
              anyActive = true
              setSawActive((m) => (m[id] ? m : { ...m, [id]: true }))
            }
          } catch {
            anyActive = true // a failed request is retried at the next tick
          }
        }
      } else {
        anyActive = true
      }
      if (!stop && anyActive) timer = setTimeout(() => void poll(), SYNC_POLL_MS)
    }
    void poll()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
  }, [managedIds, syncTick])

  const restartSync = useCallback((id: string): void => {
    setSyncRestarting(id)
    setSyncRestartError((m) => ({ ...m, [id]: '' }))
    void postSyncRestart(id, mutationDeps).then((res) => {
      setSyncRestarting(null)
      if (!res.ok) {
        setSyncRestartError((m) => ({ ...m, [id]: RESTART_ERROR_TEXT[res.reason] }))
        return
      }
      // forget the old state so the poll fetches the queued one, and mark it as seen running
      const { [id]: _gone, ...rest } = syncsRef.current
      syncsRef.current = rest
      setSyncs(rest)
      setSawActive((m) => ({ ...m, [id]: true }))
      setSyncTick((t) => t + 1)
    })
  }, [])

  const signOut = useCallback((everywhere: boolean): void => {
    setBusy(true)
    void (everywhere ? postLogoutAll(mutationDeps) : postLogout(mutationDeps)).then((res) => {
      if (res.ok) {
        window.location.replace('/welcome')
        return
      }
      setBusy(false)
      setNotice({ text: reasonText(res.reason), error: true })
    })
  }, [])

  const createInvite = useCallback((): void => {
    setBusy(true)
    void postInvite({ role: inviteRole }, mutationDeps).then((res) => {
      setBusy(false)
      if (!res.ok) {
        setNotice({ text: reasonText(res.reason), error: true })
        return
      }
      setCreated(res.invite)
      void fetchInvites(fetch).then(setInvites).catch(() => {})
    })
  }, [inviteRole])

  const reloadAccounts = useCallback((): void => {
    void fetchAccounts(fetch).then(setAccounts).catch(() => {})
  }, [])

  const saveAccount = useCallback((): void => {
    if (!editor) return
    setBusy(true)
    setFormError(null)
    const run = editor.id === null ? postCreateAccount(editor.form, mutationDeps) : postUpdateAccount(editor.id, editor.form, mutationDeps)
    void run.then((res) => {
      setBusy(false)
      if (!res.ok) {
        setFormError(accountsErrorText(res.reason))
        return
      }
      setEditor(null)
      setNotice({ text: editor.id === null ? 'Konto gespeichert.' : 'Änderungen gespeichert.' })
      reloadAccounts()
    })
  }, [editor, reloadAccounts])

  const testAccount = useCallback((id: string): void => {
    setTesting(id)
    void postTestAccount(id, mutationDeps).then((res) => {
      setTesting(null)
      if (!res.ok) {
        setNotice({ text: accountsErrorText(res.reason), error: true })
        return
      }
      setTestResults((r) => ({ ...r, [id]: res.code }))
      reloadAccounts()
    })
  }, [reloadAccounts])

  const toggleAccount = useCallback((id: string, enabled: boolean): void => {
    setBusy(true)
    void postAccountEnabled(id, enabled, mutationDeps).then((res) => {
      setBusy(false)
      if (!res.ok) {
        setNotice({ text: accountsErrorText(res.reason), error: true })
        return
      }
      reloadAccounts()
    })
  }, [reloadAccounts])

  const reloadSettings = useCallback((): void => {
    void fetchSettings(fetch).then(setSettings).catch(() => {})
  }, [])

  // Runs one settings change, then reloads the data. A failure shows the text of its reason.
  const runSettings = useCallback((run: Promise<SettingsResult>, done: string): void => {
    setBusy(true)
    void run.then((res) => {
      setBusy(false)
      setConfirm(null)
      if (!res.ok) {
        setNotice({ text: SETTINGS_ERROR_TEXT[res.reason], error: true })
      } else {
        setNotice({ text: done })
      }
      reloadSettings()
    })
  }, [reloadSettings])

  const changeMode = useCallback((accountId: string, mode: SpamSeenMode): void => {
    if (mode === 'live') {
      // Never switched on directly: the dialog explains what happens on the server first.
      const label = settings?.accounts.find((a) => a.id === accountId)?.label ?? accountId
      setConfirm({ kind: 'live', accountId, label })
      return
    }
    runSettings(postSpamSeenMode(accountId, mode, false, mutationDeps), 'Gespeichert.')
  }, [settings, runSettings])

  const changeQuarantineMode = useCallback((accountId: string, mode: SpamSeenMode): void => {
    if (mode === 'live') {
      const a = settings?.accounts.find((x) => x.id === accountId)
      setConfirm({ kind: 'qlive', accountId, label: a?.label ?? accountId, yolo: a?.quarantine?.yolo === true })
      return
    }
    runSettings(postQuarantine(accountId, { mode }, false, mutationDeps), 'Gespeichert.')
  }, [settings, runSettings])

  const changeYolo = useCallback((accountId: string, on: boolean): void => {
    if (on) {
      const label = settings?.accounts.find((x) => x.id === accountId)?.label ?? accountId
      setConfirm({ kind: 'yolo', accountId, label })
      return
    }
    runSettings(postQuarantine(accountId, { yolo: false }, false, mutationDeps), 'YOLO ist aus.')
  }, [settings, runSettings])

  const acceptConfirm = useCallback((): void => {
    if (!confirm) return
    if (confirm.kind === 'qlive') runSettings(postQuarantine(confirm.accountId, { mode: 'live' }, true, mutationDeps), 'Spam wird jetzt auf dem Server verschoben.')
    else if (confirm.kind === 'yolo') runSettings(postQuarantine(confirm.accountId, { yolo: true }, true, mutationDeps), 'YOLO ist an.')
    else if (confirm.kind === 'live') runSettings(postSpamSeenMode(confirm.accountId, 'live', true, mutationDeps), 'Spam wird jetzt auf dem Server als gelesen markiert.')
    else runSettings(postGlobalStop(confirm.stopped, mutationDeps), confirm.stopped ? 'Globaler Not-Aus eingeschaltet.' : 'Globaler Not-Aus aufgehoben.')
  }, [confirm, runSettings])

  const patchForm = useCallback((patch: Partial<Omit<AccountForm, 'touched'>>): void => {
    setEditor((e) => (e ? { ...e, form: applyPatch(e.form, patch) } : e))
  }, [])

  return (
    <ProfileView
      profile={profile}
      invites={invites}
      loading={loading}
      error={error}
      busy={busy}
      created={created}
      notice={notice}
      inviteRole={inviteRole}
      onInviteRole={setInviteRole}
      onCreateInvite={createInvite}
      onLogout={() => signOut(false)}
      onLogoutAll={() => signOut(true)}
      onReload={() => void load()}
      onNoticeClose={() => setNotice(null)}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      accounts={{
        data: accounts,
        editor,
        busy,
        testing,
        testResults,
        formError,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        onAdd: () => {
          setFormError(null)
          setEditor({ id: null, form: emptyForm() })
        },
        onEdit: (a) => {
          setFormError(null)
          setEditor({ id: a.id, form: formFromItem(a) })
        },
        onForm: patchForm,
        onSave: saveAccount,
        onCancel: () => setEditor(null),
        onTest: testAccount,
        onEnabled: toggleAccount,
        sync: syncs,
        syncSawActive: sawActive,
        syncRestarting,
        syncRestartError: Object.fromEntries(Object.entries(syncRestartError).filter(([, v]) => v !== '')),
        onSyncRestart: restartSync,
      }}
      settings={{
        data: settings,
        busy,
        confirm,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        onMode: changeMode,
        onQuarantineMode: changeQuarantineMode,
        onQuarantineDays: (accountId, days) => runSettings(postQuarantine(accountId, { days }, false, mutationDeps), 'Gespeichert.'),
        onYolo: changeYolo,
        onUserStop: (stopped) => runSettings(postUserStop(stopped, mutationDeps), stopped ? 'Not-Aus eingeschaltet. Es passiert nichts mehr am Postfach.' : 'Aktionen wieder erlaubt.'),
        onGlobalStop: (stopped) => setConfirm({ kind: 'global', stopped }),
        onConfirm: acceptConfirm,
        onCancelConfirm: () => setConfirm(null),
        onModel: (model) => runSettings(postClassifierModel(model, mutationDeps), 'Modell gespeichert. Es gilt für neue Mails.'),
        onChoice: (userId, granted) => runSettings(postClassifierChoice(userId, granted, mutationDeps), granted ? 'Modellwahl freigegeben.' : 'Modellwahl entzogen.'),
      }}
    />
  )
}
