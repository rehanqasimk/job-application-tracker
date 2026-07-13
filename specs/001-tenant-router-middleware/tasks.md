---
description: "Task list for Tenant Router Middleware"
---

# Tasks: Tenant Router Middleware

**Input**: Design documents from `/specs/001-tenant-router-middleware/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/tenant-routing.md](contracts/tenant-routing.md), [quickstart.md](quickstart.md)

**Tests**: No test framework is installed and the spec did not request TDD. Verification is manual via the quickstart contract matrix (C2). No test tasks are generated.

**Scope note**: Performance leaks (`bulkWrite` reorder in `job-applications.ts`, top-level `await connectDB()` in `auth.ts`) are **deferred to a separate `002-perf-leaks` spec** per user decision. Only the `(columnId, order)` index — needed by this feature's tenant-scoped queries — is included here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (from spec.md)

## ⚠️ Shared-file dependency (read first)

US1, US2, and US3 all modify the **same file** `proxy.ts`. US1 lays down the middleware skeleton; US2 and US3 add branches to it. They are therefore **sequential on `proxy.ts`**, not parallel — even though they are independently *testable* (each contract row can be verified on its own once its branch exists). This is called out honestly rather than faked as parallel.

---

## Phase 1: Setup

**Purpose**: Environment prerequisites for edge cookie verification and subdomain routing.

- [X] T001 Add required env vars to `.env` and create `.env.example` documenting them: `BETTER_AUTH_SECRET` (generate via `openssl rand -base64 32`), `ROOT_DOMAIN=lvh.me`, `NEXT_PUBLIC_BETTER_AUTH_URL=http://lvh.me:3000` (see [contracts/tenant-routing.md](contracts/tenant-routing.md) C4)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Edge-pure helpers, the tenant slug field, and the supporting index. **Blocks all user stories.**

**⚠️ Edge purity (G1)**: `lib/tenant/subdomain.ts` and `lib/tenant/session-edge.ts` MUST import only `better-auth/cookies` + Web APIs — never `lib/db.ts`, `lib/models/*`, or `lib/auth/auth.ts`.

- [X] T002 [P] Create edge-pure `lib/tenant/subdomain.ts`: `getSubdomain(host, rootDomain)` strips port + `ROOT_DOMAIN` and returns the tenant label or `null` for apex/`www`; export `RESERVED_SUBDOMAINS` (`www,api,admin,app,auth,static,assets`) and `isReserved(label)`
- [X] T003 [P] Create edge-pure `lib/tenant/session-edge.ts`: wrap `getCookieCache` (from `better-auth/cookies`) as `getEdgeSession(request)` → returns `{ userId, subdomain } | null`; no DB, no Node imports (see [research.md](research.md) D1)
- [X] T004 [P] Add compound index `JobApplicationSchema.index({ columnId: 1, order: 1 })` in `lib/models/job-application.ts` ([data-model.md](data-model.md))
- [X] T005 Create `lib/tenant/slug.ts`: `generateSlug(email)` → lowercase DNS-safe label matching `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`, rejects `RESERVED_SUBDOMAINS` (imports from `lib/tenant/subdomain.ts`)
- [X] T006 Add `user.subdomain` additionalField (unique) and `advanced.crossSubDomainCookies = { enabled: true, domain: process.env.ROOT_DOMAIN }` in `lib/auth/auth.ts`; keep `cookieCache` enabled (depends on T005 for slug reuse)
- [X] T007 Assign `subdomain` on sign-up in the existing `databaseHooks.user.create` flow in `lib/auth/auth.ts`, de-duplicating on collision with a numeric suffix (depends on T005, T006)
- [X] T008 [P] Create backfill script `scripts/backfill-subdomains.ts` to assign slugs to pre-existing users (depends on T005)

**Checkpoint**: Helpers exist and are import-audited edge-pure; users have `subdomain`; cookies are cross-subdomain.

---

## Phase 3: User Story 1 - Tenant-isolated access via subdomain (Priority: P1) 🎯 MVP

**Goal**: A signed-in user on their subdomain has `x-tenant-id` injected and sees only their own data.

**Independent Test**: Sign in, open `http://<slug>.lvh.me:3000/dashboard`; board loads and `x-tenant-id` is present downstream; a second account's data is never visible (SC-001).

- [X] T009 [P] [US1] Create Node-side `lib/tenant/server.ts` with `getTenantId()` that reads `x-tenant-id` from `await headers()` and fails closed (throws/returns unauthorized) if absent (contract C1)
- [X] T010 [US1] Rewrite `proxy.ts` core (Edge): parse subdomain via `lib/tenant/subdomain.ts`, verify session via `lib/tenant/session-edge.ts`; on the **authorized** path (session valid AND `subdomain === session.subdomain`) forward with `NextResponse.next({ request: { headers } })` setting `x-tenant-id` and `x-tenant-subdomain`, **always overwriting** any incoming values (G2/anti-spoof); add `export const config = { matcher }` excluding `_next/static`, `_next/image`, `favicon.ico`, public assets, and `/api/auth/*` (research D5)
- [X] T011 [US1] Refactor `lib/actions/job-applications.ts` to obtain the tenant via `getTenantId()` (header) instead of a redundant `getSession()` call, while **keeping** the existing `userId` ownership filters as the authoritative isolation boundary (defense-in-depth, research D4)
- [X] T012 [US1] Verify/adjust `app/dashboard/page.tsx` board fetch so it is scoped by the tenant id (matches the injected header)

