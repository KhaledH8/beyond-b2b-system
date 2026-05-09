# ADR-029: Admin app foundation — auth, session, API client, layout, and design system v0

- **Status:** Accepted
- **Date:** 2026-05-10
- **Supersedes:** nothing
- **Amends:** nothing (additive — fills the operator-UI hole the
  earlier ADRs assumed would exist when their UI requirements were
  written)
- **Depends on:**
  - ADR-007 (tech stack — Next.js 15, React 19, App Router)
  - ADR-011 (monorepo structure — `apps/admin`, `packages/ui`)
  - ADR-026 (identity / role model — `JwtAuthGuard`, `RolesGuard`,
    `AuthContext`, OPERATOR class, `/me` shape)
  - ADR-027 (operator impersonation — D11 mandates a persistent banner
    on every operator-facing UI page; that requirement is unmet today)

## Context

`apps/admin` exists as a Next.js 15 App Router scaffold and nothing
more: a one-line root layout (`<html><body>{children}</body></html>`),
a placeholder home page, no routes, no auth client, no API client, no
layout, no header, no sidebar, no design system. `packages/ui` is the
matching placeholder with `export {};` and a comment promising "Tailwind
+ shadcn/ui in Phase 1". `apps/b2b-portal` and `apps/b2c-web` are in
the same state; this ADR concerns only `apps/admin` because operator-
only surfaces (impersonation, audit views, role grants) cannot live
anywhere else.

The backend has reached a state where operator-facing UI is the
gating dependency for several locked-but-unshipped capabilities:

- **ADR-027 D11 — persistent impersonation banner.** Architectural
  requirement, not a UI nice-to-have. Without an admin app it cannot
  be implemented.
- **ADR-027 D10 — start / stop / active endpoints.** Reachable via
  `curl` only; no operator workflow exists in V1.0 that does not
  involve a developer terminal.
- **Future ADR-027 V1.1** — admin oversight views (`GET
  /admin/impersonation/grants`, `POST .../revoke`) need a host.
- **Future ADR-028 V1.x** — audit read API (`GET /audit-events`)
  needs a host.
- **Future ADR-026 admin surfaces** — role grants, user provisioning,
  webhook event triage — all need a host.

Building the impersonation UI in isolation, on top of the current
scaffold, would force one of three bad outcomes:

1. **Ship the banner with no auth client.** The banner has to call
   `/me` to know whether it's needed; with no token-acquisition
   flow it can't.
2. **Ship a dev-token-paste field.** Embeds a debug back-door that's
   hard to retract once the codebase grows around it.
3. **Build the auth client inline with the impersonation slice.**
   Conflates two unrelated concerns (foundation vs. feature) and locks
   in the auth/styling/layout choices through the impersonation
   feature's pull request review, not through a deliberate architecture
   review.

This ADR records the foundation slice that closes the gap. It is
deliberately **operator-only**, deliberately **minimal in surface
area**, deliberately **a real auth flow** rather than a dev shortcut,
and deliberately **scoped narrower than the existing `@bb/ui`
placeholder commitment**. It does not attempt to define the design
system for the b2b-portal or b2c-web apps; those have different
audiences, different visual languages, and will get their own ADRs.

## Decision

### D1. The foundation must exist before any operator UI feature ships

No operator-facing UI feature — impersonation, audit, role grants,
provisioning, anything — is built in `apps/admin` until every
component of this ADR is implemented and merged. A feature slice that
"just adds a tiny page" is forbidden if it would require touching
auth, session, API-client, layout, or design-system code outside its
own surface.

This rule is the entire reason for sequencing the foundation as one
ADR. Foundation choices ripple into every subsequent slice; doing them
once, deliberately, costs less than doing them incrementally under the
pressure of feature reviews.

### D2. Auth model — Auth0 Universal Login via `@auth0/nextjs-auth0`

The admin app authenticates operators against the same Auth0 tenant
the API uses (ADR-026 E1). The Next.js integration is
**`@auth0/nextjs-auth0`**, App Router edition.

**Why Auth0, and why not an alternative identity edge.** ADR-026 has
already standardised backend identity on Auth0 (JWT issuer, JWKS,
webhook ingestion). Using a different identity edge for the admin app
would split auth semantics — two issuers, two session models, two
revocation paths, two failure modes — for no operational gain in V1.
The cost of consistency is one extra Auth0 application; the cost of
divergence is every future audit, incident response, and SSO change
having to reason about two systems. Alternatives considered and
**rejected for V1**:

