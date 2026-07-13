# Phase 1 — Data Model

Feature: Tenant Router Middleware (`001-tenant-router-middleware`)

The tenant boundary in this app is the **account**: `tenantId ≡ user.id`. No new collection is introduced. The only schema change is a `subdomain` slug on the user so the tenant is addressable and comparable at the edge.

---

## Entity: User (better-auth managed)

Managed by better-auth via the `mongodbAdapter`. Extended with one application field.

| Field | Type | Rules | Notes |
|---|---|---|---|
| `id` | string | PK (better-auth) | **This is `tenantId`.** |
| `email` | string | unique | existing |
| `name` | string | — | existing |
| **`subdomain`** | string | **unique, required, lowercase, DNS-label safe** (`^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`), not a reserved name | **NEW** — the tenant's address; serialized into the session-cache cookie so the edge can compare it. |

**Assignment**: generated at sign-up (e.g., from email local-part, normalized + de-duplicated with a numeric suffix on collision). Immutable after creation for this feature (renaming a tenant subdomain is out of scope).

**Reserved slugs** (may never be assigned): `www`, `api`, `admin`, `app`, `auth`, `static`, `assets`.

**Why it must live on the user**: `session.cookieCache` snapshots the `user` object into the signed cookie. Putting `subdomain` on the user means the edge check is a pure string compare against `user.subdomain` — no DB lookup (research D3).

---

## Entity: Session / Session-cache cookie (better-auth managed)

| Field | Type | Notes |
|---|---|---|
| `session.userId` | string | = `tenantId` |
| `session.expiresAt` | date | freshness bound |
| `user` (snapshot) | object | includes `id`, `email`, **`subdomain`** — this is what the edge reads via `getCookieCache` |

The **signed cache cookie** is the edge's source of truth. It is HMAC-signed with `BETTER_AUTH_SECRET`; tampering invalidates it. Snapshot may lag live DB state by ≤ `cookieCache.maxAge` (1h) — accepted trade (research D1).

---

## Entity: JobApplication (existing)

No shape change. Already tenant-scoped by `userId`. **Index change** for performance/isolation query support.

| Field | Existing index | Change |
|---|---|---|
| `userId` | single ✅ | keep |
| `columnId` | single ✅ | superseded by compound below |
| `boardId` | single ✅ | keep |
| **`(columnId, order)`** | — | **ADD compound index** — the board renders sort `columnId → order`; this removes an in-memory sort and supports SC-002. |

```
JobApplicationSchema.index({ columnId: 1, order: 1 });
```

---

## Entities: Board, Column (existing)

No change. Both scoped by `userId` / `boardId`. Isolation is enforced by filtering on `userId` (= `tenantId`) in every Server Action, unchanged.

---

## Relationships & isolation invariant

```
User (tenant, id = tenantId, subdomain) 1──* Board 1──* Column 1──* JobApplication
                                                                        │
                          every document carries userId = tenantId ─────┘
```

**Invariant (G2)**: for any document `D` returned to a request, `D.userId === x-tenant-id` header, and `x-tenant-id` is set by middleware from the signature-verified session. No code path may return a document whose `userId` differs from the request's verified tenant.

---

## Migration notes

- **Existing users have no `subdomain`.** A one-off backfill assigns slugs to current users (script under `scripts/`). Until backfilled, a user without `subdomain` is treated as "no tenant" and routed to an onboarding/apex fallback rather than crashing.
- Adding the compound index is online/non-breaking (`createIndex`), safe on the existing collection.
