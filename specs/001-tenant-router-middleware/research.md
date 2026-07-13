# Phase 0 — Research & Key Decisions

Feature: Tenant Router Middleware (`001-tenant-router-middleware`)

Each decision records **what** was chosen, **why**, and the **alternatives rejected** — written so it can be defended in review.

---

## D1 — Edge-safe session validation

**Decision**: Verify the session in middleware by reading the **signed session-cache cookie** via better-auth's `getCookieCache(request)` (from `better-auth/cookies`). No database, no `auth.api.*`, no Node modules.

**Why**:
- `lib/auth/auth.ts` already enables `session.cookieCache` (`maxAge` 1h). better-auth signs a cookie containing a `{ session, user }` snapshot. `getCookieCache` verifies that signature with **Web Crypto (HMAC)** — which exists in the Edge Runtime — and returns the payload with zero I/O.
- Confirmed present in the installed version: `better-auth@1.4.3` exports `getSessionCookie` and `getCookieCache` from `better-auth/cookies`.
- Eliminates a per-request DB round-trip in the hot path (supports SC-002, ≤50 ms p95).

**Why the current code crashes at the edge**: `getSession()` → `auth.api.getSession()` uses the `mongodbAdapter`, importing `mongoose` (native `net`/`tls`/`dns`) and transitively `bcrypt` (native `.node` bindings). The Edge Runtime is a V8 isolate with no Node APIs → module resolution/instantiation fails.

**Alternatives rejected**:
- *Call `auth.api.getSession()` in middleware* — the exact trap; pulls Node/native modules into the edge. ✗
- *Add the JWT plugin and verify a JWT* — viable and stateless, but adds a new dependency, new signing keys, and a token-issuance flow for a capability the enabled `cookieCache` already provides. ✗ (over-engineered for scope)
- *Run middleware in the Node.js runtime* (`export const runtime = 'nodejs'`, supported on Vercel Fluid Compute) — sidesteps the constraint but (a) re-introduces the per-request DB lookup and its latency, and (b) the assessment explicitly asks for a **Node-module-free** edge solution. Noted as a real-world option; not chosen here. ✗

**Consequence to document**: cookie-cache is a *cached snapshot*. A session revoked server-side is still honored until the cache cookie expires (≤1h) or is refreshed. This is an intentional freshness-vs-latency trade. Sensitive mutations (delete account, revoke) still run in Node with a live check; the edge check is an **authorization gate for routing**, not the last line of defense.

---

## D2 — Resolving the tenant from the subdomain

**Decision**: Parse the `Host` header, strip the port and the configured `ROOT_DOMAIN`, and treat the left-most label as the tenant slug. Drive `ROOT_DOMAIN` from an env var (`lvh.me` in dev, real domain in prod). Reserved labels (`www`, `api`, `admin`, empty/apex) bypass tenant routing.

**Why**: `Host` is always present and available at the edge. Env-driven base domain keeps one code path for dev and prod. `lvh.me` wildcard-resolves to `127.0.0.1` and — being a real registered domain **not** on the Public Suffix List — allows a parent-domain (`.lvh.me`) session cookie so the session set at the apex is readable on every tenant subdomain (see D3). See [quickstart.md](quickstart.md) for the local-DNS rationale and the rebinding-protection fallback.

**Alternatives rejected**:
- *Path-based tenancy* (`/t/user1/...`) — spec requires subdomains; also weaker isolation ergonomics. ✗
- *`*.localhost` for dev* — no config needed, but browsers frequently refuse a parent-domain cookie on bare `.localhost`, breaking cross-subdomain session sharing. ✗

---

## D3 — How the subdomain maps to a tenant *without a DB lookup*

**Decision**: The tenant identity is derived from the **session**, not from a DB lookup on the slug. Add a unique `subdomain` field to the better-auth user (via `additionalFields`), assigned at sign-up. Because `cookieCache` serializes the `user` object, `user.subdomain` and `user.id` are available in middleware from the cookie. The middleware compares the URL's subdomain against `user.subdomain`.

**Why**: The edge cannot query "which account owns slug `user1`?" (that's a DB read). Carrying the slug in the signed session snapshot makes the check a pure string comparison, preserving edge purity (G1) and the latency budget. `tenantId ≡ user.id`.

**Alternatives rejected**:
- *DB/Edge-Config lookup slug → tenant* — a network read per request; violates the zero-round-trip goal. (Edge Config would be the right tool if tenants must be resolvable **without** a session — e.g., public tenant pages — but this app has none.) ✗
- *Subdomain = raw user id* — leaks ids in URLs and is unfriendly. ✗

---

## D4 — Propagating tenant identity downstream (and preventing spoofing)

**Decision**: On an authorized request, middleware sets request headers via `NextResponse.next({ request: { headers } })`:
- `x-tenant-id` = `user.id`
- `x-tenant-subdomain` = `user.subdomain`

Middleware **always** writes these from the verified session, **overwriting** any values the client sent. Server Actions/Components read `x-tenant-id` from `headers()` and scope all queries by it.

**Why**: Header injection is the idiomatic Next.js middleware→app channel. Unconditional overwrite is the critical isolation control (G2): otherwise a client could forge `x-tenant-id` and read another tenant's data. Downstream code trusts the header **only because** middleware guarantees it.

**Defense-in-depth note**: Server Actions keep their existing `userId` ownership checks. The header optimizes the common path (no second session fetch) but the DB-level `userId` filter remains the authoritative isolation boundary. Removing the redundant `getSession()` call in actions is the perf win; the ownership check stays.

**Alternatives rejected**:
- *Cookies / search params for tenant* — spoofable and cache-polluting. ✗
- *Trust header without overwrite* — critical vulnerability. ✗

---

## D5 — Which requests the middleware guards

**Decision**: `matcher` excludes Next internals and static assets (`_next/static`, `_next/image`, `favicon.ico`, public files) and the better-auth API routes (`/api/auth/*`, which must reach the Node runtime to sign in). Apex/`www` requests serve public + sign-in flows unchanged. Unauthenticated requests to a tenant subdomain → redirect to sign-in on the apex. Authenticated request whose subdomain ≠ `user.subdomain` → redirect to the user's own subdomain.

**Why**: Keeps auth endpoints reachable, avoids running edge logic on assets (latency + correctness), and encodes FR-005/006/007/008/011. Full matrix in [contracts/tenant-routing.md](contracts/tenant-routing.md).

---

## D6 — Adjacent performance leak surfaced (scoped OUT here)

**Observation**: `updateJobApplication` in `lib/actions/job-applications.ts` reorders cards with **sequential** `await JobApplication.findByIdAndUpdate(...)` inside three separate loops — O(n) serial DB round-trips per drag. Invisible at 3 cards, pathological at 300. Also: `lib/auth/auth.ts` runs a **top-level `await connectDB()`** at module load (cold-start blocker), and there is no compound `(columnId, order)` index for the sort-heavy queries.

**Decision**: Out of scope for this feature's spec (Task 1). The **one** perf item folded in here is the `(columnId, order)` compound index, because the tenant-scoped board queries lean on it and it directly supports SC-002. The `bulkWrite` refactor and the top-level-await fix are recorded for a **follow-up spec** (`002-perf-leaks`) so this feature stays reviewable and single-purpose.

---

## Open questions resolved

All spec assumptions hold; no `NEEDS CLARIFICATION` remain. `BETTER_AUTH_SECRET` and `ROOT_DOMAIN` must be added to the environment (currently only `MONGODB_URI` is set) — captured in [quickstart.md](quickstart.md).
