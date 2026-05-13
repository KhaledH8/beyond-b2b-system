# Project State

Snapshot of where Beyond Borders **actually is** right now.
Refreshed at the end of every behaviour-changing slice — see the working
rule in `CLAUDE.md` §11.

- **Last updated:** 2026-05-10 (ADR-029 step 6 — layout v0; step 5
  design-system v0; step 4 operator-class layout gate; steps 1–3
  env/Auth0/API-client; ADR-029 accepted; ADR-027 V1.0 e2e flow
  verification + TTL/tenant hardening)
- **Active phase (per `docs/roadmap.md`):** Phase 1 (first implementation
  tasks), with Phase 2 sequencing already locked in ADRs.
- **Current branch:** `main` — all work shipped to `origin/main`.

---

## What is implemented and pushed right now

### Foundation
- Monorepo (pnpm + Turbo), package boundary lints, NestJS API + Worker
  shells, Next.js 15 frontends scaffolded.
- `packages/domain`, `packages/supplier-contract`, `packages/ledger`,
  `packages/payments`, `packages/rewards`, `packages/documents`,
  `packages/reseller`, `packages/rate-intelligence`, `packages/pricing`,
  `packages/db`, `packages/fx`, `packages/config`, `packages/testing` —
  types and contracts only where indicated by the ADRs.
- Local docker stack (Postgres+PostGIS, Redis, MinIO).
- CI baseline running install → build → typecheck → lint → test, with
  Postgres + MinIO services for integration tests.

### Hotels & supply
- Canonical hotel + supplier hotel + mapping baseline migrations.
- ADR-021 canonical product dimensions and four mapping tables.
- ADR-021 sourced offer snapshot tables (`offer_sourced_*`).
- Hotelbeds adapter:
  - Phase 1 scaffold landed.
  - Phase 2 live HTTP client (signing, retry, capture).
  - `stub | fixture | live` runtime switch at composition root.
  - Money-movement resolver (`PROVISIONAL` mode is the default;
    booking is refused until ops swaps in a payload-derived or
    config-resolved triple).
  - Fixture-replay conformance test against real Postgres + MinIO.
  - `book()` / `cancel()` still throw `HotelbedsNotImplementedError`
    (Phase 2 follow-up).

### Pricing & search
- `PERCENT_MARKUP` rule kind in `packages/pricing` with ACCOUNT > HOTEL >
  CHANNEL precedence.
- `pricing_markup_rule` and `merchandising_promotion` migrations.
- `POST /search` (channel-aware, fixture-driven) returning grouped,
  price-ascending results with promotion tags that never reorder past
  cheapest-first.
- `/internal/admin/pricing/markup-rules` and
  `/internal/admin/merchandising/promotions` full CRUD with soft-delete.

### Authored direct pricing
- ADR-022 Phase A authored primitives (contracts, seasons, child age
  bands, base rates, occupancy + meal supplements).
- DirectContracts admin CRUD at
  `/internal/admin/direct-contracts/...` with serializable
  season-overlap check, FK-guarded delete, audit-log emission.
- ADR-023 Phase B authored restrictions and cancellation: schema, admin
  CRUD, and search-time gating + cancellation attachment.
- Authored direct offers merged into the unified search response.

### Identity & auth
- Auth0 JWT validation with JWKS cache.
- Core user JIT sync on first authenticated call.
- `PERMISSIONS` catalogue + role-permission map.
- `user_role`, `user_account_membership` data model with class
  coherence enforced.
- `RolesGuard` + `@RequirePermission` decorator pattern.
- Admin user provisioning service (Auth0-first → DB transaction;
  compensating Auth0 delete on DB failure).
- Auth0 webhook ingestion with HMAC-SHA256 signature verification over
  raw body (sce/scu/scn/sd/sapi events handled).
- Bootstrap-platform-admin CLI (idempotent first-admin provisioning).
- `GET /me` identity probe (intentionally not gated by `RolesGuard`).
- **`POST /search` is the first endpoint retrofitted with the full
  pattern** (Layer A metadata pin + Layer B HTTP exercise + Layer C
  reconciliation unit tests). AGENCY users with body-vs-AuthContext
  mismatch get 403; OPERATOR users get 403 with the impersonation
  policy message.
