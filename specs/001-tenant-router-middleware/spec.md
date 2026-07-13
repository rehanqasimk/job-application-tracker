# Feature Specification: Tenant Router Middleware

**Feature Branch**: `001-tenant-router-middleware`  
**Created**: 2026-07-13  
**Status**: Draft  
**Input**: User description: "Implement a Middleware-level Tenant Router. The app should handle subdomains (e.g., user1.app.local) to filter job applications. The user's session must be validated at the request-routing layer, and the tenant identity injected into the request without relying on components that cannot run in that layer."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tenant-isolated access via subdomain (Priority: P1)

A signed-in user opens the application through their own tenant subdomain (for example, `user1.app.local`). From that moment, every page and every list of job applications they see contains only their own tenant's data. Another tenant's applications are never visible, even if the user manually changes the address to a different subdomain.

**Why this priority**: This is the core promise of a multi-tenant system. Without guaranteed data isolation per tenant, the feature has no value and would represent a serious privacy failure. A working slice of this story alone (one tenant, correctly isolated) is a viable MVP.

**Independent Test**: Sign in as Tenant A, visit `tenantA.app.local`, and confirm only Tenant A's job applications appear. Create data for Tenant B, then confirm Tenant A can never see it from any subdomain.

**Acceptance Scenarios**:

1. **Given** a signed-in user for Tenant A, **When** they visit `tenantA.app.local/dashboard`, **Then** they see only Tenant A's job applications.
2. **Given** a signed-in user for Tenant A, **When** the system loads any tenant-scoped view, **Then** the tenant identity is determined from the subdomain and used to filter data.
3. **Given** two tenants with separate data, **When** each views their dashboard, **Then** neither can see the other's applications, boards, or columns.

---

### User Story 2 - Reliable session validation at the entry point (Priority: P2)

Before any tenant page is served, the application confirms the visitor has a valid, active session. Visitors without a valid session are sent to sign in, and this check runs consistently on every request regardless of which region serves it.

**Why this priority**: Isolation (P1) is only trustworthy if identity is verified before content is served. Performing this check at the single entry point avoids repeating it in every page and prevents unauthenticated access to tenant data.

**Independent Test**: Without signing in, request a protected tenant URL and confirm redirection to sign-in. Then sign in and confirm the same URL loads. Repeat across regions/deployments and confirm consistent behavior with no failures.

**Acceptance Scenarios**:

1. **Given** a visitor with no valid session, **When** they request a protected tenant page, **Then** they are redirected to the sign-in page.
2. **Given** a visitor with a valid session, **When** they request a protected tenant page, **Then** the page is served and the tenant identity is passed through to the page.
3. **Given** any request in any deployment region, **When** the entry-point validation runs, **Then** it completes successfully without runtime errors.

---

### User Story 3 - Safe handling of unknown and mismatched subdomains (Priority: P3)

When a visitor requests a subdomain that does not correspond to any tenant, or a subdomain that does not match the tenant their session belongs to, the system responds safely — without ever exposing another tenant's data.

**Why this priority**: Real traffic includes typos, stale links, reserved names, and deliberate probing. Handling these gracefully hardens the isolation guarantee and improves trust, but the primary flows (P1/P2) deliver value first.

**Independent Test**: Visit a non-existent subdomain and confirm a safe response with no data. While signed in as Tenant A, visit Tenant B's subdomain and confirm access is denied or redirected, with no Tenant B data shown.

**Acceptance Scenarios**:

1. **Given** a request to a subdomain with no matching tenant, **When** the page is requested, **Then** the visitor receives a safe response (not found or redirect to the root) with no tenant data.
2. **Given** a user signed in for Tenant A, **When** they request Tenant B's subdomain, **Then** access is denied or they are redirected, and no Tenant B data is revealed.
3. **Given** a request to the root domain (no subdomain or `www`), **When** the page is requested, **Then** the public/marketing and sign-in flows are served unchanged.

---

### Edge Cases

