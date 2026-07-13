/**
 * Tenant subdomain-slug generation. Runs in the Node runtime (at sign-up and in
 * the backfill script), but kept dependency-free so it's trivially testable.
 */
import { RESERVED_SUBDOMAINS } from "./subdomain";

// A valid DNS label: starts/ends alphanumeric, 1–63 chars, hyphens allowed
// internally. This is what can legally appear as `<slug>.<root-domain>`.
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return DNS_LABEL.test(slug) && !RESERVED_SUBDOMAINS.has(slug);
}

/**
 * Derive a base slug from an email local-part (or any string):
 *   "Jane.Doe+jobs@gmail.com" -> "jane-doe-jobs"
 * Non-alphanumeric runs collapse to a single hyphen; edges are trimmed.
 * Falls back to "user" if nothing usable remains.
 */
export function generateSlug(email: string): string {
  const local = email.split("@")[0] ?? email;
  let slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, ""); // re-trim if the 63-char cut left a trailing hyphen

  if (!slug || slug.length < 2 || RESERVED_SUBDOMAINS.has(slug)) {
    slug = slug ? `${slug}-user` : "user";
  }
  return slug;
}

/**
 * Ensure a slug is unique by probing with a caller-supplied existence check,
 * appending -2, -3, … on collision. The caller owns the DB query so this stays
 * storage-agnostic and edge-import-free.
 *
 * @param base       desired slug (already normalized)
 * @param exists     async predicate: does a user already own this slug?
 */
export async function ensureUniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  if (!(await exists(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 63);
    if (!(await exists(candidate))) return candidate;
  }
  // Extremely unlikely; last resort keeps sign-up from hard-failing.
  return `${base}-${Date.now()}`.slice(0, 63);
}
