# @bb/admin

Internal operations console for Beyond Borders staff (operators).
Next.js 15 + React 19 + App Router. Operator-only — no agency users.

> **Status:** ADR-029 complete (all 7 steps shipped 2026-05-10). The dev server boots, SDK
> middleware mounts at `/auth/login` / `/auth/logout` /
> `/auth/callback`, `/` is gated to OPERATOR users only, and the
> admin shell (Header / SystemBanner slot / Sidebar / main) is
> rendered on every authenticated page.

## Local development

### Prerequisites

- Node 24+ and pnpm 10+ (matches the repo root).
- A real Auth0 dev tenant. There is **no dev-token bypass** under any
  environment flag (ADR-029 D11/D12). Local development against a
  mocked auth flow is not supported — the auth pipeline is the
  surface this app most needs to validate against reality.

### Setup

1. **Copy the env template:**
   ```bash
   cp apps/admin/.env.example apps/admin/.env.local
   ```
   `.env.local` is in `.gitignore`. Real secrets never enter the repo.

2. **Obtain dev-tenant credentials.** Tenant URL, client id, and
   client secret come from the team password manager. If you do not
   have access, ask in `#bb-platform`. The dev tenant is shared
   across the team; each developer uses the same Auth0 application.

3. **Generate a session secret:**
   ```bash
   openssl rand -hex 32
   ```
   Paste into `AUTH0_SECRET`. Each developer should generate their
   own — do not share session secrets, even in dev.

4. **Configure Auth0 application URLs.** In the Auth0 dashboard
   (dev tenant → Applications → BB Admin → Settings):
   - **Application Type:** Regular Web Application
   - **Allowed Callback URLs:** `http://localhost:3012/auth/callback`
   - **Allowed Logout URLs:** `http://localhost:3012`
   - **Allowed Web Origins:** `http://localhost:3012`

5. **Run the dev server:**
   ```bash
   pnpm --filter @bb/admin dev
   ```
   Default port: 3012 (matches `APP_BASE_URL` in `.env.example`).

### Required environment variables

The full list lives in [`.env.example`](.env.example). Every variable
there is required; the env validator
([`lib/env.ts`](lib/env.ts)) throws `AdminEnvError` at startup on
missing or malformed values. There are no fallback defaults.

| Variable | Purpose |
|---|---|
| `AUTH0_SECRET` | Cookie encryption + signing key (32+ random bytes). |
| `APP_BASE_URL` | This admin app's public URL. |
| `AUTH0_DOMAIN` | Auth0 tenant hostname (no scheme, no path). |
| `AUTH0_CLIENT_ID` | Auth0 application client id. |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret. |
| `AUTH0_AUDIENCE` | Backend API audience (`aud` claim). |
| `AUTH0_SCOPE` | OIDC scopes. Must contain `openid`. Must NOT contain `offline_access` (ADR-029 D8). |
| `BB_API_BASE_URL` | URL of the `@bb/api` deployment this admin instance talks to. |
| `BB_TENANT_ID` | The single tenant this deployment serves (26-char ULID). |

## Auth0 SDK route + env-name verification

ADR-029 D2 obliges the implementation slice to verify the Auth0
Next.js SDK's current major version and route conventions instead
of trusting the names the ADR itself cites. Verified on 2026-05-10
against `@auth0/nextjs-auth0` v4 documentation:

### v4 environment variable names

The SDK v4 renamed several variables from the v3 conventions
ADR-029 D8 originally listed. The names actually used by the SDK
(and by [`.env.example`](.env.example)) are:

| ADR-029 D8 (original) | SDK v4 (verified) |
|---|---|
| `AUTH0_BASE_URL` | **`APP_BASE_URL`** |
| `AUTH0_ISSUER_BASE_URL` | **`AUTH0_DOMAIN`** (hostname only, no scheme) |
| `AUTH0_CLIENT_ID` | `AUTH0_CLIENT_ID` (unchanged) |
| `AUTH0_CLIENT_SECRET` | `AUTH0_CLIENT_SECRET` (unchanged) |
| `AUTH0_SECRET` | `AUTH0_SECRET` (unchanged) |
| `AUTH0_AUDIENCE` | `AUTH0_AUDIENCE` (unchanged) |
| `AUTH0_SCOPE` | `AUTH0_SCOPE` (unchanged) |

ADR-029 D2 explicitly anticipated this divergence: *"the SDK has
moved several conventions between minor releases, and the ADR's URLs
are illustrative, not normative."* The ADR's D8 env table has been
patched to match the verified v4 names.

### v4 mounted route names

The v4 SDK mounts auth routes via `auth0.middleware()` at:

- `/auth/login` (no `/api` prefix)
- `/auth/logout`
- `/auth/callback`

This is a v3 → v4 breaking change. The Allowed Callback URLs in the
Auth0 dashboard (above) reflect the v4 paths. **Do not configure
`/api/auth/callback`** — that is the v3 path.

