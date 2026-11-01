// Modal confirmation (R3): used before an account goes live and before the global emergency stop changes. Stateless: the
// page decides when it is open. The safe choice (Abbrechen) has the focus; Escape and a tap outside cancel.
const noop = (): void => {};

export interface ConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Warn style for the confirm button (a step that touches the mail server). */
  danger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog(p: ConfirmDialogProps): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) (p.onCancel ?? noop)(); }} onKeyDown={(e) => { if (e.key === "Escape") (p.onCancel ?? noop)(); }}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-body">
        <h2 id="dialog-title" className="dialog-title">{p.title}</h2>
        <div id="dialog-body" className="dialog-body">{p.children}</div>
        <div className="profile-actions">
          <button type="button" className="btn btn-wide" autoFocus disabled={p.busy} onClick={p.onCancel ?? noop}>Abbrechen</button>
          <button type="button" className={`btn btn-wide ${p.danger ? "btn-danger" : "btn-accent"}`} disabled={p.busy} onClick={p.onConfirm ?? noop}>{p.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
