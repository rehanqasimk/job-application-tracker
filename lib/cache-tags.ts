/**
 * Cache tag helpers for tag-based revalidation (Task 2).
 *
 * A single source of truth for tag strings so the reader (`cacheTag` inside the
 * cached job-list read) and the writers (`revalidateTag` in the Server Actions)
 * can never drift — a typo in one place would silently break invalidation.
 *
 * Tags are TENANT-SCOPED (`jobs:<tenantId>`): adding a job for one tenant purges
 * only that tenant's job-list cache, never another tenant's (ties into the
 * tenant isolation from Task 1).
 */
export function jobsTag(tenantId: string): string {
  return `jobs:${tenantId}`;
}
