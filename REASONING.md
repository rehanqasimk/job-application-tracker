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

_To be written._

---

## Task 3 — Suspense Streaming for the Stats Sidebar

_To be written._

---

## Task 4 — Audit Log (Outlier Pattern)

_To be written._
