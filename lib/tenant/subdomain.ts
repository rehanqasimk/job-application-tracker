/**
 * Edge-pure subdomain parsing.
 *
 * ⚠️ EDGE PURITY (constitution gate G1): this file runs inside the Edge Runtime
 * via proxy.ts. It MUST NOT import anything Node-only — no `mongoose`, `mongodb`,
 * `bcrypt`, `node:*`, `lib/db`, `lib/models/*`, or the auth server/adapter.
 * Plain string logic + Web APIs only.
 */

/**
 * Subdomains that are never a tenant. The apex, `www`, and infra/reserved names
 * fall through the tenant router untouched (marketing, auth, assets, APIs).
 */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "auth",
  "static",
  "assets",
]);

export function isReserved(label: string): boolean {
  return RESERVED_SUBDOMAINS.has(label.toLowerCase());
}

/**
 * Extract the tenant slug from a request Host header.
 *
 * Handles the dev/prod split via `rootDomain` (env `ROOT_DOMAIN`):
 *   dev :  "user1.lvh.me:3000"  + "lvh.me"  -> "user1"
 *   prod:  "user1.app.com"      + "app.com" -> "user1"
 *
 * Returns `null` when there is no tenant subdomain to act on:
 *   - the apex itself            ("lvh.me")            -> null
 *   - a reserved label           ("www.lvh.me")        -> null
 *   - host doesn't end in root   ("evil.com")          -> null
 *   - multi-level (not supported)("a.b.lvh.me")        -> null  (single-label tenants only)
 *
 * @param host        raw `Host` header value (may include `:port`)
 * @param rootDomain  configured base domain (no port)
 */
export function getSubdomain(
  host: string | null,
  rootDomain: string
): string | null {
  if (!host || !rootDomain) return null;

  // Strip port and lowercase for a stable comparison.
  const hostname = host.split(":")[0].toLowerCase().trim();
  const root = rootDomain.split(":")[0].toLowerCase().trim();

  // Apex itself is not a tenant.
  if (hostname === root) return null;

  // Must be a subdomain OF the configured root, not an unrelated host.
  const suffix = `.${root}`;
  if (!hostname.endsWith(suffix)) return null;

  // Everything to the left of the root domain.
  const label = hostname.slice(0, -suffix.length);

  // We only support single-label tenants (`user1`), not nested (`a.b`).
  if (label.length === 0 || label.includes(".")) return null;

  if (isReserved(label)) return null;

  return label;
}