- Endpoint retrofit pattern documented in
  `docs/architecture/auth-endpoint-retrofit-pattern.md`.
- **ADR-027 V1.0 operator impersonation** — `impersonation_grant`
  migration; `ImpersonationGrantRepository`; `ImpersonationService`
  (start/stop/getActive + all subject enforcement + audit);
  `ImpersonationController` (`POST /impersonation/start`,
  `POST /impersonation/stop`, `GET /impersonation/active`);
  `AuthContext.impersonation` block; `JwtAuthGuard` flips
  `userClass → 'AGENCY'` + sets `accountId` for active OPERATOR
  grants; `PermissionResolverService` impersonation branch
  (`(agency/account_admin) ∩ READ ∖ IMPERSONATION_DENY_INITIAL +
  IMPERSONATE_AGENCY_ACCOUNT`); `PERMISSION_KIND` map; audit events
  `IMPERSONATION_STARTED / ENDED / START_REJECTED` via
  `emitInTransaction`. 24 new tests across 4 test files. Typecheck
  clean.
- **ADR-027 V1.0 hardening (2026-05-10)** — TTL bounds enforced
  (default 30 min, min 5 min, max 240 min; invalid env values throw
  at startup); `JwtAuthGuard` rejects active grants whose
  `tenantId` does not match the operator's `tenantId` (defense in
  depth, falls through to OPERATOR-self context).
- **ADR-027 V1.0 end-to-end backend verification (2026-05-10)** —
  `impersonation-flow.test.ts` boots a real Nest app and drives the
  full lifecycle through HTTP: ticketRef validation, start success,
  active read, AGENCY-shaped `/search`, body-vs-AuthContext
  reconciliation under impersonation, IMPERSONATION_STARTED /
  ENDED audit emission, stop, and operator-as-self search blocked
  after stop. 8 new tests. `SearchController` operator-block
  message updated from "impersonation not yet supported" to
  "active impersonation required" / "Operator search requires an
  active impersonation grant (ADR-027)".
- **ADR-027 active-grant UI prep (2026-05-10)** — `GET
  /impersonation/active` response shape changed from
  `ImpersonationGrantRecord | null` to `{ grant, target: { accountId,
  accountName } } | null` so the future operator UI banner (ADR-027
  D11) can render account name + ticket ref from a single call after
  refresh. Implementation: new
  `ImpersonationGrantRepository.findActiveWithTargetByActor` does an
  INNER JOIN to `core_account` with `(target_account_id = a.id AND
  tenant_id = a.tenant_id)` for defense-in-depth. The hot-path
  `findActiveByActor` used by `JwtAuthGuard` is unchanged — no JOIN
  added to per-request operator traffic. 36/36 impersonation tests
  pass; 23/23 hot-path JwtAuthGuard + search-guards tests pass.
- **ADR-029 D4 amendment — impersonation carve-out (2026-05-10).**
  `apps/admin/lib/session.ts` admits an actively-impersonating
  operator: `userClass === 'AGENCY'` is accepted only when
  `/me.impersonation` is a valid block whose
  `actorUserClass === 'OPERATOR'` (and `scope === 'READ_ONLY'`,
  non-empty `grantId` / `actorUserId` / `actorAuth0Sub` / `expiresAt`).
  `MeResponse.impersonation` typed against new `MeImpersonationBlock`
  (mirrors ADR-027 D6 AuthContext shape). `OperatorIdentity` carries
  optional `impersonation: { grantId, expiresAt, scope }` for downstream
  banner rendering. Pure AGENCY users still 403 → `/not-operator`.
  Layout, AdminShell, and all server-only boundaries unchanged. No
  banner rendering yet. 145/145 admin tests (was 135, +10); 736 root
  passes (was 726, +10) with the same 4 MinIO baseline failures.