- **Cloudflare Access** — strong for internal-staff perimeter auth,
  but its identity assertions don't carry our `userClass` or DB-
  resolved roles, so we'd still need a second auth layer behind it.
  Net result: more moving parts, not fewer.
- **AWS IAM Identity Center (formerly SSO)** — same shape: a separate
  identity edge that doesn't speak our role model. Also locks the
  admin console to AWS-hosted infra, which is a deployment-time
  constraint we don't want to forward-load.
- **Manual OIDC via `openid-client`** — kept as an escape hatch if
  `@auth0/nextjs-auth0` v4 turns out to be blocked at implementation
  time (known bug, missing feature, hard incompatibility). It is
  strictly an escape hatch, not a default; using it requires a
  documented blocker recorded in the implementation slice's PR.

A future ADR may revisit the identity edge if the admin app's
audience expands beyond BB internal staff (e.g., shared with reseller
support staff under contract). That reopening is explicitly a future
ADR's job, not an exit-hatch in this one.

Locked rules:

- **Auth flow is server-side Universal Login.** The browser is
  redirected to Auth0; Auth0 redirects back with an authorization
  code; the SDK exchanges the code for tokens server-side. No
  PKCE-in-browser flow. No SPA-only token in localStorage.
- **Session storage is a stateless, encrypted, signed, httpOnly
  cookie** with `SameSite=Lax`, `Secure` in non-local environments,
  rolled by `AUTH0_SECRET`. Access tokens never leave the server-
  side rendering boundary.
- **Access tokens are obtained via the SDK's session API.** Server
  components and server actions read the session and pull the
  `accessToken` for backend calls. Client components never receive
  the access token; they receive only the rendered output of
  authenticated server fetches.
- **Required SDK version must be re-verified at implementation time.**
  At ADR-acceptance time the SDK is at v3.x for Pages Router and v4.x
  for App Router; the implementation slice MUST run
  `npm view @auth0/nextjs-auth0 versions` and pick the latest stable
  v4.x release that supports App Router server actions and the
  `getAccessToken()` helper. The slice MUST also re-verify the SDK's
  current route conventions (`/api/auth/login`, `/api/auth/logout`,
  `/api/auth/callback`, etc.) against the installed version's docs
  rather than assuming the names this ADR cites — v4 has moved
  several conventions between minor releases, and the ADR's URLs are
  illustrative, not normative. Pinning a wrong major and assuming
  stale URL conventions are the two highest-risk implementation
  mistakes.
- **Logout** clears the session cookie and redirects to Auth0's
  `/v2/logout` with `returnTo` set to the admin app's `/` route.
  The `returnTo` URL is added to Auth0's "Allowed Logout URLs".

### D3. The session helper is the only way to read identity

A single module — `apps/admin/lib/session.ts` — exports:

- `getSession()` — server-only; returns the typed session or `null`.
- `getAccessToken()` — server-only; returns the bearer string or
  throws if no session.
- `requireOperatorSession()` — server-only; calls `getSession()`,
  fetches `/me`, asserts `userClass === 'OPERATOR'` and that the
  catalogue includes at least one valid operator role; throws
  `UnauthorizedError` or `NotOperatorError` otherwise.

Every server component, server action, and route handler in
`apps/admin` MUST go through one of these three. Direct calls to
the SDK's `auth0.getSession()` are forbidden outside `session.ts` —
the abstraction owns the operator-class check, the cache-busting
behaviour, and the error mapping. A single module is reviewable;
sprawl across 30 components is not.

