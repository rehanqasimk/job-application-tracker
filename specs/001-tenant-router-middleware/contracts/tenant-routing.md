# Phase 1 — Contract: Tenant Routing & Header Injection

Feature: Tenant Router Middleware (`001-tenant-router-middleware`)

This is the contract between the **edge middleware** (`proxy.ts`) and the **Node app** (Server Components / Server Actions). It is the interface the assessment is really evaluating.

---

## C1 — Injected request-header contract

On any request the middleware **authorizes** (valid session, subdomain matches tenant), it forwards the request to the app with these headers set:

| Header | Value | Guarantees |
|---|---|---|
| `x-tenant-id` | `user.id` (the tenant/account id) | **Always** set by middleware from the signature-verified session. **Always overwrites** any incoming client value. Present ⇒ request is authenticated + tenant-matched. |
| `x-tenant-subdomain` | `user.subdomain` | Same guarantees; convenience for building tenant-absolute URLs. |

**Consumer rules (Node side)**:
- Read via `await headers()` (`x-tenant-id`).
- Treat `x-tenant-id` as **trusted** — but only because middleware guarantees C1. It is a routing optimization, **not** a replacement for the DB-level `userId` ownership filter, which remains authoritative (defense in depth).
- If `x-tenant-id` is absent on a route that requires tenancy, fail closed (treat as unauthorized).

**Security invariant**: a client cannot forge `x-tenant-id`. Even if a request arrives carrying `x-tenant-id: <someone-else>`, middleware overwrites it (authorized path) or never forwards it (unauthorized path).

---

## C2 — Routing behavior matrix

`ROOT_DOMAIN` = configured base (e.g. `lvh.me` dev, `app.com` prod). "Subdomain" = left label of `Host` after stripping port + `ROOT_DOMAIN`.

| # | Host / subdomain | Session (cookie-cache) | Condition | Action |
|---|---|---|---|---|
| 1 | apex or `www` | any | public + sign-in area | `next()` unchanged — no tenant headers (FR-008) |
| 2 | reserved (`api`,`admin`,…) or asset/`_next`/`/api/auth/*` | any | excluded by matcher | `next()` unchanged (FR-011, D5) |
| 3 | `user1.<root>` | none / invalid / expired | protected tenant page | **redirect** → sign-in on apex (FR-005) |
| 4 | `user1.<root>` | valid, `user.subdomain === "user1"` | authorized | `next()` **with** `x-tenant-id`, `x-tenant-subdomain` (FR-001..004) |
| 4a | `user1.<root>` **path `/`** | valid, matched | tenant home is the app, not marketing | **redirect** → `user1.<root>/dashboard` |
| 4b | apex, path ∈ `/`,`/dashboard`,`/sign-in`,`/sign-up` | valid, `user.subdomain` set | authed user on apex root/app/auth route | **redirect** → `user1.<root>/dashboard` (post-login promotion) |
| 5 | `user2.<root>` | valid, `user.subdomain === "user1"` | cross-tenant | **redirect** → `user1.<root>` (own subdomain); no user2 data (FR-006) |
| 6 | `ghost.<root>` | any | slug can't be validated (no session, or session slug ≠ host) | **redirect** to apex / safe 404; no data (FR-007) |
| 7 | any | valid, `user.subdomain` **missing** (un-backfilled) | legacy user | redirect to apex onboarding fallback (data-model migration note) |

Notes:
- Rows 5 and 6 differ by whether a session exists: with a valid session we can send the user to *their* subdomain (5); without one we can't know the intended tenant, so we fail safe (6).
- Because the edge can't DB-verify that `ghost` exists, "unknown subdomain" is defined operationally as "no valid session asserts ownership of this subdomain" → safe fallback. This is sufficient for isolation and needs no DB.

---

## C3 — Edge purity contract (G1)

`proxy.ts` and everything under `lib/tenant/` may import **only** Edge-safe modules:

**Allowed**: `next/server`, `better-auth/cookies` (`getCookieCache`, `getSessionCookie`), Web APIs (`URL`, `Headers`, `crypto.subtle`).

**Forbidden (build must fail if present in the middleware graph)**: `mongoose`, `mongodb`, `bcrypt`, any `node:*`, `lib/db.ts`, `lib/models/*`, `better-auth` server/root or adapter entrypoints, `lib/auth/auth.ts` (which imports the adapter).

**Verification**: `next build` compiles middleware for the Edge Runtime and errors on Node-only imports — the primary automated gate. Manual: grep the import graph of `proxy.ts`.

---

## C4 — Config contract (environment)

| Var | Purpose | Dev value |
|---|---|---|
| `MONGODB_URI` | app DB (Node only) | existing |
| `BETTER_AUTH_SECRET` | **signs/verifies** session + cache cookies; required for `getCookieCache` at the edge | **must add** |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | auth client base URL | set to apex, e.g. `http://lvh.me:3000` |
| `ROOT_DOMAIN` | base domain for subdomain parsing + cross-subdomain cookie domain | `lvh.me` |

Cross-subdomain cookie: `auth.ts` sets `advanced.crossSubDomainCookies` to `{ enabled: true, domain: ROOT_DOMAIN }` so the session/cache cookies are readable on every `*.<ROOT_DOMAIN>` (contract dependency for rows 3–5 to work).