- **ADR-027 impersonation UI v1 (2026-05-10).** First operator UI
  slice on top of the ADR-029 foundation. New server-only
  `lib/impersonation-client.ts` wraps `apiFetch` for typed
  `getActiveImpersonation` / `startImpersonation` / `stopImpersonation`.
  Server actions in `app/(protected)/impersonation/actions.ts`
  (`'use server'`) own start (ULID + non-empty validation + typed
  API-error mapping) and stop (idempotent, swallows errors,
  revalidates). New `/impersonation` page renders either the active
  card (target / ticket / reason / scope / startedAt / expiresAt +
  Stop) or the start form (targetAccountId ULID input + ticketRef
  + reasonText with helper text explicitly noting no agency selector
  yet). Persistent `<Banner variant="danger">` mounts in the
  `<SystemBanner />` slot via the layout (which now calls
  `getActiveImpersonation` when `identity.impersonation` is set;
  degrades gracefully on null/5xx). Sidebar gains an Impersonation
  link. Boundary scan extended to include `lib/impersonation-client`.
  173/173 admin tests (was 145, +28); admin typecheck + lint + build
  clean (new route `/impersonation` is ƒ Dynamic). **No agency
  selector / typeahead** — deliberate V1 scope; operator pastes
  ULID from support ticket. **No role-management UI. No audit UI.
  No backend changes.**

### FX
- ADR-024 implemented through C5d.2:
  - FX schema (`fx_rate_snapshot`, `fx_application`).
  - OXR client + sync service.
  - ECB FX snapshot sync.
  - Server-side FX display conversion in `/search`.
  - Booking FX lock schema, resolver (Stripe FX Quote), repository,
    and applier wiring into the booking confirmation transaction.
  - Refund FX lock derivation and applier.
  - Booking FX confirmation lookup and observability on the
    confirmation path.
- C5d.3 / C5d.4 / C6 / C7 still pending.

### Booking
- `booking_booking` shell migration.
- Internal booking-confirm endpoint as the first saga step; FX lock
  applied inside the confirmation transaction.

### Admin & internal
- `InternalAuthGuard` + `@Actor()` on every `/internal/...` endpoint
  (`X-Internal-Api-Key` header).
- `admin_audit_log` interim append-only log with `CREATE | PATCH |
  SOFT_DELETE | DELETE` on every mutating admin operation.
  (Will consolidate into ADR-028's canonical `audit_event` substrate
  when that ships.)
- Internal Hotelbeds seam (`/internal/suppliers/hotelbeds/content-sync`,
  `/internal/suppliers/hotelbeds/search`) for adapter end-to-end
  triggering.

### Audit infrastructure (ADR-028 V1.0 steps 1–5)

- DB roles (`bb_app`, `bb_audit_retention`, `bb_admin`) — idempotent migration.
- `audit_event` — composite-partitioned parent (LIST by category → RANGE by `occurred_at`);
  5 category intermediate partitions; current+next month leaf partitions; append-only
  triggers on parent; 5 indexes; conditional role grants.
- `audit_pruning_log` — standalone never-pruned table; `bb_audit_retention` INSERT-only.
- `AuditService` — compile-time + runtime category enforcement; `emit()` (APP/SECURITY,
  best-effort, swallows errors); `emitInTransaction()` (all categories, propagates errors);
  `emitMany()`; AsyncLocalStorage `RequestAuditContext` stamped on every INSERT.
- `RequestIdMiddleware` — ULID per request, X-Request-Id validation, IP/UA extraction,
  `requestContextStore.run()` wraps the entire request pipeline.
- `AuditModule` — `@Global()`, imports `DatabaseModule`, exports `AuditService`.
- `AppModule` — wired `AuditModule` + `RequestIdMiddleware` applied to `'*'`.
- Tests: 11 AuditService unit tests, 11 RequestIdMiddleware unit tests, 4 trigger
  integration tests (run after `pnpm db:migrate`; skipped when `DATABASE_URL` absent).

