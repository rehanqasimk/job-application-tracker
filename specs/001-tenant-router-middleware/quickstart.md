# Phase 1 — Quickstart: Local Dev & Verification

Feature: Tenant Router Middleware (`001-tenant-router-middleware`)

Goal: run the multi-tenant app locally with working subdomains and cross-subdomain sessions, then verify each row of the [routing contract](contracts/tenant-routing.md).

---

## 1. Environment

Add to `.env` (only `MONGODB_URI` exists today):

```bash
MONGODB_URI=...                       # existing
BETTER_AUTH_SECRET=<generate>         # openssl rand -base64 32  — REQUIRED for edge cookie verification
ROOT_DOMAIN=lvh.me                    # dev base domain
NEXT_PUBLIC_BETTER_AUTH_URL=http://lvh.me:3000
```

> `BETTER_AUTH_SECRET` is non-negotiable: `getCookieCache` verifies the cookie's HMAC with it. Without it, edge verification can't succeed.

## 2. Local DNS for subdomains

`lvh.me` and `*.lvh.me` publicly resolve to `127.0.0.1` — **no `/etc/hosts` edits needed**. Chosen over `*.app.local` (macOS mDNS hijacks `.local`) and `*.localhost` (browsers often refuse the parent-domain cookie needed for cross-subdomain sessions). See research D2.

- Apex: `http://lvh.me:3000`
- Tenant: `http://user1.lvh.me:3000`

**Fallback** if your DNS blocks rebinding (Pi-hole / NextDNS / some corporate DNS strip public-name→loopback answers): add hosts entries and set `ROOT_DOMAIN` to a `.test` domain, or use `dnsmasq` wildcard → `127.0.0.1`.

## 3. Run

```bash
npm run dev
# visit http://lvh.me:3000  → sign up (creates user + subdomain slug + default board)
# you're redirected to http://<yourslug>.lvh.me:3000/dashboard
```

## 4. Verify the contract (maps to C2 rows)

| Check | Steps | Expect |
|---|---|---|
| **Row 4 — happy path** | Sign in, open `http://user1.lvh.me:3000/dashboard` | Your board loads; `x-tenant-id` present downstream |
| **Row 3 — no session** | Sign out, open `http://user1.lvh.me:3000/dashboard` | Redirect to sign-in on apex |
| **Row 5 — cross-tenant** | As `user1`, open `http://user2.lvh.me:3000/dashboard` | Redirect to `user1.lvh.me`; **no** user2 data |
| **Row 6 — unknown sub** | Signed out, open `http://ghost.lvh.me:3000` | Safe redirect to apex / 404; no data |
| **Row 1 — apex** | Open `http://lvh.me:3000` | Marketing/sign-in unchanged |
| **Isolation (SC-001)** | Seed data for two users; view each dashboard | Each sees only their own applications |

## 5. Verify edge purity (G1 / C3) — the assessment's core check

```bash
npm run build
```

- **Must succeed.** If `proxy.ts` (or anything under `lib/tenant/`) imports `mongoose`/`bcrypt`/`node:*`/the auth adapter, the Edge Runtime compile **fails** — that failure is the signal you regressed edge purity.
- Sanity grep: the import graph of `proxy.ts` should reach only `next/server` and `better-auth/cookies`.

## 6. Verify no per-request DB in routing (SC-002)

- With DB query logging on, navigate between tenant pages: middleware should issue **zero** DB queries (session comes from the signed cookie). Contrast with the old `proxy.ts`, which called `getSession()` (a DB hit) every navigation.

---

## What "done" looks like

All C2 rows behave as specified, `npm run build` passes (edge-pure), tenant data isolation holds across two accounts, and the routing layer makes no DB calls. Broader perf leaks (`bulkWrite` reorder, top-level-await) are tracked separately in `002-perf-leaks`.