### Verified at step 2 (SDK install) — 2026-05-10

- **Installed version:** `@auth0/nextjs-auth0@^4.20.0` (latest stable
  on `latest` dist-tag at install time).
- **Construction:** `new Auth0Client(opts)` from
  `@auth0/nextjs-auth0/server`. The admin app passes options
  explicitly from [`lib/env.ts`](lib/env.ts) (loud-fail validation
  before SDK construction); the SDK's own env fallbacks
  (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, etc.) are deliberately unused.
- **Mount:** [`middleware.ts`](middleware.ts) at the repo-package
  root calls `auth0.middleware(request)`. The matcher excludes
  `_next/static`, `_next/image`, and metadata files; everything
  else passes through so the SDK can roll session cookies.
- **Routes mounted by the SDK** (confirmed in installed
  `dist/server/client.d.ts`):
  - `POST /auth/login`
  - `GET  /auth/logout`
  - `GET  /auth/callback`
- **Env-name conventions match the v4 docs** — `APP_BASE_URL`,
  `AUTH0_DOMAIN`, `AUTH0_SECRET`, `AUTH0_CLIENT_ID`,
  `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE`, `AUTH0_SCOPE`. No further
  changes to [`.env.example`](.env.example) or [`lib/env.ts`](lib/env.ts).
- **Server-only fence:** [`lib/auth0.ts`](lib/auth0.ts) and
  [`lib/session.ts`](lib/session.ts) start with `import 'server-only';`.
  Vitest aliases the virtual module to a stub
  ([`test/stubs/server-only.ts`](test/stubs/server-only.ts)); under
  `next build` the real fence rejects any client-component import.

### API client (step 3)

[`lib/api-client.ts`](lib/api-client.ts) is the single entry point
for backend calls. Locked rules (ADR-029 D5):

- **Server-side only** (`import 'server-only'`).
- **Caller never passes a token.** `apiFetch` calls `getAccessToken()`
  from [`lib/session.ts`](lib/session.ts) on every request.
- **`cache: 'no-store'` is hard-coded.** Not a parameter; cannot be
  overridden by callers.
- **No retry inside the helper.** Retry policy is the caller's
  concern (V0.1 callers do not retry).
- **No request/response body logging.** Bodies live in audit logs
  (ADR-028), never in app logs.
- **`X-Request-Id`** propagated when the caller passes a valid ULID
  via `opts.requestId` (typically forwarded from
  `headers().get('x-request-id')` in a server component); fresh
  ULID generated otherwise. The id is attached to every thrown
  `ApiError` so support can correlate with backend logs.

Typed error hierarchy:

| Status | Error class |
|---|---|
| no token / 401 | `ApiUnauthorizedError` |
| 403 | `ApiForbiddenError` |
| 404 | `ApiNotFoundError` |
| 409 | `ApiConflictError` |
| 400 | `ApiValidationError` (carries parsed `bodyJson` when JSON) |
| 5xx / other non-2xx | `ApiServerError` (carries `status`) |
| network / fetch threw | `ApiNetworkError` (chains original via `Error.cause`) |

Example use from a server component:

```ts
import { headers } from 'next/headers';
import { apiFetch, ApiUnauthorizedError } from '@/lib/api-client';

const inbound = (await headers()).get('x-request-id') ?? undefined;
try {
  const me = await apiFetch<MeResponse>('GET', '/me', {
    requestId: inbound,
  });
  // ...
} catch (err) {
  if (err instanceof ApiUnauthorizedError) redirect('/auth/login');
  throw err;
}
```

### Layout gate (step 4)

The protected route-group layout is the single chokepoint for
operator-class enforcement (ADR-029 D4).

```
apps/admin/app/
  layout.tsx              ← root: html/body only, no gate
  not-operator/
    page.tsx              ← public 403 (outside the gate)
  (protected)/
    layout.tsx            ← requireOperatorSession() + redirects
    page.tsx              ← admin home (URL: /)
```

The `(protected)/` route group is invisible in URLs, so
`(protected)/page.tsx` still serves `/`. The home page and every
future authenticated page lives under `(protected)/` so it inherits
the gate without each page calling the session helper itself.

`(protected)/layout.tsx` exports `dynamic = 'force-dynamic'` and
`revalidate = 0`. ADR-029 D6: an operator-class check must never
be served from a stale render. The `next build` route table
confirms this — `/` shows as `ƒ (Dynamic)`, `/not-operator` and
`/_not-found` show as `○ (Static)`.

Error mapping inside the gate:

| Thrown by `requireOperatorSession()` | Outcome |
|---|---|
| `UnauthorizedError` | `redirect('/auth/login')` (SDK Universal Login) |
| `NotOperatorError` | `redirect('/not-operator')` (static 403) |
| `SessionApiError` (5xx / network) | rethrow — Next renders its default error UI; the requestId on the error correlates with backend logs |
| any other error | rethrow |