**Latency tradeoff, accepted explicitly.** `requireOperatorSession()`
makes one `/me` call per authenticated server-component render. The
admin app's latency floor is therefore Auth0 cookie verification +
`/me` round-trip + the backend's own DB role read. We accept this
cost. The alternative — a short-TTL signed cookie payload mirroring
`AuthContext` — would shave one round-trip off but introduces a
token-bound trust path that contradicts ADR-026 D1 ("roles are
DB-resolved, not token-resolved") and would silently desynchronise
the banner state from the live grant whenever the cookie is fresher
than the DB. Operator-grade traffic is small (tens of staff, not
millions of users); the round-trip is the right cost to pay. If
median page latency exceeds ~500ms in production, revisit via a new
slice — not by introducing a token-bound shortcut.

### D4. Operator-only access is enforced once, at the layout

`apps/admin/app/layout.tsx` (or a route-group layout if a public
`/login` route is needed) calls `requireOperatorSession()` at the
top of its server function. Failure outcomes:

- **Unauthenticated** → redirect to `/api/auth/login` (the SDK's
  built-in login route).
- **Authenticated but `userClass !== 'OPERATOR'`** → render a static
  403 page: "This console is for Beyond Borders staff only. If
  you are an agency user, sign in to the partner portal."
  Link to `/api/auth/logout`. The `/me` audit log will already
  carry the rejected access for forensics.
- **Authenticated but no active operator role** → same 403 page.
  Distinguishes "your account exists but is unprovisioned" from
  "you are not an operator at all", but the user-facing copy stays
  the same; the difference is recorded in the access-denied audit
  trail (future ADR-028 V1.x slice).

There is no "log in as an agency user from the admin app" path. There
is no "switch tenant" path. The admin app is single-tenant per
deployment for the foreseeable future; the BB-tenant ID is hardcoded
in environment configuration (D8).

### D5. API client pattern

A single helper — `apps/admin/lib/api-client.ts` — exports server-side
fetch functions parameterised by endpoint and body. It is **not** a
Swagger/OpenAPI-generated client; the API surface is small enough
that hand-rolled, typed wrappers are cheaper to read than generated
code.

Locked rules:

- **Server-side only.** The helper is never imported from a client
  component. Mutations from a client component go through a Next.js
  **server action**, which calls the helper. Reads from a server
  component call the helper directly.
- **Bearer token attached automatically.** The helper calls
  `getAccessToken()` and adds `Authorization: Bearer <token>`. A
  caller never passes the token in.
- **`X-Request-Id` propagated** when present in the inbound request
  context (server components have access via `headers()`); fresh
  ULID generated otherwise. The backend's `RequestIdMiddleware`
  (ADR-028) accepts the inbound value when it is a valid 26-char
  Crockford base32 ULID.
- **Error envelope.** The helper throws a typed error class hierarchy:
  `ApiUnauthorizedError` (401), `ApiForbiddenError` (403),
  `ApiNotFoundError` (404), `ApiConflictError` (409),
  `ApiValidationError` (400 with body), `ApiServerError` (5xx),
  `ApiNetworkError` (no response). Each carries the request id so
  audit-trail correlation works in support cases.
- **No retry / backoff inside the helper. Ever.** Retry policy is
  the *caller's* concern, not the helper's. The helper makes one
  attempt and surfaces the typed error. A future caller (e.g., a
  background-job dashboard, an optimistic-UI form) may implement
  retry-on-network-failure at its own layer; the helper does not
  silently introduce retries because that hides idempotency bugs.
  V0.1 callers do not retry.
- **No request/response body logging.** Even at debug level. The
  helper logs only method + path + status + request-id + duration.
  Request bodies frequently carry account names, ticket refs, and
  reasons that may eventually carry PII; the audit-log surface
  (ADR-028) is the place to record these, not the application log.

### D6. Caching and dynamic rendering

Next 15's App Router caches server-component fetches by default. For
the admin app this default is **wrong** for every authenticated read
and silently hides bugs. Locked rules:

- **All `lib/api-client.ts` fetches use `cache: 'no-store'`.** The
  default is unconditionally overridden inside the helper. Callers
  cannot opt into caching; it is not a parameter.
- **Pages that depend on session state set `export const dynamic =
  'force-dynamic'`** and `export const revalidate = 0`. This is a
  layout-level convention, applied once at
  `apps/admin/app/layout.tsx`; nested route segments inherit it.
- **The `/me` call inside `requireOperatorSession()` is uncached.**
  Same `cache: 'no-store'`. A stale `/me` response would
  catastrophically mis-render the impersonation banner.
- **Future static admin pages (e.g. error pages, /not-operator) opt
  out of dynamic rendering explicitly** with their own
  `dynamic = 'force-static'`, never silently.

This rule prevents a class of bug where the impersonation banner —
or any future authenticated UI element — renders the previous
request's state on the next request because Next happily served a
cached HTML fragment.

### D7. Layout v0

`apps/admin/app/layout.tsx` is replaced with a real shell:

- **`<Header />`** — top bar. Beyond Borders wordmark on the left;
  signed-in operator's email + role(s) on the right; a "Sign out"
  button. No tenant switcher (single-tenant V0.1).
- **`<SystemBanner />`** — slot mounted directly under the header
  but above content. V0.1 renders nothing; V1.0 (the ADR-027
  impersonation UI slice) mounts the impersonation banner here. A
  future ADR may mount maintenance / read-only-mode / region-
  outage banners in the same slot.
- **`<Sidebar />`** — left nav. V0.1 contains a single link: "Home"
  pointing at `/`. Subsequent feature slices add their own entries.
- **`<main>`** — content area. Renders `{children}`.
- **No footer.** Operator console; nothing belongs there.

The layout is a server component. The header's "Sign out" button is
an `<a href="/api/auth/logout">`; the SDK handles the rest. No
client-side state lives in the layout.

### D8. Environment variables

The admin app's environment is locked to the following names. Misnamed
or missing variables fail the app at startup with a clear error; no
fall-back values, no silent defaults.

| Name | Purpose | Required | Example shape |
|---|---|---|---|
| `AUTH0_SECRET` | Cookie encryption + signing key | yes | 32+ random bytes, hex/base64 |
| `APP_BASE_URL` | This admin app's public URL | yes | `https://admin.beyondborders.tld` |
| `AUTH0_DOMAIN` | Auth0 tenant hostname (no scheme, no path) | yes | `beyondborders.eu.auth0.com` |
| `AUTH0_CLIENT_ID` | Auth0 application client id | yes | `abc123...` |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret | yes | redacted |
| `AUTH0_AUDIENCE` | API audience | yes | `https://api.beyondborders.tld` |
| `AUTH0_SCOPE` | OIDC scope string | yes | `openid profile email` |
| `BB_API_BASE_URL` | Backend API root | yes | `https://api.beyondborders.tld` |
| `BB_TENANT_ID` | The single tenant this deployment serves | yes | 26-char ULID |

> **2026-05-10 — verified against `@auth0/nextjs-auth0` v4.** Earlier
> drafts of this table listed `AUTH0_BASE_URL` and
> `AUTH0_ISSUER_BASE_URL` (the v3 names). The SDK v4 migration guide
> renames these to `APP_BASE_URL` and `AUTH0_DOMAIN` (hostname only,
> no scheme). The names above are what `apps/admin/.env.example` and
> `apps/admin/lib/env.ts` actually use as of step 1 of the
> implementation order. D2 already required this verification; this
> annotation records the result so future readers don't have to
> re-derive it. The mounted route paths follow the same v4
> migration: `/auth/login`, `/auth/logout`, `/auth/callback` (no
> `/api` prefix); see `apps/admin/README.md` § "Auth0 SDK route +
> env-name verification".

**Refresh-token policy (V0.1).** `AUTH0_SCOPE` deliberately omits
`offline_access`. V0.1 does not request refresh tokens and does not
make any refresh-token storage decision. When the access token or
session cookie expires, the operator re-authenticates through Auth0
Universal Login — one extra round-trip is acceptable for operator-
grade traffic. If a future slice proves refresh tokens are required
(e.g., for long-running operator workflows or background polling
that must survive cookie expiry), that slice MUST add a separate
section to this ADR — or supersede it — covering refresh-token
acquisition, encrypted storage, rotation, and revocation. We do not
add `offline_access` "just in case"; it changes the threat model.

**Tenant model (V0.1).** `BB_TENANT_ID` makes the admin app
**single-tenant per deployment**. Each tenant gets its own admin
instance, with its own env file, its own Auth0 application (or
connection), and its own `BB_TENANT_ID`. There is no runtime tenant
switcher, no per-session tenant resolution, and no shared admin
console serving multiple tenants. A global multi-tenant admin
console (one deployment, runtime tenant selection, cross-tenant
operator visibility) is **out of scope** and would require a new
ADR — it is a materially different system, not an extension of
this one. This sequencing keeps the multi-tenant ambition of
CLAUDE.md §10 alive at the platform level (the codebase deploys
N times for N tenants) without forward-loading runtime multi-
tenancy into V0.1, where it would conflict with both the
operator-class gate (D4) and the single-Auth0-application
assumption.

Auth0 application configuration (managed in the Auth0 console, not
in code):

- **Allowed Callback URLs:** `${AUTH0_BASE_URL}/api/auth/callback`
- **Allowed Logout URLs:** `${AUTH0_BASE_URL}`
- **Allowed Web Origins:** `${AUTH0_BASE_URL}`
- **Application type:** Regular Web Application (not SPA)
- **Token Endpoint Authentication Method:** `client_secret_post`
  (matches v4 SDK default)

A `.env.example` file in `apps/admin/` enumerates every required
variable with placeholder values and a one-line comment. This is
the only documentation surface for env vars; the README references
it.

**Local development uses a real Auth0 dev tenant.** No dev-token
bypass, no environment-flagged "skip auth" mode, no test-only login
shortcut. The first developer onboarding to the admin app obtains
dev-tenant credentials per the ops runbook (out-of-band; secrets
shared via the team password manager, never committed). The
`.env.example` file is the only authoritative list of required
variable names; `apps/admin/README.md` repeats the list with
local-development-specific guidance (dev tenant URL, how to obtain
credentials, how to verify a successful login). Real secrets never
land in the repo. A pre-commit hook check (or an existing
`.gitignore` rule) for `.env*` files except `.env.example` is part
of the implementation slice's hygiene.

### D9. Design system v0

The minimum component set for V0.1, owned by `apps/admin/components/`
in this ADR — **not** by `packages/ui`. v0 ships only what the
foundation needs to look like a real console; additional components
are added by feature slices that actually require them, not
speculatively.

**Required v0 components (this slice ships all five):**

- `Button` — primary, secondary, danger, ghost variants; sizes sm/md.
- `Input` — text input with label + helper text + error state.
- `Textarea` — same shape as Input.
- `Card` — content container with optional header.
- `Banner` — non-dismissable, full-width, severity-coloured (info,
  warning, danger). The future impersonation banner is a
  `<Banner severity="danger">` instance.

**Deferred until a feature slice needs them:**

- `Alert` — added when the first slice needs an inline non-banner
  notice. Likely the impersonation UI's "you are not impersonating"
  empty state, or a 403/409 inline error.
- `Toast` — added when the first slice needs transient feedback
  (a successful "started impersonation" confirmation, for example).
  Until then, success state is conveyed by re-rendering the page in
  the new state — which is already the impersonation UI's design.
- `Spinner` — added when the first slice has a non-trivial async
  action that benefits from inline loading feedback. V0.1 has none.
- `Badge` — added when the first slice has a small typed label
  (status pill, monospace ID chip).

The "deferred" list is not a design rejection; these components will
exist eventually. Building them now risks shipping shapes we'll
re-shape once a real call site exists. The cost of deferring is
five small follow-up commits; the cost of pre-building is N
incompatible call-sites grown around speculative APIs.

Locked rules for V0.1:

- **Tailwind CSS** is the styling primitive. No CSS Modules, no
  styled-components, no emotion.
- **shadcn/ui** components are copied into `apps/admin/components/`
  via `npx shadcn` when their default markup matches what we
  need; otherwise we hand-write the component. We do not depend on
  shadcn-cli at runtime; copied components live in the repo and are
  reviewed line by line.
- **Components live in `apps/admin/components/` first.** They graduate
  to `packages/ui` only when a second app (b2b-portal, b2c-web) needs
  them, **and** the visual language has been confirmed shared. A
  premature graduation locks the b2b-portal into the operator visual
  language, which is wrong; the b2c-web visual language is wrong for
  both.
- **Operator-grade aesthetic.** Dense, high information-to-decoration
  ratio, monospace IDs, ample whitespace, neutral palette (slate /
  red-amber for danger / blue for primary). No marketing-style
  hero blocks. V0.1 ships zero animations (no Spinner, per D9).
  When motion is added by a future slice, it must respect
  `prefers-reduced-motion`. The console should look like a
  Stripe / Linear / Sentry internal admin, not a B2C site.
- **Accessibility floor:** keyboard navigability, visible focus
  rings, correct semantic HTML (`<button>`, `<label htmlFor>`,
  `<form>`). No WCAG-AA audit in V0.1; the floor must hold so the
  next slice can build to AA without a rewrite.

The placeholder comment in `packages/ui/src/index.ts` mentioning
shadcn/ui is updated to point at this ADR and to clarify that
`packages/ui` itself remains empty until cross-app reuse is
demonstrated.

### D10. Testing and CI expectations

This ADR's surface is small but security-critical. The minimum tests
for V0.1:

- **`session.ts`** — unit tests for `requireOperatorSession()` covering
  no session, session without `userClass`, session with
  `userClass = 'AGENCY'`, valid operator session, and `/me` call
  failure (network / 500).
- **`api-client.ts`** — unit tests for each error class boundary
  (401 → `ApiUnauthorizedError`, etc.), header construction (bearer
  + request id propagation + JSON content-type), and `cache:
  'no-store'` enforcement. Network call mocked.
- **Layout protection** — at least one smoke test verifying that an
  unauthenticated request to `/` redirects to `/api/auth/login` (or
  whatever the SDK's actual login route turns out to be — see D2).
  **Runner: vitest + jsdom for V0.1.** Playwright is deliberately
  deferred; it adds disproportionate setup cost (browser binaries,
  CI containers, parallelism config) for a single redirect check.
  Playwright lands when the second admin UI slice introduces a
  workflow that genuinely needs a real browser (form submission +
  navigation + cross-page state). At that point Playwright is
  added once and inherited by subsequent slices. The V0.1 smoke
  test is a non-negotiable assertion; the runner choice is locked.
- **Build, lint, typecheck:** `pnpm --filter @bb/admin build`
  (Next.js production build), `pnpm --filter @bb/admin lint`,
  `pnpm --filter @bb/admin typecheck` all clean before the slice
  merges. The existing root `pnpm test` continues to pass.

The first feature slice on top of this foundation (the ADR-027
impersonation UI) inherits the testing baseline. Subsequent slices
are not allowed to lower it.

### D11. Explicitly out of scope

The following are **not** delivered by this ADR and are not bolted
on by any V0.1 implementation slice:

- **Impersonation UI.** That is the next ADR-027 implementation
  slice. It depends on this ADR shipping first.
- **Role-management UI.** Future ADR-026 admin slice.
- **Audit-event read UI.** Future ADR-028 admin slice.
- **B2B partner portal.** Different audience, different visual
  language, different ADR.
- **B2C web.** Different audience, different visual language,
  different ADR.
- **Full design-system component library in `packages/ui`.**
  D9 explicitly defers `packages/ui` work until cross-app reuse
  is demonstrated.
- **Dev-token auth bypass.** No environment-flagged "skip auth"
  mode, no `NEXT_PUBLIC_DEV_TOKEN`, no test-only login shortcut
  in production code. The login flow is Universal Login, full
  stop. Local development against a real Auth0 dev tenant is the
  only supported path.
- **Multi-tenant admin.** Single tenant per deployment.
- **Tenant switcher UI.** Same.
- **Operator self-service password reset.** Auth0's universal flow
  handles this; we do not embed it.
- **Operator profile / preferences page.** No personalisation surface
  in V0.1.
- **Theming / dark mode.** Single light theme. Adding a dark theme
  later is allowed but is a separate slice.

### D12. Locked non-features (forbidden in V0.1)

These are stronger than D11; D11 is "deferred", D12 is "rejected
unless a future ADR explicitly amends this one":

- **Storing tokens in localStorage / sessionStorage / IndexedDB.**
  Cookie-only.
- **Exposing the access token to client components.** No
  `'use client'` file references the token directly.
- **Bypassing the API client helper.** No bare `fetch(...)` to
  `BB_API_BASE_URL` from anywhere except `lib/api-client.ts`.
- **Bypassing the session helper.** No bare `auth0.getSession()`
  outside `lib/session.ts`.
- **Per-route `cache: 'force-cache'` on authenticated reads.**
- **Per-component `useEffect`-based session checks.** All session
  checks are server-side; client components receive already-
  authenticated server-rendered output, not session state.
- **Marketing-style hero / animation / illustration components in
  the admin app.** This is a console.

## Open items

The following are explicitly deferred. Each is small enough that a
later slice can resolve it without amending this ADR.

- **Auth0 SDK version + route-convention pin.** Confirmed at
  implementation time per D2. If `@auth0/nextjs-auth0` v4 has shipped
  breaking changes (URL conventions, exported helper names, server-
  action surface) between ADR acceptance and slice start, a one-line
  update to D2's example URLs is enough; no full re-design needed.
  The implementation slice's PR description must explicitly record
  the SDK version and route paths it landed on.
- **`prefers-reduced-motion` test coverage.** Manually verified for
  V0.1 once `Spinner` is added (deferred per D9); automated test
  deferred until a second motion component exists.
- **Operator email allow-list.** Auth0 connection rules can already
  restrict which IdP-authenticated users obtain a token at all.
  The admin app does not duplicate this logic; if Auth0 is
  misconfigured, the `userClass` check in D4 is the second line of
  defence.
- **Server-action telemetry.** The API client helper logs
  method/path/status/duration; whether to ship those to a structured
  log sink (OTel, Logtail, etc.) is a Phase 1 ops concern, separate
  from this ADR.
- **CSP / security headers.** A production deployment will need
  Content-Security-Policy, Strict-Transport-Security, etc. Setting
  defaults in `next.config.ts` is a small slice that can land with
  the foundation OR immediately after; not load-bearing for
  the foundation's correctness.
- **Browser-level workflow tests (Playwright).** Deferred per D10
  until the second admin UI slice. Adds Playwright once, inherited
  thereafter.
- **Refresh tokens / `offline_access`.** Deferred per D8. Will
  reopen only if a future operator workflow proves it cannot
  tolerate cookie-expiry re-login.

## Implementation order

The following order is the smallest safe sequence to V0.1. Each
numbered step is its own commit; the slice is the whole sequence.

1. **Env scaffolding** — `apps/admin/.env.example`, `next.config.ts`
   updates, env-var validation at startup. No app behaviour change
   yet; just the loud-fail-on-missing-env wiring.
2. **Auth0 SDK install + session helper** — add
   `@auth0/nextjs-auth0` (latest stable v4), wire
   `app/api/auth/[...auth0]/route.ts`, write `lib/session.ts`. Tests
   for `requireOperatorSession()` against a mocked `/me`.
3. **API client helper** — `lib/api-client.ts` with the typed error
   classes, bearer attachment, request-id propagation, `cache:
   'no-store'`. Tests for header construction and error mapping.
4. **Operator-class layout gate** — `app/layout.tsx` calls
   `requireOperatorSession()`. Static `/not-operator` page rendered
   on `NotOperatorError`. Smoke test: unauthenticated GET / → 302
   to `/api/auth/login`.
5. **Design-system v0 components (five only)** — `Button`, `Input`,
   `Textarea`, `Card`, `Banner` in `apps/admin/components/`.
   Tailwind setup in `tailwind.config.ts`, `app/globals.css`. Visual
   smoke: a `/_dev/components` page listing every variant; gated to
   non-production builds. `Alert`, `Toast`, `Spinner`, `Badge` are
   deferred per D9 until a feature slice needs them.
6. **Layout v0** — `Header`, `SystemBanner` slot, `Sidebar`. Sign-out
   wired. The single sidebar entry for V0.1 is "Home" → `/`.
7. **README + ADR cross-link** — `apps/admin/README.md` describes
   how to run locally against a dev Auth0 tenant. `docs/PROJECT-
   STATE.md`, `docs/adrs/INDEX.md`, `docs/product/capability-
   catalog.md`, and `TASKS.md` are updated per the §11
   continuity-preservation rule.

After step 7 ships, the admin app is a usable, empty operator
console: an operator can log in, see a header with their email,
and see a sidebar with one link. That is the foundation; no
operator feature is delivered yet.

The ADR-027 impersonation UI slice — which is the immediate
motivation for this ADR — starts only after step 7 is merged.

## What must be proven before the impersonation UI starts

1. An operator can complete the Universal Login flow against a real
   Auth0 dev tenant and land on `/`.
2. The session cookie is set with `HttpOnly`, `Secure` (in
   non-local), `SameSite=Lax`, and a short rolling lifetime.
3. The layout-level `requireOperatorSession()` rejects an AGENCY
   token with the `/not-operator` page and a clean audit log
   (the `/me` access is recorded, the rejected page render is not
   re-attempted).
4. `lib/api-client.ts` successfully reaches a working `BB_API_BASE_URL`
   and surfaces a typed error on a forced 4xx and 5xx.
5. `cache: 'no-store'` is verified against a known-changing endpoint
   (e.g., `/me` between two consecutive requests where impersonation
   state changes server-side); the second request reflects the new
   state.
6. The empty `<SystemBanner />` slot is mounted in the layout and is
   a single component swap away from rendering the impersonation
   banner.
7. `Banner severity="danger"` exists and renders correctly across
   widths down to 1024px (the operator console minimum).
8. Lint, typecheck, build are clean. The new admin tests run in
   CI alongside the existing api/packages tests without disturbing
   them.

When all eight are demonstrated on a green CI build, the foundation
is approved and the next slice — ADR-027 impersonation UI — may
begin.
