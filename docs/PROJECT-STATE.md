# Project State

Snapshot of where Beyond Borders **actually is** right now.
Refreshed at the end of every behaviour-changing slice — see the working
rule in `CLAUDE.md` §11.

- **Last updated:** 2026-05-10 (ADR-029 admin app foundation accepted;
  ADR-027 V1.0 e2e flow verification + TTL/tenant hardening)
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
(ADR-028 V1.0 infra — pending commit)
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

**Accepted 2026-05-10. No code yet.** `apps/admin` today is a
Next.js 15 App Router scaffold (one-line `layout.tsx`, placeholder
home page, no auth, no API client, no design system; `packages/ui`
is a placeholder).

ADR-029 locks the foundation slice that must ship before any
operator UI feature: Auth0 Universal Login via `@auth0/nextjs-auth0`
v4 (App Router); single `lib/session.ts` with `requireOperatorSession()`
as the only allowed reader of session state; single `lib/api-client.ts`
(server-side only, `cache: 'no-store'`, bearer auto-attached, typed
error classes, no retry inside the helper); operator-only layout gate
that 403s AGENCY users to a static page; layout v0 (Header,
SystemBanner slot, Sidebar, main); design system v0 with five
components in `apps/admin/components/` (`Button`, `Input`, `Textarea`,
`Card`, `Banner`) using Tailwind + shadcn-copy approach; single-tenant
per deployment via `BB_TENANT_ID`; no `offline_access` scope; no
dev-token bypass; vitest+jsdom for V0.1 smoke tests (Playwright
deferred to second admin UI slice).

**This is the next frontend prerequisite before the ADR-027
impersonation UI.** D11's persistent banner is architectural and
mounts in the `<SystemBanner />` slot ADR-029 puts in place. The
ADR-027 backend is fully shipped (V1.0 + hardening + e2e flow
verification), so the UI slice is unblocked at the API layer; only
the foundation needs to land first.

Implementation order (per ADR-029): env scaffolding → Auth0 SDK +
session helper → API client → operator-class layout gate → 5 design-
system components → layout v0 → README + continuity-doc updates.
No operator feature ships in `apps/admin` until all seven steps merge.

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

- **ADR-029 admin app foundation** — frontend track. Unblocks the
  ADR-027 D11 impersonation banner and every future operator UI
  (audit views, role grants, provisioning). No operator feature
  ships in `apps/admin` until this lands.
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
