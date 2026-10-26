'use client'

import { useEffect, useState } from 'react'

interface Answer { type: string; value: number | string | null; probabilities?: unknown }
interface EmailRow {
  id: number
  account_id: string
  sender: string
  subject: string
  received_at: string
  active_location: { folder: string; uid: number } | null
  provider_spam: boolean
  classification: { status: string; answers: Record<string, Answer> } | null
  shadow_quarantine: { candidate: boolean; decision: string; reason: string; applied_threshold: number } | null
  disagreement: string | null
}
interface Worker { account_id: string; state: string; error_code: string | null; last_poll_at: string | null }
interface StatusBody { workers: Worker[]; classifications: Record<string, number> }

const DISAGREEMENT_LABEL: Record<string, string> = {
  provider_spam_jev_not_spam: 'Provider: Spam, Jev: nicht Spam',
  jev_spam_provider_not_spam: 'Jev: Spam, Provider: nicht Spam',
}

// noul answers are unmapped, so the raw value is shown as-is.
function show(a: Answer | undefined): string {
  return a === undefined || a.value === null ? '-' : String(a.value)
}

export default function ReviewDashboard(): React.JSX.Element {
  const [emails, setEmails] = useState<EmailRow[]>([])
  const [status, setStatus] = useState<StatusBody | null>(null)
  const [account, setAccount] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = account ? `?account=${encodeURIComponent(account)}` : ''
    Promise.all([
      fetch('/api/status').then((r) => r.json()),
      fetch(`/api/emails${q}`).then((r) => r.json()),
    ])
      .then(([s, e]) => {
        if (s.error || e.error) throw new Error('unavailable')
        setStatus(s)
        setEmails(e.emails)
        setError(null)
      })
      .catch(() => setError('Daten nicht verfügbar'))
  }, [account])

  const accounts = status?.workers.map((w) => w.account_id) ?? []

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <h1>E-Mail-Review (Beobachtungsmodus, nur lesend)</h1>
      {error && <p role="alert">{error}</p>}
      <section aria-label="Worker">
        <h2>Worker</h2>
        <ul>
          {status?.workers.map((w) => (
            <li key={w.account_id}>
              {w.account_id}: {w.state}{w.error_code ? ` (${w.error_code})` : ''}, letzter Poll: {w.last_poll_at ?? '-'}
            </li>
          ))}
        </ul>
        <p>
          {status && Object.entries(status.classifications).map(([k, n]) => `${k}: ${n}`).join(' · ')}
        </p>
      </section>
      <label>
        Konto{' '}
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">alle</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr>
            <th align="left">Konto</th><th align="left">Ordner</th><th align="left">Absender / Betreff</th>
            <th align="left">Kategorie</th><th align="left">Antworten (Rohwerte)</th>
            <th align="left">Shadow</th><th align="left">Abweichung</th>
          </tr>
        </thead>
        <tbody>
          {emails.map((m) => {
            const a = m.classification?.answers ?? {}
            return (
              <tr key={m.id} style={{ borderTop: '1px solid #8884' }}>
                <td>{m.account_id}</td>
                <td>{m.active_location?.folder ?? '-'}{m.provider_spam ? ' (Spam)' : ''}</td>
                <td>{m.sender}<br />{m.subject}</td>
                <td>{show(a.category)}</td>
                <td>
                  {Object.entries(a).filter(([k]) => k !== 'category').map(([k, v]) => `${k}=${show(v)}`).join(', ') ||
                    (m.classification?.status ?? '-')}
                </td>
                <td>
                  {m.shadow_quarantine
                    ? `${m.shadow_quarantine.decision} (${m.shadow_quarantine.reason}, ab ${m.shadow_quarantine.applied_threshold})`
                    : '-'}
                </td>
                <td>{m.disagreement ? DISAGREEMENT_LABEL[m.disagreement] : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </main>
  )
}
