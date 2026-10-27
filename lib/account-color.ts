// Account tag (T47): the small colored dot plus short name next to a mail. Color and label come from the accounts file
// (synced into accounts.label / accounts.color at startup); the API never exposes host or user.

/** Fallback when the accounts file gives no color. Distinct, readable on light and dark backgrounds. */
export const ACCOUNT_PALETTE: readonly string[] = [
  "#3b82f6", "#f97316", "#10b981", "#a855f7", "#ec4899", "#eab308", "#06b6d4", "#ef4444",
];

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The configured color, or a stable palette color derived from the account id. */
export function accountColor(id: string, configured: string | null | undefined): string {
  if (configured) return configured;
  // .at() instead of a computed index: the Veryfront API loader rejects dynamic reads in route-imported modules.
  return ACCOUNT_PALETTE.at(hash(id) % ACCOUNT_PALETTE.length) ?? "#3b82f6";
}

export interface AccountTag {
  id: string;
  label: string;
  color: string;
}

export function accountTag(a: { id: string; label: string; color: string | null }): AccountTag {
  return { id: a.id, label: a.label, color: accountColor(a.id, a.color) };
}
