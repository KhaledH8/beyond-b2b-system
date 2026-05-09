# @bb/admin

Internal operations console for Beyond Borders staff (operators).
Next.js 15 + React 19 + App Router. Operator-only — no agency users.

> **Status:** ADR-029 step 1 (env scaffolding + SDK verification notes).
> Auth, layout, design system, and operator features land in subsequent
> steps. The dev server boots today but has no real auth flow yet.

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

### What still needs to be verified at the SDK install slice

ADR-029 step 2 (Auth0 SDK install + session helper) MUST:

1. Run `npm view @auth0/nextjs-auth0 versions` and pick the latest
   stable v4.x release.
2. Re-confirm the route convention list above against the installed
   version's `README.md` and `V4_MIGRATION_GUIDE.md` — minor v4
   releases have moved conventions before.
3. Record the SDK version and verified route paths in the slice's
   PR description.
4. Update [`.env.example`](.env.example) and [`lib/env.ts`](lib/env.ts)
   if any further env-name changes have shipped between this slice
   (2026-05-10) and the SDK install slice.

### v4 documentation pointers

- SDK README: `node_modules/@auth0/nextjs-auth0/README.md` once
  installed; or the package's GitHub `README.md`.
- v3 → v4 migration: the SDK's `V4_MIGRATION_GUIDE.md`.
- DPoP / multiple-audience example: the SDK's `examples/with-dpop/`.

## Testing

Vitest runs against `apps/admin/lib/**/*.test.ts` (and `.tsx`). The
admin app has its own [`vitest.config.ts`](vitest.config.ts) that
widens the include pattern from the root config (which is `src/`-
oriented for the API).

```bash
pnpm --filter @bb/admin test       # run admin tests
pnpm --filter @bb/admin lint       # ESLint
pnpm --filter @bb/admin typecheck  # tsc --noEmit
pnpm --filter @bb/admin build      # next build (production smoke)
```

V0.1 uses **vitest + jsdom** for all tests, including the layout
smoke test that comes in step 4 (ADR-029 D10). Playwright is
deliberately deferred to the second admin UI slice.

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
