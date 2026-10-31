// HTTP handlers of the profile page (R1): who am I, invitations (admin), sessions. Thin: auth, body check, lib/users.ts.
// GET behind requireUser (the session decides whose data), POST behind guardMutation (session 401, limit 429, CSRF 403).
// Responses never contain password hashes, tokens or stored invite hashes; an invite code appears once, in the POST answer.
import { z } from "zod";
import { type AuthContext, defaultAuthContext, defaultMutationLimiter, guardMutation, sessionIdentity, withAuthDb } from "./auth-runtime.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { countLiveSessions, createInvite, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, listOpenInvites, USER_ROLES } from "./users.ts";

export interface ProfileDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  now?: () => Date;
}

export function defaultProfileDeps(): ProfileDeps {
  return { auth: defaultAuthContext(), limiter: defaultMutationLimiter() };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const BODY_MAX_CHARS = 512;

/** GET /api/profile. In the transitional modes there is no account: `managed` is false and the page says so. */
export function handleProfileGet(request: Request, deps: ProfileDeps): Response {
  const me = sessionIdentity(request, deps.auth);
  if (me === null) return json({ error: "unauthorized" }, 401);
  if (deps.auth.mode !== "users") return json({ mode: deps.auth.mode, managed: false, email: null, role: me.role });
  try {
    const now = deps.now?.() ?? new Date(deps.auth.now());
    const live = withAuthDb(deps.auth, (db) => countLiveSessions(db, me.userId, now));
    return json({ mode: "users", managed: true, email: me.email ?? null, role: me.role, live_sessions: live });
  } catch {
    return json({ error: "unavailable" }, 500);
  }
}

/** GET /api/invites: open invitations of the installation, admin only. Created/expires/role, never a code. */
export function handleInvitesList(request: Request, deps: ProfileDeps): Response {
  const me = sessionIdentity(request, deps.auth);
  if (me === null) return json({ error: "unauthorized" }, 401);
  if (deps.auth.mode !== "users") return json({ error: "users_mode_required" }, 409);
  if (me.role !== "admin") return json({ error: "forbidden" }, 403);
  try {
    const now = deps.now?.() ?? new Date(deps.auth.now());
    return json({ invites: withAuthDb(deps.auth, (db) => listOpenInvites(db, now)) });
  } catch {
    return json({ error: "unavailable" }, 500);
  }
}

const inviteBody = z.strictObject({
  role: z.enum(USER_ROLES).optional(),
  days: z.number().int().min(1).max(INVITE_MAX_DAYS).optional(),
});

/** POST /api/invites: creates an invitation (admin). The code is in this answer only; afterwards just its hash exists. */
export async function handleInviteCreate(request: Request, deps: ProfileDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  if (deps.auth.mode !== "users") return json({ error: "users_mode_required" }, 409);
  if (gate.role !== "admin") return json({ error: "forbidden" }, 403);
  let body: unknown = {};
  try {
    const text = (await request.text()).slice(0, BODY_MAX_CHARS + 1);
    if (text.length > BODY_MAX_CHARS) return json({ error: "invalid_body" }, 400);
    if (text.trim() !== "") body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const parsed = inviteBody.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_body" }, 400);
  try {
    const now = deps.now?.() ?? new Date(deps.auth.now());
    const inv = withAuthDb(deps.auth, (db) =>
      createInvite(db, { createdBy: gate.userId, role: parsed.data.role ?? "user", days: parsed.data.days ?? INVITE_DEFAULT_DAYS, now }));
    return json({ ok: true, id: inv.id, code: inv.code, role: inv.role, created_at: inv.created_at, expires_at: inv.expires_at }, 201);
  } catch {
    return json({ error: "unavailable" }, 500);
  }
}
