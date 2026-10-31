'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ProfileView, reasonText } from '../../components/profile.tsx'
import { accountsErrorText, type AccountEditor } from '../../components/accounts-manager.tsx'
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
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setLoading(true)
    try {
      const p = await fetchProfile(fetch)
      const list = p.managed && p.role === 'admin' ? await fetchInvites(fetch) : []
      if (mine !== generation.current) return
      const acc = await fetchAccounts(fetch).catch(() => null)
      if (mine !== generation.current) return
      setProfile(p)
      setInvites(list)
      setAccounts(acc)
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

  const patchForm = useCallback((patch: Partial<AccountForm>): void => {
    setEditor((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e))
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
          setEditor({ id: null, form: emptyForm('google') })
        },
        onEdit: (a) => {
          setFormError(null)
          setEditor({ id: a.id, form: formFromItem(a) })
        },
        onForm: patchForm,
        onType: (t) => setEditor((e) => (e ? { ...e, form: { ...emptyForm(t), label: e.form.label, color: e.form.color, username: e.form.username, password: e.form.password, context: e.form.context } } : e)),
        onSave: saveAccount,
        onCancel: () => setEditor(null),
        onTest: testAccount,
        onEnabled: toggleAccount,
      }}
    />
  )
}
