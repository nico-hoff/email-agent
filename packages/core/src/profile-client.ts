// Browser side of the profile page (R1): who am I, open invitations, create an invitation, sign out (here / everywhere).
// Types are repeated here on purpose: the server modules use node:sqlite and must not be bundled into the browser.
// An invite code is held in component state only, shown once, never written to browser storage.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type Role = "admin" | "user";

export interface Profile {
  mode: string;
  /** false in the transitional modes (password, tailnet, synthetic): no account, no invitations. */
  managed: boolean;
  email: string | null;
  role: Role;
  live_sessions?: number;
}

export interface OpenInvite { id: number; role: Role; created_at: string; expires_at: string }
export interface CreatedInvite extends OpenInvite { code: string }

export type ProfileReason = CommonReason | "users_mode_required";

export const PROFILE_ERROR_TEXT: Record<ProfileReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Das gibt es nicht mehr.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
  users_mode_required: "Das gibt es nur mit Nutzerkonten.",
};

const asRole = (v: unknown): Role => (v === "admin" ? "admin" : "user");

export async function fetchProfile(fetcher: typeof fetch): Promise<Profile> {
  const r = await fetcher("/api/profile", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  return {
    mode: typeof b.mode === "string" ? b.mode : "unknown",
    managed: b.managed === true,
    email: typeof b.email === "string" ? b.email : null,
    role: asRole(b.role),
    ...(typeof b.live_sessions === "number" ? { live_sessions: b.live_sessions } : {}),
  };
}

export async function fetchInvites(fetcher: typeof fetch): Promise<OpenInvite[]> {
  const r = await fetcher("/api/invites", { cache: "no-store" });
  if (r.status === 401) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  const list = Array.isArray(b.invites) ? b.invites : [];
  const out: OpenInvite[] = [];
  for (const i of list) {
    if (typeof i !== "object" || i === null) continue;
    const m = new Map(Object.entries(i));
    const id = m.get("id");
    const created = m.get("created_at");
    const expires = m.get("expires_at");
    if (typeof id === "number" && typeof created === "string" && typeof expires === "string") out.push({ id, role: asRole(m.get("role")), created_at: created, expires_at: expires });
  }
  return out;
}

export type InviteResult = { ok: true; invite: CreatedInvite } | { ok: false; reason: ProfileReason; retryAfterSeconds?: number };

export async function postInvite(body: { role?: Role; days?: number }, deps: MutationDeps): Promise<InviteResult> {
  const raw = await postApi("/api/invites", deps, { body });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  if (r.status === 409) return { ok: false, reason: "users_mode_required" };
  if (!r.ok) return { ok: false, reason: "failed" };
  const b = await readJson(r);
  if (typeof b.code !== "string" || typeof b.id !== "number" || typeof b.created_at !== "string" || typeof b.expires_at !== "string") return { ok: false, reason: "failed" };
  return { ok: true, invite: { id: b.id, code: b.code, role: asRole(b.role), created_at: b.created_at, expires_at: b.expires_at } };
}

export type SignOutResult = { ok: true } | { ok: false; reason: ProfileReason };

async function postSignOut(path: string, deps: MutationDeps): Promise<SignOutResult> {
  const raw = await postApi(path, deps);
  if (raw.kind === "forbidden") return { ok: true }; // already signed out
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  if (r.status === 401) return { ok: true };
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason };
  if (r.status === 409) return { ok: false, reason: "users_mode_required" };
  return r.ok ? { ok: true } : { ok: false, reason: "failed" };
}

export const postLogout = (deps: MutationDeps): Promise<SignOutResult> => postSignOut("/api/auth/logout", deps);
export const postLogoutAll = (deps: MutationDeps): Promise<SignOutResult> => postSignOut("/api/sessions/revoke-all", deps);

/** "31.10.2026, 14:05" in the browser's time zone; the raw string when it is not a date. */
export function formatWhen(iso: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(t));
}