### Recent meaningful commits
```
2f74d06 feat(admin): add ADR-029 layout v0                                            (ADR-029 step 6)
b589d19 feat(admin): add ADR-029 design system v0                                     (ADR-029 step 5)
3942aa2 feat(admin): add ADR-029 operator layout gate                                 (ADR-029 step 4)
d3f0e8e feat(admin): add ADR-029 API client helper                                    (ADR-029 step 3)
f4e00d1 feat(admin): add ADR-029 Auth0 session helper                                 (ADR-029 step 2)
bfc0068 feat(admin): add ADR-029 env scaffolding                                      (ADR-029 step 1)
64467a4 docs: accept ADR-029 admin app foundation
4221b73 fix(auth): wire AuditModule into AuthModule                                   (ADR-028 V1.0)
488b8fd test(auth): add ADR-027 impersonation HTTP end-to-end flow test               (ADR-027 V1.0)
a6d911c fix(auth): harden impersonation TTL and tenant checks                         (ADR-027 V1.0)
bd0ff80 feat(auth): add operator impersonation V1.0                                   (ADR-027 V1.0)
6cb791c feat(auth): gate /search and reconcile body identifiers against AuthContext   (ADR-026 E4-A + E4-B)
0ffd997 feat(auth): add admin provisioning, webhook ingestion, and bootstrap CLI       (ADR-026 E2-B)
e1ff071 feat(auth): add role and membership permission infrastructure                 (ADR-026 E3-A)
74c8104 feat(auth): add Auth0 JWT validation and core user sync foundation             (ADR-026 E1 + E2-A)
77f2d0e feat: add refund FX lock derivation and applier                                 (ADR-024 C5d.2)
492d5fe feat: add booking FX confirmation lookup
26f3a52 feat: add booking confirmation observability
4378b1d feat: add internal booking confirm endpoint
9be6b43 feat: wire booking FX lock into confirmation transaction
c8013e6 feat: add booking FX lock resolver and Stripe quote client
ff8aa35 feat: add booking FX lock schema
ce5ab6b feat: add server-side FX display conversion in search
b5bd7b8 feat: attach authored cancellation policies in search                          (ADR-023)
67438c0 feat: gate authored offers with restrictions in search                         (ADR-023)
3c228eb feat: add authored cancellation policy admin CRUD
87caa4b feat: add authored restriction admin CRUD
1668bad feat: add authored phase-b restrictions and cancellation schema                (ADR-023)
a1fd63d feat: merge authored direct offers into unified search
3e2e0d9 feat: add authored offer composer
8c5c007 feat: add direct-contract base rates and supplements                           (ADR-022 phase A)
f15af99 docs: add authored pricing ADRs and update task tracker                        (ADR-022 + ADR-023)
17e5c52 feat: add channel-aware search and pricing layer                               (ADR-004 + ADR-009)
a8dafa4 feat: add internal hotelbeds content-sync and search endpoints
4d79588 feat: add live hotelbeds client with fixture/live switch and capture support
914c4fd test: add hotelbeds fixture replay and conformance suite
4c23684 feat: wire hotelbeds adapter into api composition root with db and minio ports
0a72509 feat: add phase-1 rate-model migrations for product dimensions mappings and sourced offers
```

---

## What is design-locked but not yet implemented

These are decisions that have an accepted ADR but no production code.
Sequencing notes follow each cluster.

### Operator impersonation (ADR-027)

**V1.0 implemented 2026-05-09.** See the "Identity & auth" section above.

### Audit log infrastructure (ADR-028)

**Steps 1–5 implemented (2026-05-09).** DB roles, `audit_event` table
(composite partitioned, append-only triggers, indexes, grants),
`audit_pruning_log`, `AuditService` (emit/emitInTransaction split,
compile-time + runtime enforcement), `RequestIdMiddleware`
(AsyncLocalStorage, ULID, X-Request-Id), `AuditModule` + `AppModule`
wiring. ADR-027 V1.0 is now unblocked.

Still pending (steps 6–11): ADR-027 impersonation as first emitter;
read API; CLI; retention cron; SENSITIVE_ACCESS table; backfill.

### Admin app foundation (ADR-029)

**Accepted 2026-05-10. All 7 steps implemented 2026-05-10. Foundation
complete. ADR-027 impersonation UI is now unblocked.**

Implemented so far:
- Step 1: env scaffolding (`lib/env.ts`, `.env.example`, 34 tests).
- Step 2: Auth0 SDK v4 install + session helper (`lib/auth0.ts`,
  `lib/session.ts`, `middleware.ts`, `requireOperatorSession()` with
  typed errors; 18 tests).
- Step 3: server-side API client (`lib/api-client.ts`, typed error
  hierarchy, `cache: 'no-store'` hard-coded, bearer auto-attached; 28
  tests).
