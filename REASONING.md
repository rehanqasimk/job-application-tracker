# Architectural Log

Reasoning behind each task. Each section explains the problem, the approach, the
key decisions, and the trade-offs I accepted.

---

## Task 1 — Middleware-Level Tenant Router

### The problem

The app must route tenants by subdomain (`user1.<domain>`) and validate the
session **in middleware**. But middleware runs in the **Edge Runtime** (a V8
isolate with no Node.js APIs), and the existing session path
(`auth.api.getSession()` → the MongoDB adapter) transitively imports `mongoose`
(native `net`/`tls`/`dns`) and `bcrypt` (native bindings). Those cannot load at
the edge, so the middleware crashes.

### The core insight

**Authenticate in Node; authorize at the edge.** Password verification and
session creation stay in the Node runtime (the `/api/auth` route). The edge only
needs to *read* an already-established session — and it can do that from a
**signed cookie** instead of the database.

better-auth's `session.cookieCache` (already enabled in this repo) writes a
signed cookie containing a `{ session, user }` snapshot. The edge helper
`getCookieCache()` (from `better-auth/cookies`) verifies that cookie's HMAC with
`BETTER_AUTH_SECRET` using **Web Crypto** (edge-native) and returns the payload
with **zero database round-trips**. This is both edge-safe and fast (no per-request
DB hit — a latency win over the naive approach).

### Tenant resolution without a DB lookup

The edge cannot cheaply answer "which account owns the slug `user1`?" — that's a
DB read. Instead I store the tenant's `subdomain` slug **on the user record**, so
it is serialized into the session-cache cookie. Matching the URL's subdomain to
the tenant is then a pure **string comparison** against `session.user.subdomain`.

Consequence (accepted): the tenant mapping only exists for a logged-in user, so
there are no public (session-less) tenant pages. This app has none. If that were
required later, the right tool is a slug→tenant map in Edge Config (still
edge-pure, one fast read) — not a DB call in middleware.

### Injecting and trusting the tenant id (anti-spoofing)

On an authorized request the middleware forwards `x-tenant-id` (= `user.id`) via
`NextResponse.next({ request: { headers } })`, **always overwriting** any inbound
value. That overwrite is the security control: a client cannot forge
`x-tenant-id`, because middleware sets it from the verified session or never
forwards it at all. Server Actions read it via `headers()`.

Defense in depth: the header is a fast-path, **not** the isolation boundary. The
authoritative boundary remains the `userId` filter on every Mongo query. Removing
the redundant `getSession()` calls from the actions is the perf benefit; the
ownership filter stays.

### Request lifecycle (post-login)

```
POST /api/auth/sign-in/email   (Node; matcher excludes /api/auth)
  → bcrypt verify + create session + Set-Cookie (domain=.<ROOT_DOMAIN>)
router.push("/dashboard") → apex /dashboard
  → middleware (edge): apex + valid session → 307 to <slug>.<root>/dashboard
<slug>.<root>/dashboard
  → middleware (edge): subdomain == session.subdomain → inject x-tenant-id → next()
  → page (Node): getTenantId() → board scoped to tenant → render
```

### Notable decisions & trade-offs

- **Dev domain `lvh.me`, not `app.local`.** The brief used `app.local`, but on
  macOS `.local` is claimed by mDNS/Bonjour (slow/failing lookups), and bare
  `*.localhost` makes browsers refuse the parent-domain cookie needed to share a
  session across subdomains. `*.lvh.me` publicly resolves to `127.0.0.1` and,
  being a normal registered domain, permits a `.lvh.me` cookie. Env-driven
  (`ROOT_DOMAIN`), so prod only changes the value.
- **Cross-subdomain cookies + same-origin auth client.** Cookies are shared via
  `advanced.crossSubDomainCookies` (`domain=.<ROOT_DOMAIN>`). Separately, the
  auth *client* must call same-origin on each subdomain — cookies and CORS are
  different gates; a hardcoded apex client URL made `useSession()` a CORS-blocked
  cross-origin call and the navbar showed logged-out.
- **Cookie-cache freshness.** The snapshot can lag a server-side revocation by up
  to `cookieCache.maxAge` (1h). Acceptable because the edge check gates
  *routing*; the DB `userId` filter is the real isolation.
