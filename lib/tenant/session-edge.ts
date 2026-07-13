/**
 * Edge-safe session verification.
 *
 * This is the crux of the feature. The old proxy.ts called `getSession()`, which
 * runs `auth.api.getSession()` -> the MongoDB adapter -> `mongoose` (native
 * net/tls/dns) and transitively `bcrypt` (native bindings). None of those exist
 * in the Edge Runtime (a V8 isolate), so the middleware crashed.
 *
 * Instead we read better-auth's *signed session-cache cookie* — already enabled
 * in lib/auth/auth.ts via `session.cookieCache`. `getCookieCache` verifies the
 * cookie's HMAC signature with BETTER_AUTH_SECRET using Web Crypto (edge-native)
 * and returns the `{ session, user }` snapshot with ZERO database round-trips.
 *
 * ⚠️ EDGE PURITY (G1): the ONLY better-auth import allowed here is
 * `better-auth/cookies`. Never import the auth server instance (lib/auth/auth.ts)
 * — it pulls the adapter (mongoose/bcrypt) into the edge bundle.
 *
 * Trade-off (documented in research.md D1): the cache is a snapshot valid for up
 * to `cookieCache.maxAge` (1h). A server-side revocation is honored only after
 * the cache expires/refreshes. This edge check is an authorization gate for
 * ROUTING; the authoritative isolation boundary remains the DB-level `userId`
 * filter in Server Actions (see research.md D4).
 */
import { getCookieCache } from "better-auth/cookies";

export interface EdgeSession {
  /** The account id. This is the tenant id (`tenantId ≡ user.id`). */
  userId: string;
  /** The tenant's subdomain slug, carried in the signed cookie snapshot. */
  subdomain: string | null;
}

/**
 * Verify the session from the signed cache cookie. Returns `null` when there is
 * no cookie, the signature is invalid, or the cache has expired.
 *
 * @param request the incoming edge request (NextRequest extends Request)
 */
export async function getEdgeSession(
  request: Request
): Promise<EdgeSession | null> {
  // `secret` must match the one the auth server signs with. Passed explicitly so
  // verification never silently falls back to a different/default key.
  const cached = await getCookieCache(request, {
    secret: process.env.BETTER_AUTH_SECRET,
  });

  if (!cached?.user?.id) return null;

  // `subdomain` is an application additionalField on the user (see auth.ts /
  // data-model.md). It rides in the cookie snapshot, so matching a URL subdomain
  // to a tenant is a pure string compare — no DB lookup at the edge.
  const subdomain =
    typeof (cached.user as Record<string, unknown>).subdomain === "string"
      ? ((cached.user as Record<string, unknown>).subdomain as string)
      : null;

  return { userId: cached.user.id, subdomain };
}
