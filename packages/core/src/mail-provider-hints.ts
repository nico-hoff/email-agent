// Suggests the IMAP server from the domain of an e-mail address (R2 form: three visible fields). A small static map, no
// lookups, no network. Unknown domains return null; the form then shows the placeholder `imap.<domain>`.
// Pure and browser-safe (imported by the client form and tested on the server side).

export const GOOGLE_IMAP_HOST = "imap.gmail.com";

const HOSTS: readonly (readonly [string, string])[] = [
  ["gmail.com", GOOGLE_IMAP_HOST],
  ["googlemail.com", GOOGLE_IMAP_HOST],
  ["web.de", "imap.web.de"],
  ["gmx.de", "imap.gmx.net"],
  ["gmx.net", "imap.gmx.net"],
  ["gmx.at", "imap.gmx.net"],
  ["gmx.ch", "imap.gmx.net"],
  ["outlook.com", "outlook.office365.com"],
  ["outlook.de", "outlook.office365.com"],
  ["hotmail.com", "outlook.office365.com"],
  ["hotmail.de", "outlook.office365.com"],
  ["live.com", "outlook.office365.com"],
  ["live.de", "outlook.office365.com"],
  ["icloud.com", "imap.mail.me.com"],
  ["me.com", "imap.mail.me.com"],
  ["mac.com", "imap.mail.me.com"],
  ["t-online.de", "secureimap.t-online.de"],
  ["posteo.de", "posteo.de"],
  ["posteo.net", "posteo.de"],
  ["mailbox.org", "imap.mailbox.org"],
];

/** The part after the last "@", lower case; null when the text is not a plausible address. */
export function emailDomain(email: string): string | null {
  const t = email.trim().toLowerCase();
  const at = t.lastIndexOf("@");
  if (at < 1 || at === t.length - 1) return null;
  const d = t.slice(at + 1);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) && d.includes(".") ? d : null;
}

/** Known provider server for the address, or null. */
export function imapHostForEmail(email: string): string | null {
  const d = emailDomain(email);
  if (d === null) return null;
  return HOSTS.find(([domain]) => domain === d)?.[1] ?? null;
}

/** Placeholder for an unknown domain: `imap.<domain>`. */
export function hostPlaceholder(email: string): string {
  const d = emailDomain(email);
  return d === null ? "imap.example.com" : `imap.${d}`;
}

export const isGoogleHost = (host: string): boolean => host.trim().toLowerCase() === GOOGLE_IMAP_HOST;

export const LABEL_DEFAULT_MAX = 40;
/** Default label: the address itself (shortened to the label limit). */
export const defaultLabel = (email: string): string => email.trim().slice(0, LABEL_DEFAULT_MAX);
