'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ProfileView, reasonText } from '../../components/profile.tsx'
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
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setLoading(true)
    try {
      const p = await fetchProfile(fetch)
      const list = p.managed && p.role === 'admin' ? await fetchInvites(fetch) : []
      if (mine !== generation.current) return
      setProfile(p)
      setInvites(list)
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
    />
  )
}