**Checkpoint**: MVP — tenant sees only their own applications; header contract holds.

---

## Phase 4: User Story 2 - Reliable session validation at entry (Priority: P2)

**Goal**: Requests are gated by a valid session before content is served; unauthenticated users go to sign-in.

**Independent Test**: Signed out, `http://user1.lvh.me:3000/dashboard` → redirect to sign-in; apex still serves marketing/sign-in (C2 rows 1, 3).

- [X] T013 [US2] Add the unauthenticated branch to `proxy.ts`: a tenant-subdomain request with no valid edge session → `NextResponse.redirect` to sign-in on the apex (FR-005) (depends on T010)
- [X] T014 [US2] Add the apex/`www` passthrough branch to `proxy.ts`: `getSubdomain` returns `null` or reserved → `next()` unchanged, no tenant headers (FR-008) (depends on T010)

**Checkpoint**: Auth gating works; public area unaffected.

---

## Phase 5: User Story 3 - Safe handling of unknown & mismatched subdomains (Priority: P3)

**Goal**: Cross-tenant and unknown-subdomain requests fail closed with no data leakage.

**Independent Test**: As `user1`, open `user2.lvh.me` → redirect to `user1.lvh.me`; open `ghost.lvh.me` signed-out → safe fallback; no foreign data in either (C2 rows 5, 6, 7).

- [X] T015 [US3] Add the cross-tenant branch to `proxy.ts`: valid session but `subdomain !== session.subdomain` → redirect to the user's own subdomain; never forward tenant headers for the mismatched tenant (FR-006) (depends on T010)
- [X] T016 [US3] Add the unknown-subdomain branch to `proxy.ts`: subdomain that no valid session asserts ownership of → safe redirect to apex / 404, no data (FR-007) (depends on T010)
- [X] T017 [US3] Add the legacy-user branch to `proxy.ts`: valid session whose `subdomain` is missing (un-backfilled) → redirect to apex onboarding fallback (data-model migration note) (depends on T010)

**Checkpoint**: All C2 rows behave per contract.

---

## Phase 6: Polish & Cross-Cutting

**Purpose**: Prove the gates and document, without expanding scope.

- [X] T018 [P] Edge-purity gate (G1/C3): run `npm run build` (must succeed) and confirm the `proxy.ts` import graph reaches only `next/server` + `better-auth/cookies` — a Node-only import in the middleware graph fails the Edge compile
- [~] T019 [P] Execute the quickstart verification matrix ([quickstart.md](quickstart.md) §4–6). DONE via curl: rows 1 (apex 200), 2 (assets bypass), 3 (tenant→sign-in 307), + edge middleware runs with no runtime crash. PENDING (needs real sign-in with two accounts): rows 4 (isolation), 5 (cross-tenant redirect), 7 (legacy), and DB-query-count check for SC-002.
- [X] T020 [P] Update `README.md` with the multi-tenant local-dev setup (`lvh.me`, env vars, cross-subdomain cookie) referencing quickstart
- [X] T021 Record the deferred follow-up as a stub for spec `002-perf-leaks` (bulkWrite reorder in `lib/actions/job-applications.ts`, top-level `await connectDB()` in `lib/auth/auth.ts`) — documentation only, no code change here

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002–T008)** → **User Stories** → **Polish**.
- Within Foundational: T005 → {T006, T008}; T006 → T007. T002, T003, T004 are independent `[P]`.
- **US1 T010 is the linchpin**: T013–T017 (US2, US3) all edit the same `proxy.ts` and depend on T010. They run **sequentially** on that file, in the order listed.
- T009, T011, T012 touch different files from the `proxy.ts` branches and from each other (mostly) — T009 is `[P]`.

### Parallel opportunities

```bash
# Phase 2 — independent edge-pure helpers + index:
T002 lib/tenant/subdomain.ts
T003 lib/tenant/session-edge.ts
T004 lib/models/job-application.ts (index)

# Phase 6 — verification/docs:
T018 build/edge-purity gate
T019 quickstart matrix
T020 README
```

---

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3 (US1)**: subdomain → verified session → injected `x-tenant-id` → isolated data. Demo-able on its own.
- **Increment US2**: add auth gating + apex passthrough.
- **Increment US3**: add mismatch/unknown/legacy safety branches.
- Each increment adds `proxy.ts` branches without breaking earlier rows; re-run the relevant quickstart rows after each.

## Notes

- The authoritative isolation boundary stays the DB-level `userId` filter; the header is a verified fast-path, not a substitute (research D4).
- Keep every `lib/tenant/*` module free of Node/DB imports — the `npm run build` edge compile (T018) is the automated guard.