- A request arrives at the apex domain (no subdomain) or a reserved name such as `www`, `api`, or `admin`.
- A subdomain is well-formed but corresponds to no existing tenant.
- A visitor holds a valid session but requests a subdomain belonging to a different tenant.
- A session cookie is present but expired, tampered with, or otherwise invalid.
- Requests target static assets or internal API paths that should not be forced through tenant redirection.
- A tenant is deactivated or deleted while a user still holds an active session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST determine the tenant identity from the request's subdomain on every incoming request to a tenant-scoped area.
- **FR-002**: System MUST make the resolved tenant identity available to downstream request handling so that all tenant data (job applications, boards, columns) can be filtered to that tenant.
- **FR-003**: System MUST validate the visitor's session at the request-routing entry point before serving any tenant-scoped content.
- **FR-004**: System MUST ensure a user can only see job applications, boards, and columns belonging to their own tenant.
- **FR-005**: Unauthenticated requests to protected tenant pages MUST be redirected to the sign-in flow.
- **FR-006**: System MUST prevent cross-tenant access — when the session's tenant does not match the requested subdomain, the request MUST be denied or redirected with no other tenant's data exposed.
- **FR-007**: System MUST handle requests to unknown or non-existent subdomains gracefully (safe not-found or redirect to root) without exposing any tenant data.
- **FR-008**: System MUST continue to serve the root domain (no subdomain / `www`) public and sign-in experiences unchanged.
- **FR-009**: System MUST perform tenant identification and session validation at the request-routing layer without requiring a full application or database runtime at that layer, so the check runs reliably in every deployment region.
- **FR-010**: The routing-layer validation MUST add no perceptible latency to requests.
- **FR-011**: System MUST exclude static assets and internal API/framework paths from tenant redirection so they continue to load normally.

### Key Entities *(include if feature involves data)*

- **Tenant**: An isolated account space addressed by a unique subdomain. All job-tracking data belongs to exactly one tenant. Identified by a subdomain slug that maps to an owning account.
- **Session**: Proof that a visitor is authenticated. Carries enough information to establish the visitor's identity and their owning tenant at the request-routing layer.
- **Job Application**: A tracked job, always owned by a single tenant; only ever shown within that tenant's subdomain.
- **Board / Column**: The organizing structures for a tenant's job applications; scoped to the same tenant as the applications they contain.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user viewing their subdomain sees 100% of their own job applications and 0% of any other tenant's data, verified across at least two concurrently active tenants.
- **SC-002**: Tenant identification plus session validation at the entry point adds no more than 50 ms of overhead per request at the 95th percentile.
- **SC-003**: 100% of unauthenticated requests to protected tenant pages are redirected to sign-in.
- **SC-004**: 100% of cross-tenant access attempts (session tenant differs from requested subdomain) are blocked with no data leakage.
- **SC-005**: 100% of requests to unknown subdomains return a safe response with no tenant data disclosed.
- **SC-006**: The entry-point validation runs with zero runtime crashes attributable to unsupported components across all deployment regions during a representative load test.

## Assumptions

- A tenant corresponds to an individual account. Each account is addressed by a unique subdomain slug derived from its identity (informed by the `user1.app.local` example and the current per-account data scoping). Introducing multi-user organizations is out of scope for this feature.
- The existing session-based authentication is reused; no new sign-in method is introduced. Session validation at the routing layer relies only on information carried in the request (such as the session credential) that can be verified without a full database connection.
- The subdomain scheme is `<tenant>.app.local` in local development and `<tenant>.<domain>` in production; the apex domain and `www` remain the public entry point.
- This specification covers Task 1 only — the middleware-level tenant router with entry-point session validation and tenant-identity propagation. The broader "globally distributed, multi-tenant architecture" migration and the separate performance-leak fixes are tracked as future work and are out of scope here.
- Tenant-scoped data continues to live in the existing data store; this feature governs how requests are routed, validated, and filtered, not how data is stored.