The `/not-operator` page lives outside the gate so an authenticated
AGENCY user can see why they were rejected without a redirect loop.
The user-facing copy does not distinguish "you're agency" from
"you're operator without a role" — the audit trail records the
difference.

### Note for Next.js 16

When this repo upgrades to Next.js 16, [`middleware.ts`](middleware.ts)
should be renamed to `proxy.ts` and the exported function renamed
from `middleware` to `proxy`. The SDK's middleware function is
unchanged — only the Next.js-side convention. Step 2 ships on
Next.js 15; the rename is owed at the upgrade slice.

### v4 documentation pointers

- SDK README: `node_modules/@auth0/nextjs-auth0/README.md` once
  installed; or the package's GitHub `README.md`.
- v3 → v4 migration: the SDK's `V4_MIGRATION_GUIDE.md`.
- DPoP / multiple-audience example: the SDK's `examples/with-dpop/`.

## Design-system v0 components (step 5)

Five primitive components live in [`components/`](components/):

| Component | Client | Variants / props |
|---|---|---|
| `Button` | ✓ | `primary \| secondary \| danger \| ghost`; `sm \| md`; `disabled` |
| `Input` | ✓ | `label` (required), `helperText`, `errorText`, `disabled` |
| `Textarea` | ✓ | same a11y pattern as `Input` |
| `Card` | — | optional `title` (renders `<h2>` header) |
| `Banner` | — | `info \| warning \| danger`; `role=status/alert`; non-dismissable |

All interactive components (`Button`, `Input`, `Textarea`) are marked
`'use client'`. `Card` and `Banner` are server-compatible.

A dev-only preview page lives at `/__preview` — it calls `notFound()`
in production and is never linked from the operator navigation.

## Layout v0 (step 6)

Four server-compatible layout components in [`components/`](components/):

| Component | Purpose |
|---|---|
| `AdminShell` | Top-level wrapper — SystemBanner → Header → (Sidebar + main) |
| `Header` | App name, operator `displayName`, sign-out link (`/auth/logout`) |
| `Sidebar` | `<nav aria-label="Main navigation">` — Home link only for now |
| `SystemBanner` | Empty slot; ADR-027 impersonation alert will mount here |

`AdminShell` accepts `displayName: string` (resolved from `name ?? email ?? auth0Sub` in the protected layout — never a token). The `(protected)/layout.tsx` calls `requireOperatorSession()`, extracts the safe display string, and passes it down. No tokens reach the shell or any child component.

## Testing

Vitest covers three test directories:

| Pattern | What is tested |
|---|---|
| `lib/**/*.test.ts` | `env.ts`, `session.ts`, `api-client.ts` helpers |
| `app/**/*.test.{ts,tsx}` | Protected layout gate, server-only boundary scan |
| `components/**/*.test.{ts,tsx}` | DOM render tests (RTL + happy-dom), boundary scans |

The admin app has its own [`vitest.config.ts`](vitest.config.ts).
Component tests use `@testing-library/react` + `happy-dom` +
`@testing-library/jest-dom`; the setup file is
[`test/stubs/vitest-setup.ts`](test/stubs/vitest-setup.ts).

```bash
pnpm --filter @bb/admin test       # run admin tests
pnpm --filter @bb/admin lint       # ESLint
pnpm --filter @bb/admin typecheck  # tsc --noEmit
pnpm --filter @bb/admin build      # next build (production smoke)
```

Playwright is deliberately deferred to the second admin UI slice.

## What this app does NOT do (yet)

ADR-029 §D11 / D12. None of these ship in V0.1:

- No impersonation UI (next slice after the foundation).
- No role-management UI.
- No audit-event read UI.
- No agency portal (that lives in `apps/b2b-portal`).
- No B2C web (that lives in `apps/b2c-web`).
- No dev-token auth bypass — ever.
- No multi-tenant runtime tenant switcher — single-tenant per
  deployment via `BB_TENANT_ID`.
- No theming / dark mode.

Adding any of the above without a corresponding ADR amendment is
out of scope.

## Pointers

- ADR-029 — admin app foundation (this file's source of truth):
  [`docs/adrs/ADR-029-admin-app-foundation.md`](../../docs/adrs/ADR-029-admin-app-foundation.md)
- ADR-026 — identity, role, and permission model (the `AuthContext`
  this app consumes):
  [`docs/adrs/ADR-026-identity-role-model.md`](../../docs/adrs/ADR-026-identity-role-model.md)
- ADR-027 — operator impersonation (the next operator-UI slice
  after the foundation lands):
  [`docs/adrs/ADR-027-operator-impersonation.md`](../../docs/adrs/ADR-027-operator-impersonation.md)