- Step 4: operator-class layout gate — `(protected)/layout.tsx` maps
  `UnauthorizedError → /auth/login`, `NotOperatorError →
  /not-operator`; `dynamic = 'force-dynamic'`, `revalidate = 0`;
  static `/not-operator` 403 page outside the gate; 12 tests.
- Step 5: Tailwind CSS v4 + five v0 components in
  `apps/admin/components/`: `Button` (4 variants, 2 sizes, disabled),
  `Input` (label/helper/error, a11y wired), `Textarea` (same),
  `Card` (optional title/header), `Banner` (info/warning/danger,
  role=status/alert); dev-only preview at `/__preview`; 24 new tests
  (21 DOM + 3 boundary scans); admin tests 116/116, root 706/706.
- Step 6: layout v0 — four server-compatible layout components:
  `AdminShell` (top-level wrapper), `Header` (app name + displayName
  + sign-out link), `Sidebar` (nav landmark with Home link),
  `SystemBanner` (null slot for future ADR-027 impersonation alert).
  `(protected)/layout.tsx` resolves `displayName` from session and
  wraps children in `AdminShell`; no tokens reach child components.
  `(protected)/page.tsx` `<main>` wrapper removed (AdminShell owns
  the sole landmark). 19 new tests (18 DOM A–R + boundary test Y);
  admin tests 135/135, root 725/725. `next build`: `/` = ƒ Dynamic,
  `/not-operator` = ○ Static.
- Step 7: README + continuity-doc tidy — `apps/admin/README.md`
  verified accurate for all steps; ADR-029 status updated to
  `Accepted (implemented 2026-05-10)` in
  `docs/adrs/ADR-029-admin-app-foundation.md`,
  `docs/adrs/INDEX.md`, and `docs/product/capability-catalog.md`;
  D8 Auth0 config block corrected to v4 paths (`/auth/callback`,
  `APP_BASE_URL`). Foundation is complete; ADR-027 impersonation
  UI is now unblocked.

ADR-029 foundation goal: Auth0 Universal Login via
`@auth0/nextjs-auth0` v4; single `lib/session.ts` with
`requireOperatorSession()` as the only allowed reader of session
state; single `lib/api-client.ts` (server-side only, `cache:
'no-store'`, bearer auto-attached, typed error classes, no retry
inside the helper); operator-only layout gate that 403s AGENCY users
to a static page; layout v0 (Header, SystemBanner slot, Sidebar,
main); design system v0 with five components in
`apps/admin/components/`; single-tenant per deployment via
`BB_TENANT_ID`; no `offline_access` scope; no dev-token bypass.

**All 7 steps complete (2026-05-10). ADR-029 foundation is
implemented.** The ADR-027 impersonation UI is the immediate next
frontend slice and is now unblocked. D11's persistent banner mounts
in the `<SystemBanner />` slot that step 6 put in place; the ADR-027
backend (V1.0 + TTL hardening + e2e flow verification) is fully
shipped.

Implementation order (per ADR-029): env scaffolding → Auth0 SDK +
session helper → API client → operator-class layout gate → 5 design-
system components → layout v0 → README + continuity-doc updates.
No operator feature ships in `apps/admin` until all seven steps merge.

**Step 1 (env scaffolding) shipped 2026-05-10:** `apps/admin/.env.example`
+ `apps/admin/lib/env.ts` (`loadAdminEnv()` with loud-fail validation
on URLs, ULID, AUTH0_DOMAIN shape, scope rules) + 34 unit tests +
`apps/admin/README.md` (dev-tenant setup, SDK route-convention notes)
+ admin-local `vitest.config.ts`. Root `vitest.config.ts` extended
so CI runs the admin tests. **ADR-029 D8 patched 2026-05-10** to
use the verified `@auth0/nextjs-auth0` v4 env names
(`APP_BASE_URL` and `AUTH0_DOMAIN`).