- **Apex = public/marketing + auth; subdomain = the app.** A logged-in visitor is
  bounced off the apex root/auth routes (`/`, `/dashboard`, `/sign-in`,
  `/sign-up`) onto their tenant, and a tenant's `/` redirects to `/dashboard`
  (marketing never renders under a tenant; anonymous visitors still get the apex
  landing page).

### Edge-purity guard

`proxy.ts` and `lib/tenant/{subdomain,session-edge}.ts` import only `next/server`
and `better-auth/cookies` + Web APIs. `next build` compiles the middleware for the
Edge Runtime and **fails** if a Node-only module ever leaks in — that build is the
automated regression guard.

### Key files

| File | Role |
|------|------|
| `proxy.ts` | The router: parse subdomain → verify session → route → inject header |
| `lib/tenant/subdomain.ts` | Host → tenant slug (edge-pure) |
| `lib/tenant/session-edge.ts` | `getCookieCache()` wrapper — edge-safe session verify |
| `lib/tenant/server.ts` | Node side: read `x-tenant-id` back from headers |
| `lib/auth/auth.ts` | `user.subdomain` field, slug assignment, cross-subdomain cookies |
| `lib/auth/auth-client.ts` | Same-origin auth client (subdomain-safe `useSession`) |
| `lib/actions/job-applications.ts` | Scope by injected tenant id (dropped redundant `getSession`) |

---

## Task 2 — Tag-Based Revalidation

### The problem

The job-list read was cached with `"use cache"` but **untagged**, and every
mutation called `revalidatePath("/dashboard")`. `revalidatePath` is the coarse,
path-level hammer: it purges *everything* rendered at `/dashboard` (the whole
layout, and — once Task 3 lands — the Stats sidebar too), and it is not
tenant-aware. That is the "AI trap" the brief calls out: reaching for
`revalidatePath` when the intent is to purge only the Jobs data.

### The solution

1. **Tag the cached read.** `getBoard()` now calls `cacheTag(jobsTag(tenantId))`
   inside its `"use cache"` body (`app/dashboard/page.tsx`).
2. **Purge by tag in the Server Action.** The three actions (create / update /
   delete) purge that tag instead of calling `revalidatePath`. Only the Jobs
   cache entry is invalidated; the rest of the layout stays cached.
3. **Tenant-scoped tags.** The tag is `jobs:<tenantId>` (via `lib/cache-tags.ts`,
   a single source of truth so reader and writer can't drift). Adding a job for
   one tenant purges only *that* tenant's list — never another tenant's. This
   directly composes with the Task 1 isolation model.

### `revalidateTag` vs `updateTag` — followed the brief, then corrected on evidence

The brief asks for `revalidateTag` within a Server Action, so that is where I
started: `revalidateTag(jobsTag(tenantId), "max")` (Next 16 made the second
cache-life-profile argument mandatory). It compiled and purged the correct tag.

**But testing exposed a Next-16 semantics gap.** After adding a job, the new card
did **not** appear until a manual reload. The reason: under `cacheComponents`,
`revalidateTag` is **stale-while-revalidate** — the Server Action *does* trigger a
route re-render, but that immediate re-render is served the *stale* cached
`getBoard`; the tag only regenerates on a *later* request. So `revalidateTag`
alone cannot satisfy the brief's own goal ("when a new application is added" it
should show up).

The fix is `updateTag(jobsTag(tenantId))` — Next 16's Server-Action
**read-your-writes** primitive (its own deprecation notice for single-arg
`revalidateTag` points here). It expires the tag *immediately*, so the action's
re-render reads fresh data and the job appears at once. It is still tag-based and
tenant-scoped — the actual lesson under test (targeted invalidation, **not**
`revalidatePath`) is fully honored; only the specific function changed, for a
reason proven by testing.

| | Semantics | Use |
|---|---|---|
| `revalidateTag(tag, profile)` | background / stale-while-revalidate | route handlers, webhooks, cron |
| **`updateTag(tag)`** ← used | immediate, same-request read-your-writes | **mutation in a Server Action** |

### Key files

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | `cacheTag(jobsTag(tenantId))` on the `"use cache"` job read |
| `lib/actions/job-applications.ts` | `revalidatePath("/dashboard")` → `updateTag(jobsTag(tenantId))` (×3) |
| `lib/cache-tags.ts` | shared, tenant-scoped `jobsTag()` helper |

---

## Task 3 — Suspense Streaming for the Stats Sidebar

_To be written._

---

## Task 4 — Audit Log (Outlier Pattern)

_To be written._
