// Profile → Themen (R8, ADR 0026/0037): the switch "Themen sortieren", the 12 fixed topics (read-only) and up to 4 own topics
// (name plus a short hint). Stateless: the page passes data, the open editor and callbacks. Shows topic names and hints the
// person typed; nothing from a mail.
import { activeCustomCount, canAddTopic, customTopics, fixedTopics, type TopicItem, type TopicsData } from "../packages/core/src/topics-client.ts";

const noop = (): void => {};

/** The open add/rename form. `key` null = a new topic. */
export interface TopicEditor { key: string | null; label: string; hint: string }

export interface TopicsSectionProps {
  data: TopicsData | null;
  busy: boolean;
  editor: TopicEditor | null;
  formError: string | null;
  onEnabled?: (enabled: boolean) => void;
  onAdd?: () => void;
  onEdit?: (t: TopicItem) => void;
  onForm?: (patch: Partial<Pick<TopicEditor, "label" | "hint">>) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onActive?: (key: string, active: boolean) => void;
}

export const HINT_ADVICE =
  "Der Hinweis hilft Jev bei der Zuordnung. Mach ihn deutlich anders als das nächste feste Thema, sonst gewinnt das breitere feste Thema. Beispiel: „Steuerberater“ mit dem Hinweis „Mails vom Steuerberater: Steuererklärung, Belege, Bescheide“ (nicht einfach „Finanzen“).";

function EditorForm(p: TopicsSectionProps & { data: TopicsData; editor: TopicEditor }): React.JSX.Element {
  const { editor: e, data } = p;
  const lim = data.limits;
  const labelLen = e.label.trim().length;
  const valid = labelLen >= lim.label_min && labelLen <= lim.label_max && e.hint.trim().length <= lim.hint_max;
  return (
    <form className="rule-form topic-form" data-testid="topic-form" onSubmit={(ev) => { ev.preventDefault(); if (valid && !p.busy) (p.onSave ?? noop)(); }}>
      <h3 className="sub-h">{e.key === null ? "Neues Thema" : "Thema bearbeiten"}</h3>
      {p.formError !== null && <p className="notice-inline" role="alert">{p.formError}</p>}
      <label className="field" htmlFor="topic-label">
        <span className="field-label">Name ({lim.label_min} bis {lim.label_max} Zeichen)</span>
        <input id="topic-label" className="input" type="text" maxLength={lim.label_max} autoComplete="off" value={e.label} placeholder="z. B. Steuerberater" onChange={(ev) => (p.onForm ?? noop)({ label: ev.target.value })} />
      </label>
      <label className="field" htmlFor="topic-hint">
        <span className="field-label">Kurzer Hinweis (optional, höchstens {lim.hint_max} Zeichen)</span>
        <input id="topic-hint" className="input" type="text" maxLength={lim.hint_max} autoComplete="off" value={e.hint} placeholder="z. B. Steuererklärung, Belege, Bescheide" onChange={(ev) => (p.onForm ?? noop)({ hint: ev.target.value })} />
      </label>
      <p className="hint" data-testid="topic-advice">{HINT_ADVICE}</p>
      <p className="hint">Jev liest Name und Hinweis. Umbenennen ändert den Namen auch bei Mails, die schon zugeordnet sind; die Zuordnung selbst ändert sich nur für neue Mails.</p>
      <div className="profile-actions">
        <button type="submit" className="btn btn-accent btn-wide" disabled={p.busy || !valid}>Speichern</button>
        <button type="button" className="btn btn-wide" disabled={p.busy} onClick={p.onCancel ?? noop}>Abbrechen</button>
      </div>
    </form>
  );
}

function CustomRow(p: TopicsSectionProps & { t: TopicItem }): React.JSX.Element {
  const { t } = p;
  return (
    <li className={`topic-row${t.active ? "" : " is-off"}`} data-testid="custom-topic">
      <span className="rule-main">
        <span className="rule-value">{t.label}</span>
        {t.hint !== null && t.hint !== "" && <span className="hint">{t.hint}</span>}
        {!t.active && <span className="hint">Abgewählt: neue Mails bekommen dieses Thema nicht mehr. Alte Zuordnungen bleiben.</span>}
      </span>
      <span className="topic-actions">
        {t.active ? (
          <>
            <button type="button" className="btn" disabled={p.busy} onClick={() => (p.onEdit ?? noop)(t)}>Bearbeiten</button>
            <button type="button" className="btn" disabled={p.busy} onClick={() => (p.onActive ?? noop)(t.key, false)}>Abwählen</button>
          </>
        ) : (
          <button type="button" className="btn" disabled={p.busy} onClick={() => (p.onActive ?? noop)(t.key, true)}>Wieder aktivieren</button>
        )}
      </span>
    </li>
  );
}

export function TopicsSection(p: TopicsSectionProps): React.JSX.Element | null {
  const d = p.data;
  if (d === null) return null;
  const custom = customTopics(d);
  const active = activeCustomCount(d);
  const max = d.limits.active_custom_max;
  const full = !canAddTopic(d);
  return (
    <section className="panel" aria-label="Themen">
      <h2>Themen</h2>
      <p className="hint">Mit „Themen sortieren“ bekommt jede <strong>neue</strong> Mail ein Thema (zum Beispiel Finanzen oder Reisen). In der Mailliste erscheinen dann Ordner und ein Themen-Etikett an jeder Mail. Bereits vorhandene Mails bekommen kein Thema und bleiben ohne. Jede neue Mail braucht dafür eine zusätzliche Frage an Jev. Standard ist <strong>Aus</strong>.</p>
      <div className="choices" role="group" aria-label="Themen sortieren">
        {([false, true] as const).map((on) => (
          <button key={String(on)} type="button" className="btn choice" aria-pressed={d.enabled === on} disabled={p.busy} onClick={() => { if (d.enabled !== on) (p.onEnabled ?? noop)(on); }}>
            {on ? "An" : "Aus"}
          </button>
        ))}
      </div>
      <p className="hint" data-testid="topics-state">{d.enabled ? "Themen sortieren ist an: neue Mails bekommen ein Thema." : "Themen sortieren ist aus: es erscheinen keine Ordner."}</p>

      <h3 className="sub-h">Feste Themen</h3>
      <ul className="topic-fixed" data-testid="fixed-topics">
        {fixedTopics(d).map((t) => <li key={t.key} className="topic-pill">{t.label}</li>)}
      </ul>
      <p className="hint">Diese {fixedTopics(d).length} Themen sind fest und lassen sich nicht ändern.</p>

      <h3 className="sub-h">Eigene Themen</h3>
      <p className="hint" data-testid="custom-count">{active} von {max} aktiven eigenen Themen.</p>
      {custom.length === 0 ? <p className="hint">Noch keine eigenen Themen.</p> : (
        <ul className="rules">
          {custom.map((t) => <CustomRow key={t.key} {...p} t={t} />)}
        </ul>
      )}
      {p.editor !== null ? <EditorForm {...p} data={d} editor={p.editor} /> : (
        <>
          <button type="button" className="btn btn-wide" disabled={p.busy || full} onClick={p.onAdd ?? noop}>Eigenes Thema hinzufügen</button>
          {full && <p className="hint hint-warn" role="status" data-testid="topic-limit">Das Limit von {max} aktiven eigenen Themen ist erreicht. Wähle ein Thema ab, um ein neues anzulegen.</p>}
        </>
      )}
      <p className="hint">Änderungen gelten für neue Mails. Vorhandene Mails behalten ihr Thema.</p>
    </section>
  );
}
