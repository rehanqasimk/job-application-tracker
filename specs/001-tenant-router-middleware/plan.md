# Implementation Plan: Tenant Router Middleware

**Branch**: `001-tenant-router-middleware` | **Date**: 2026-07-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-tenant-router-middleware/spec.md`

## Summary

Route every request through the Next.js middleware layer (`proxy.ts`), resolve the **tenant from the request subdomain**, validate the visitor's session **without touching MongoDB or any Node-only module**, and inject a trusted `x-tenant-id` header for downstream Server Components and Server Actions to scope their queries.

The technical crux (from the spec's FR-009 and the assessment prompt): the current middleware calls `getSession()` → `auth.api.getSession()` → the Mongoose/MongoDB adapter. That pulls `mongoose` (native `net`/`tls`/`dns`) and, transitively, `bcrypt` (native bindings) into the Edge Runtime, which has no Node.js APIs — so it crashes. The resolution is to verify the session from the **signed session-cache cookie** using Web Crypto (edge-native), which is already enabled in this codebase (`session.cookieCache` in `lib/auth/auth.ts`). better-auth exposes `getCookieCache(request)` for exactly this: it reads and signature-verifies the cookie and returns `{ session, user }` with **zero DB round-trips**.

This also removes an "invisible" performance leak: today the middleware would issue a database session lookup on every navigation. Cookie-cache verification is CPU-only and keeps the routing layer within the ≤50 ms p95 budget (SC-002).

## Technical Context

**Language/Version**: TypeScript 5, Node execution for app; **Edge Runtime (V8 isolate)** for middleware
**Primary Dependencies**: Next.js 16.0.7 (App Router, `proxy.ts` convention), React 19.2, better-auth 1.4.3 (`mongodbAdapter`, `cookieCache` enabled), mongoose 9 / mongodb 7 (app runtime only — **never** imported into middleware)
**Storage**: MongoDB (accessed only from Node runtime: Server Components, Server Actions, route handlers)
**Session mechanism**: better-auth signed cookies. Two cookies matter: the session token cookie and the **signed session-cache cookie** (`cookieCache`, `maxAge` 1h) that carries a serialized `{ session, user }` snapshot.
**Testing**: Manual + scripted verification via quickstart (no test framework installed; contract behavior matrix drives verification)
**Target Platform**: Vercel, globally distributed (middleware runs at the edge in every region)
**Project Type**: Web application (Next.js full-stack, single project)
**Performance Goals**: Middleware adds ≤50 ms p95 (SC-002); **zero DB round-trips** in the routing layer
**Constraints**: Middleware must use **only** Edge-compatible APIs (Web Crypto, `URL`, `Headers`, `NextRequest`/`NextResponse`). No `mongoose`, `mongodb`, `bcrypt`, `node:*`, or `auth.api.*` (adapter-backed) calls.
**Scale/Scope**: One tenant per account; tenant addressed by a unique subdomain slug carried in the session snapshot.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is an **unratified template** (placeholder principles only). There are therefore no ratified gates to enforce. In their absence, this plan self-imposes the two constraints the assessment implies and treats them as hard gates:

| Self-imposed gate | Status |
|---|---|
| **G1 — Edge purity**: middleware imports zero Node-only/native modules (verified by inspecting the module graph of `proxy.ts`). | ✅ Design honors it (Phase 0 decision D1). |
| **G2 — Tenant isolation**: no request path can read another tenant's data; the injected `x-tenant-id` is server-set and always overwrites any client-supplied value. | ✅ Design honors it (contract C1, decision D4). |

No violations to justify → Complexity Tracking omitted.

**Post-Phase-1 re-check**: Design keeps `lib/tenant/*` free of Node imports (G1) and makes header injection unconditional/overwriting (G2). Gates still pass. ✅

## Project Structure

### Documentation (this feature)

```text
specs/001-tenant-router-middleware/
├── plan.md              # This file
├── spec.md              # Feature spec
├── research.md          # Phase 0 — key technical decisions
├── data-model.md        # Phase 1 — entities, new fields, indexes
├── quickstart.md        # Phase 1 — local dev setup + verification steps
├── contracts/
│   └── tenant-routing.md # Phase 1 — header contract + routing behavior matrix
└── checklists/
    └── requirements.md   # Spec quality checklist (from /speckit-specify)
```

### Source Code (repository root)

```text
proxy.ts                       # REWRITE — subdomain → tenant, edge-safe session check, header injection
lib/
├── auth/
│   ├── auth.ts                # EDIT — add `user.subdomain` additionalField; keep cookieCache enabled
│   └── auth-client.ts         # unchanged
├── tenant/                    # NEW — edge-safe helpers (no Node imports)
│   ├── subdomain.ts           # parse Host → tenant slug; reserved-name handling; ROOT_DOMAIN
│   └── session-edge.ts        # thin wrapper over better-auth getCookieCache/getSessionCookie
├── actions/
│   └── job-applications.ts    # EDIT — read tenant from injected header instead of re-fetching session
├── models/                    # EDIT — add compound index (columnId, order) [perf, supports SC-002 story]
└── db.ts                      # unchanged (global cache pattern is already correct)
```

**Structure Decision**: Single Next.js project. The only new directory is `lib/tenant/`, which is deliberately isolated and **import-audited** to guarantee edge purity (G1): nothing under it may transitively import `lib/db.ts`, `lib/models/*`, or `better-auth` server/adapter entrypoints — only `better-auth/cookies`.

## Complexity Tracking

No constitution violations. Section intentionally empty.