**Step 2 (Auth0 SDK install + session helper) shipped 2026-05-10:**
`@auth0/nextjs-auth0@^4.20.0` installed in `apps/admin` only;
`apps/admin/middleware.ts` mounts the SDK at `/auth/login` /
`/auth/logout` / `/auth/callback`; `apps/admin/lib/auth0.ts`
exports a lazy `getAuth0Client()` singleton constructed from
`loadAdminEnv()` (no SDK env fall-back); `apps/admin/lib/session.ts`
exports `getSession()`, `getAccessToken()`,
`requireOperatorSession()` plus typed errors `UnauthorizedError`,
`NotOperatorError`, `SessionApiError`. `requireOperatorSession()`
calls backend `/me` with `cache: 'no-store'`, accepts only
`userClass === 'OPERATOR'`, and rejects empty `roles[]` if the
field is present (forward-compat). `import 'server-only'` fences
the auth + session modules from client-component import; vitest
aliases the virtual module to a stub
(`apps/admin/test/stubs/server-only.ts`). 18 new session tests
cover happy path, missing session, token failures, /me network /
401 / 403 / 5xx, AGENCY rejection, empty-roles rejection,
`cache: 'no-store'` enforcement, bearer attachment, base-URL
composition, and the server-only top-line guard on both modules.

