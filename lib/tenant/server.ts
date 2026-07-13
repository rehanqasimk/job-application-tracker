/**
 * Node-side accessor for the tenant injected by proxy.ts.
 *
 * The middleware sets `x-tenant-id` (and `x-tenant-subdomain`) from the
 * signature-verified session and ALWAYS overwrites any client-supplied value
 * (contract C1). Server Components / Server Actions read it here.
 *
 * Trust model: the header is trusted ONLY because middleware guarantees it. It's
 * a fast-path that avoids a second session fetch — NOT a replacement for the
 * DB-level `userId` ownership filter, which remains the authoritative isolation
 * boundary (research.md D4).
 */
import { headers } from "next/headers";

/** Injected header names — keep in sync with proxy.ts. */
export const TENANT_ID_HEADER = "x-tenant-id";
export const TENANT_SUBDOMAIN_HEADER = "x-tenant-subdomain";

/** Returns the tenant id, or `null` if the request wasn't tenant-routed. */
export async function getTenantId(): Promise<string | null> {
  const h = await headers();
  return h.get(TENANT_ID_HEADER);
}

/**
 * Like getTenantId but throws when absent — use on routes that require a tenant
 * so a misconfiguration fails closed instead of leaking across tenants.
 */
export async function requireTenantId(): Promise<string> {
  const id = await getTenantId();
  if (!id) throw new Error("Missing tenant context (x-tenant-id)");
  return id;
}

export async function getTenantSubdomain(): Promise<string | null> {
  const h = await headers();
  return h.get(TENANT_SUBDOMAIN_HEADER);
}