**Step 3 (API client) shipped 2026-05-10:**
`apps/admin/lib/api-client.ts` exports `apiFetch<T>(method, path,
opts?)` plus a typed error hierarchy (`ApiError` base + seven
subclasses: `ApiUnauthorizedError`, `ApiForbiddenError`,
`ApiNotFoundError`, `ApiConflictError`, `ApiValidationError` with
parsed `bodyJson`, `ApiServerError`, `ApiNetworkError` with
`Error.cause`). Each error carries `requestId` for support
correlation. Hard-coded `cache: 'no-store'` (cannot be overridden
by callers — the option is not exposed). Bearer auto-attached via
`getAccessToken()`; caller never passes a token. `Content-Type:
application/json` only when a body is present. `X-Request-Id`
propagated when the caller passes a valid ULID, otherwise a fresh
ULID is minted; the same id rides on the outbound header and on
every thrown `ApiError`. Empty body / 204 / `content-length: 0` /
non-JSON 2xx all return `undefined` cleanly. No retry, no body
logging. `apps/admin/lib/ulid.ts` adds a portable
(Node + Edge runtime) ULID generator + `validUlid()` shared with
the api-client. 28 new tests cover bearer attachment, token-
retrieval failure, cache enforcement (including the "callers
cannot override" case via type-laundered options), body / no-body
content-type rules, every status-to-error mapping (400 / 401 /
403 / 404 / 409 / 500 / 503 / network), 204 + content-length-0 +
empty-body handling, request-id generate / propagate-valid /
regenerate-invalid / attach-on-error, URL composition, the
`server-only` top-line guard, and the no-body-logging sanity
check.

**Step 4 (operator-class layout gate) shipped 2026-05-10:** new
`apps/admin/app/(protected)/layout.tsx` calls
`requireOperatorSession()` and maps `UnauthorizedError` →
`redirect('/auth/login')`, `NotOperatorError` →
`redirect('/not-operator')`, anything else rethrows. Exports
`dynamic = 'force-dynamic'` and `revalidate = 0` so Next never
serves a stale operator-class check (ADR-029 D6). The home page
moved from `app/page.tsx` to `app/(protected)/page.tsx` so it
inherits the gate via the route group; the URL stays `/`. New
public-shape `app/not-operator/page.tsx` renders the static 403.
The root `app/layout.tsx` stays minimal (html/body only) so the
SDK-mounted `/auth/*` routes and `/not-operator` render without
the gate. `next build` route table confirms: `/` is `ƒ` Dynamic,
`/not-operator` + `/_not-found` are `○` Static. Static-source
boundary scan (`apps/admin/app/__tests__/server-only-boundary.test.ts`)
asserts no `'use client'` file in `app/` or `components/`
imports `lib/session` / `lib/auth0` / `lib/api-client`, and that
all three modules start with `import 'server-only';`. 12 new
tests (8 layout-gate + 4 boundary). Vitest configs (admin + root)
gained `esbuild.jsx = 'automatic'` so JSX in App-Router source
files transforms cleanly under tests; root vitest include
extended to `apps/*/app/**/*.{test,spec}.{ts,tsx}` so CI runs
the layout/boundary tests.

**All 7 steps merged as of 2026-05-10.** ADR-029 foundation is
complete. The ADR-027 impersonation UI slice may now begin.

### Rest of the design-locked surface

- **Booking-time snapshots (ADR-021)** — sourced + authored snapshot
  tables and the `CONFIRMED` write transaction land in Phase 2.
- **Document generation (ADR-016)** — types, gapless number sequences,
  object storage, document workers — Phase 2 (Beyond Borders direct tax
  invoice + BB voucher + confirmation), Phase 3 (reseller-branded guest
  docs + reseller-channel tax invoice).
- **Reseller capability + branded guest documents (ADR-017, ADR-018)**
  — Phase 3 onwards. `RESELLER_COLLECTS` first, then `CREDIT_ONLY`,
  then `PAYOUT_ELIGIBLE` per-jurisdiction (shares legal-clearance gate
  with `CASH_WALLET`).
- **Money-movement modes (ADR-020)** — Phase 1 ships the three enums
  declaratively with forbidden triples enforced; Phase 2 enables
  `BB_COLLECTS + (PREPAID_BALANCE | POSTPAID_INVOICE)` only; Phase 3
  enables `VCC_TO_PROPERTY`, `PROPERTY_COLLECT`, `COMMISSION_ONLY`;
  Phase 4 enables `UPSTREAM_PLATFORM_COLLECT`.
- **Wallet, ledger, rewards (ADR-012, ADR-014, ADR-014 amendment)** —
  Phase 2 ships internal double-entry ledger + Stripe rail + non-stored-
  value wallet books + reward maturation scaffolding with the default
  `PERCENT_OF_MARGIN` rule. Phase 3 adds hotel-funded campaigns,
  manual overrides, B2B kickback v1, and referral with anti-fraud.
  `CASH_WALLET` blocked on UAE legal review.
- **Direct CRS / channel-manager connectivity (ADR-013)** — Phase 3
  first adapter (likely SynXis), more in Phase 4. Each provider carries
  a multi-month certification tax.
- **Market-aware pricing with benchmark inputs (ADR-015)** — Phase 4.
  Provider not yet selected.
- **Seasonal-contract + promotion overlay (ADR-021 amendment
  2026-04-23)** — Phase 3, lands before the direct-paper adapter
  implementation.
- **Tax engine ADR** — must land before reseller onboarding opens in
  Phase 3. UAE VAT minimal inline is acceptable for Phase 2 BB-direct.

### Doc-debt

None outstanding. ADR-026 was back-written 2026-05-09. ADR-025 is
formally retired as an unused number in `docs/adrs/INDEX.md`.

---

## Immediate next slice

Three candidate slices, picked by priority call:

- **ADR-027 impersonation UI** — frontend track. First feature slice
  on top of the ADR-029 foundation (complete). Persistent
  `<Banner variant="danger">` in the `<SystemBanner />` slot on
  every operator page; start/stop/active page at
  `apps/admin/app/impersonation/`. ADR-027 backend is fully shipped
  (V1.0 + TTL hardening + e2e verification). This is now unblocked.
- **ADR-028 V1.0 steps 6–11** — backend track. Audit read API, CLI,
  retention cron, SENSITIVE_ACCESS table, backfill.
- **FX C5d.3 / C5d.4 / C6 / C7** — backend track. Remaining FX work
  per ADR-024.

ADR-027 V1.0 is shipped; impersonation is the first real emitter of
`IMPERSONATION` category events.

---

## Open external dependencies (not blockers for the next slice but
still tracked)

See `TASKS.md` "Open risks / uncertainties" for the full list. The
ones most likely to affect upcoming sequencing:

- UAE stored-value wallet legal review (`CASH_WALLET`).
- VCC provider selection (Stripe Issuing / Marqeta / Conferma / WEX).
- KYC/KYB provider selection for reseller onboarding.
- Tax engine ADR (must land before reseller onboarding opens).
- Rayna integration unconfirmed.
- Booking.com Demand API commercial eligibility unknown.
- `recognized_margin` exact inclusion list with finance.
- Card-fee estimation contract with finance (drives `BB_COLLECTS` vs
  `RESELLER_COLLECTS` margin gap and the default
  `PERCENT_OF_MARGIN` reward rule).
