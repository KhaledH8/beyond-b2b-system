# Capability Catalog

Source of truth for **what the Beyond Borders platform does, will do, or
has explicitly chosen not to do**. This file is updated on every accepted
slice that adds, removes, or materially changes a capability — see the
working rule in `CLAUDE.md` §11.

Status legend:

- `implemented` — code exists and is pushed; covered by tests; reachable
  from a real entry point.
- `locked-by-ADR` — design decision recorded and accepted in an ADR; no
  code yet.
- `planned` — on the roadmap or in `TASKS.md`; design not fully locked.
- `blocked` — design or implementation halted on an external dependency
  (legal, commercial, partner certification, etc.).
- `deferred` — explicitly out of scope for current phase; will land later
  per roadmap.
- `superseded` — replaced by a newer capability; row kept for historical
  continuity.
- `rejected` — considered and explicitly declined; row kept so we don't
  re-litigate.

Every row carries an ADR reference where the decision is recorded; if
none exists, the row is grounded in `TASKS.md` or a design doc.

---

## 1. Foundation & Repo Infrastructure

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Monorepo with pnpm + Turbo | implemented | Workspaces under `apps/*`, `packages/*`; ESLint dependency-direction enforcement; per-package `tsconfig`. | repo root, `pnpm-workspace.yaml`, `eslint.config.mjs` | ADR-007, ADR-011 |
| NestJS API shell | implemented | `apps/api` boots with `GET /health`. | `apps/api` | ADR-007 |
| Worker shell | implemented | NestJS application-context shell; BullMQ processors register here in Phase 1. | `apps/worker` | ADR-007 |
| Next.js 15 frontends (B2C, B2B, admin) | implemented | App Router shells with placeholder pages. | `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` | ADR-007, ADR-011 |
| `packages/domain` zero-dep core types | implemented | `Money`, `TenantContext`, `CanonicalHotel`, `Account`, `Booking`, `PricingTrace`, ADR-020 enums. | `packages/domain` | ADR-011 |
| Database tooling baseline | implemented | `packages/db` pg.Pool factory + Knex migration runner with module subdir support. | `packages/db`, `infra/migrations`, `infra/knexfile.ts` | ADR-007, ADR-011 |
| Local docker stack | implemented | Postgres+PostGIS 16, Redis 7, MinIO. | `infra/docker/docker-compose.yml` | ADR-007 |
| CI baseline | implemented | GitHub Actions: install → build → typecheck → lint → test. Postgres + MinIO services for integration tests. | `.github/workflows/ci.yml` | — |
| OpenTelemetry wiring | planned | Pino logger + OTel trace/metric providers across api + worker. | (planned) | ADR-007 |

## 2. Tenancy & Account Model

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Tenant + Account entities | implemented | `core_tenant`, `core_account` baseline migration. Day-one multi-tenant data model. | `infra/migrations/core/`, `packages/domain` | ADR-006 |
| Account types (B2C, AGENCY, SUBSCRIBER, CORPORATE) | implemented | Account-type discriminator on `core_account`. | `infra/migrations/core/` | ADR-006 |
| Reseller capability profile | locked-by-ADR | `ResellerProfile` attached to AGENCY/SUBSCRIBER. Versioned `BillingProfile`, `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`, `GuestPriceDisplayPolicy`. | `packages/reseller` (types only) | ADR-017 |
| Reseller settlement modes | locked-by-ADR | `RESELLER_COLLECTS` / `CREDIT_ONLY` / `PAYOUT_ELIGIBLE`; KYC + payout-account gating. | `packages/reseller` | ADR-018 |
| LegalEntity (per-tenant tax-doc issuer) | locked-by-ADR | Carries jurisdiction, tax registrations, gapless number sequences. | `packages/documents` | ADR-016 |

## 3. Identity, Auth, and Permissions

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Auth0 JWT validation | implemented | JWKS cache + JWT validator service; `JwtAuthGuard` attaches `AuthContext` to every authenticated request. | `apps/api/src/auth/jwt/` | ADR-026 |
| Core user JIT sync | implemented | First-call sync from Auth0 token claims into `core_user`. | `apps/api/src/auth/user-sync/` | ADR-026 (E2-A) |
| Permission catalogue (`PERMISSIONS.*`) | implemented | Single source of truth for permission strings; role-permission map. | `apps/api/src/auth/permissions/permissions.ts` | ADR-026 |
| Role + membership data model | implemented | `user_role`, `user_account_membership` tables; AGENCY/OPERATOR class coherence enforced. | `infra/migrations/auth/`, `packages/domain` | ADR-026 (E3-A) |
| `RolesGuard` + `@RequirePermission` | implemented | Default-deny per-method permission gating. | `apps/api/src/auth/permissions/` | ADR-026 |
| Admin user provisioning | implemented | Auth0-first then DB transactional `core_user` + membership + roles; compensating Auth0 delete on DB failure. | `apps/api/src/auth/management/` | ADR-026 (E2-B) |
| Auth0 webhook ingestion | implemented | HMAC-SHA256 verification over `${ts}.${rawBody}`; handles sce/scu/scn/sd/sapi events; per-entry transactions. | `apps/api/src/auth/webhook/` | ADR-026 (E2-B) |
| Bootstrap platform_admin CLI | implemented | Idempotent first-admin provisioning. | `apps/api/src/auth/bootstrap/` | ADR-026 (E2-B) |
| `GET /me` identity probe | implemented | Identity-baseline route gated by `JwtAuthGuard` only (deliberately no `RolesGuard`). | `apps/api/src/auth/me.controller.ts` | ADR-026 (E4-A) |
| Endpoint retrofit pattern | implemented | Canonical `JwtAuthGuard + RolesGuard + @RequirePermission` + body reconciliation runbook. | `docs/architecture/auth-endpoint-retrofit-pattern.md` | ADR-026 (E4-A + E4-B) |
| `/search` auth + reconciliation | implemented | First retrofitted endpoint; AGENCY body must match `AuthContext` or 403; OPERATOR 403 with E8 policy message. | `apps/api/src/search/search.controller.ts` | ADR-026 (E4-B) |
| Operator impersonation | locked-by-ADR | DB-bound grants; AGENCY-target only in V1; ticket_ref required; read-only; `IMPERSONATION_DENY_INITIAL` deny-list overlay. | (planned: `apps/api/src/auth/impersonation/`) | ADR-027 |

## 4. Audit Infrastructure

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| `admin_audit_log` (interim) | implemented | Append-only-ish log for `/internal/admin/*` mutations; predates ADR-028 canonical table. | `apps/api/src/admin/`, `infra/migrations/core/` | — (pre-ADR; consolidates into ADR-028) |
| Canonical `audit_event` substrate | locked-by-ADR | DB-role-enforced append-only; composite-partitioned by category × month; five categories (APP/AUTH/IMPERSONATION/SENSITIVE_ACCESS/SECURITY). | (planned: `apps/api/src/audit/`) | ADR-028 |
| `audit_pruning_log` | locked-by-ADR | Standalone never-pruned table recording every partition drop; `bb_audit_retention` INSERT-only. | (planned) | ADR-028 D2.d |
| `AuditService` with category-aware emission | locked-by-ADR | Compile-time-enforced split: AUTH/IMPERSONATION must use `emitInTransaction`; APP/SECURITY may use background queue. | (planned: `apps/api/src/audit/`) | ADR-028 D7 |
| Self-audited audit reads | locked-by-ADR | `AUDIT_QUERY_EXECUTED` / `AUDIT_QUERY_EXECUTED_SENSITIVE` emitted on every read via API or CLI. | (planned) | ADR-028 D9 |
| Per-category retention windows | locked-by-ADR | 7y financial-relevant APP / AUTH / IMPERSONATION / SENSITIVE_ACCESS; 2y SECURITY + non-financial APP. Implemented via partition-drop. | (planned) | ADR-028 D8 |
| Cryptographic hash chaining | rejected (V1/V2) | Tamper-evident hashing explicitly out of scope until a future ADR. | — | ADR-028 D11 |
| External SIEM shipping | rejected (V1/V2) | Out of scope; would ship as logical-replication projection if needed. | — | ADR-028 D11 |

## 5. Hotels — Canonical Model & Mapping

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Canonical hotel + supplier hotel | implemented | `hotel_canonical`, `hotel_supplier`, `hotel_mapping` baseline; PostGIS GIST indexes. | `infra/migrations/hotel/` | ADR-002, ADR-008 |
| Canonical product dimensions | implemented | `hotel_room_type`, `hotel_rate_plan`, `hotel_meal_plan`, `hotel_occupancy_template`, `hotel_child_age_band` with platform-global + tenant scoping. | `infra/migrations/rates/` | ADR-021 |
| Product dimension mappings | implemented | Four `hotel_*_mapping` tables; `DETERMINISTIC | FUZZY | MANUAL`; `PENDING/CONFIRMED/REJECTED/SUPERSEDED`. | `infra/migrations/rates/` | ADR-008, ADR-021 |
| Deterministic mapping pipeline | planned | Phase 2 work; first-pass deterministic match phase. | `packages/mapping/` (planned) | ADR-008 |
| Fuzzy mapping + human review UI | deferred | Phase 2+; depends on commercial decision on Giata or equivalent. | — | ADR-008 |
| Static content merge | planned | Static pipeline into `CanonicalHotel`. | `packages/content/` (planned) | ADR-005 |

## 6. Supply — Adapter Contract & First Adapter

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Supplier adapter contract | implemented | `SupplierAdapter` interface; `IngestionMode`, `OfferShape`, `RateBreakdownGranularity`, ARI_PUSH capability, three-axis money-movement triple. | `packages/supplier-contract` | ADR-003, ADR-013, ADR-020, ADR-021 |
| Hotelbeds adapter (sourced) | implemented | Phase 1 scaffold + Phase 2 live HTTP client (signing, retry, capture). `SOURCED_COMPOSED` shape; `TOTAL_ONLY` granularity. | `packages/adapters/hotelbeds`, `apps/api/src/adapters/hotelbeds` | ADR-003, ADR-021 |
| Hotelbeds money-movement resolver | implemented | Per-rate triple resolution; `PROVISIONAL` mode prevents booking until ops confirms commercial. | `packages/adapters/hotelbeds/src/money-movement.ts` | ADR-020 |
| Hotelbeds fixture replay | implemented | Deterministic JSON fixtures + content-addressed MinIO writes; conformance test against real Postgres + MinIO. | `packages/testing/src/hotelbeds/fixtures/`, `packages/adapters/hotelbeds/src/fixture-client.ts` | ADR-003 |
| Hotelbeds booking confirmation | planned | Phase 2 adapter `book()` / `cancel()` paths still throw `HotelbedsNotImplementedError`. | (planned in Phase 2) | ADR-003 |
| WebBeds adapter | planned | Phase 2 second sourced adapter. | — | ADR-003 |
| TBO adapter | planned | Phase 2/3 sourced adapter. | — | ADR-003 |
| Rayna adapter | blocked | Technical availability and data shape unconfirmed. | — | ADR-003 |
| Expedia Rapid adapter | deferred | Later phase. | — | ADR-003 |
| Booking.com Demand API | blocked | Commercial / contractual eligibility unknown; do not pre-architect. | — | ADR-003 |
| Direct CRS connectivity (SynXis) | locked-by-ADR | First direct-connect adapter; certification tax acknowledged. | (planned in Phase 3) | ADR-013 |
| Direct channel managers (RateGain, SiteMinder, Mews, Cloudbeds, Channex) | locked-by-ADR | ARI push ingestion; per-provider commercial overhead. | (planned in Phase 3/4) | ADR-013 |
| Direct paper-contract adapter | locked-by-ADR | Authored primitives; same `SupplierAdapter` contract as aggregators. | (planned in Phase 3) | ADR-021, ADR-022, ADR-023 |
| Adapter conformance suite | planned | Formalized harness in `packages/testing/`; Hotelbeds fixture-replay is the first implementation. | `packages/testing/` | ADR-003 |
| Adapter registry + booking guard | implemented | `SupplierAdapterRegistry`; `assertRateBookable` rejects PROVISIONAL provenance. | `apps/api/src/adapters/`, `apps/api/src/booking/booking-guard.ts` | ADR-020 |

## 7. Rate / Offer Model

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Sourced offer snapshot tables | implemented | `offer_sourced_snapshot`, `offer_sourced_component`, `offer_sourced_restriction`, `offer_sourced_cancellation_policy`. | `infra/migrations/offers/` | ADR-021 |
| Authored Phase A primitives | implemented | `rate_auth_contract`, `rate_auth_season`, `rate_auth_child_age_band`, `rate_auth_base_rate`, `rate_auth_occupancy_supplement`, `rate_auth_meal_supplement` with composite FKs enforcing same-contract membership. | `infra/migrations/authored/` | ADR-022 |
| Direct contract admin CRUD | implemented | `/internal/admin/direct-contracts/...` for contracts, seasons, age bands; serializable season-overlap check; FK guards on delete. | `apps/api/src/direct-contracts/` | ADR-022 |
| Authored Phase B (restrictions + cancellation) | implemented | Authored phase-b restrictions and cancellation schema + admin CRUD; gates authored offers in search; cancellation policies attached at search time. | `apps/api/src/direct-contracts/`, `infra/migrations/authored/` | ADR-023 |
| Seasonal-contract layer + promotion overlay | locked-by-ADR | `rate_contract_*` and `rate_promotion_*` tables; `AuthoringMode ∈ {SEASONAL_CONTRACT, PER_DAY_STREAM}`; copy-season service. | (planned in Phase 3) | ADR-021 amendment 2026-04-23 |
| Booking-time snapshots | locked-by-ADR | `booking_sourced_offer_snapshot`, `booking_authored_rate_snapshot`, `booking_cancellation_policy_snapshot`, `booking_tax_fee_snapshot`. Immutable; written in `CONFIRMED` transaction. | (planned in Phase 2) | ADR-021 |

## 8. Pricing Engine

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| `PERCENT_MARKUP` rule kind | implemented | First markup rule; ACCOUNT > HOTEL > CHANNEL precedence; priority tie-break. | `packages/pricing/src/evaluator.ts` | ADR-004 |
| Markup rule storage + admin CRUD | implemented | `pricing_markup_rule` with three precedence scopes; `/internal/admin/pricing/markup-rules`. | `infra/migrations/pricing/`, `apps/api/src/admin/` | ADR-004 |
| Channel-aware search + first-slice pricing | implemented | `POST /search` runs sourced-offer fetch → markup evaluator → group + sort by selling price ascending. Promotions tag results without reordering. | `apps/api/src/search/` | ADR-004, ADR-009 |
| Merchandising promotion tags | implemented | `merchandising_promotion` (`PROMOTED | RECOMMENDED | FEATURED`); never mutates priced rate. | `infra/migrations/merchandising/`, `apps/api/src/admin/promotion.*.ts` | ADR-009 |
| Multi-supplier search | planned | Currently only Hotelbeds; expand once a second adapter is wired. | — | ADR-003 |
| Tax / fee composition | planned | ADR-004 step 3; not yet implemented. | — | ADR-004 |
| Promotion / discount kind in pricing | planned | `PROMOTION_APPLIED` post-markup trace step. | — | ADR-004 |
| `FIXED_MARKUP_ABSOLUTE` rule kind | planned | Additive rule kind. | — | ADR-004 |
| `MARKET_ADJUSTED_MARKUP` rule kind | locked-by-ADR | Market-aware adjustment using benchmark inputs; advisory only. | — | ADR-004, ADR-015 |
| Authored-primitive pricing path | locked-by-ADR | Pricing evaluator gains `AUTHORED_PRIMITIVES` path alongside `SOURCED_COMPOSED`. | — | ADR-021, ADR-022 |
| `recognized_margin` contract | locked-by-ADR | Pricing-owned; mode-aware (BB_COLLECTS / RESELLER_COLLECTS / COMMISSION_ONLY shapes). Default rewards earning is `PERCENT_OF_MARGIN` over this. | — | ADR-014 amendment, ADR-020 |

## 9. Booking Saga

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Booking shell table | implemented | `booking_booking` baseline; ADR-020 triple immutable at confirmation. | `infra/migrations/booking/` | ADR-010, ADR-020 |
| Internal booking-confirm endpoint | implemented | First step of the saga: confirms a held rate; emits FX lock derivation; attaches money-movement triple. | `apps/api/src/booking/` | ADR-010, ADR-020 |
| Booking confirmation observability | implemented | Trace + structured logging on confirm path. | `apps/api/src/booking/` | — |
| Booking confirmation FX lookup | implemented | Reads applied FX lock at confirmation time. | `apps/api/src/booking/`, `apps/api/src/fx/` | ADR-024 |
| Full booking saga (`SUPPLIER_BOOKED`, `PAYMENT_CAPTURED`, `DOCUMENT_ISSUED`) | planned | Phase 2 saga shape. `VCC_ISSUED` step locked for VCC_TO_PROPERTY mode. | — | ADR-010, ADR-020 |
| Document issue + delivery workers (outside saga) | locked-by-ADR | Run outside the booking saga; failed PDF render or email never fails a booking. | — | ADR-010 amendment, ADR-016 |
| Multi-hotel cart | rejected (MVP) | Out of scope; ADR-010 single-hotel cart only. Future work needs ADR amendment. | — | ADR-010 |

## 10. FX (Foreign Exchange)

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Three-tier FX strategy | locked-by-ADR | OXR live · ECB fallback/reference · Stripe FX Quotes for locked checkout. | `apps/api/src/fx/` | ADR-024 |
| FX schema (`fx_rate_snapshot`, `fx_application`) | implemented | Per-conversion application rows; provenance recorded. | `infra/migrations/fx/` | ADR-024 |
| OXR client + sync | implemented | Live rate fetch; cached snapshots. | `apps/api/src/fx/oxr-*` | ADR-024 |
| ECB FX snapshot sync | implemented | Daily ECB-published rates as fallback/reference. | `apps/api/src/fx/ecb-fetcher.service.ts` | ADR-024 |
| Server-side FX display conversion in search | implemented | Sell currency → display currency without mutating canonical price. | `apps/api/src/search/`, `apps/api/src/fx/` | ADR-024 |
| Booking FX lock (Stripe Quote) | implemented | Quote at checkout; resolver + repository; applier wires into confirmation transaction. | `apps/api/src/fx/booking-fx-lock.*` | ADR-024 |
| Refund FX lock derivation | implemented | Lock derivation for refund leg. | `apps/api/src/fx/booking-fx-lock.applier.ts` | ADR-024 |
| FX C5d.3 / C5d.4 / C6 / C7 | planned | Per memory note: ADR-024 implemented through C5d.2; remaining slices pending. | — | ADR-024 |

## 11. Payments, Wallet, and Ledger

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| `LedgerEntry` + `WalletAccount` types | implemented | Domain types only; ADR-012/018/020 ledger kinds. | `packages/ledger`, `packages/payments` | ADR-012, ADR-018, ADR-020 |
| Internal double-entry ledger | locked-by-ADR | Source of truth for money. Stripe is a rail, not the wallet. | (planned in Phase 2) | ADR-012 |
| Stripe rail integration | locked-by-ADR | Stripe Connect for collection. Customer Balance + Treasury rejected. | (planned in Phase 2) | ADR-012 |
| Wallet books (`PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD`) | locked-by-ADR | Non-stored-value books; lower legal risk to launch first. | (planned in Phase 2) | ADR-012 |
| `CASH_WALLET` (UAE stored-value) | blocked | Pending UAE jurisdictional legal clearance. | — | ADR-012 |
| Reseller wallet books | locked-by-ADR | `RESELLER_PLATFORM_CREDIT` (non-withdrawable), `RESELLER_CASH_EARNINGS` (withdrawable), `reseller_collections_suspense`. | — | ADR-018 |
| Supplier-side internal books | locked-by-ADR | `supplier_prepaid_balance_<id>`, `supplier_postpaid_payable_<id>`, `supplier_commission_receivable_<id>`, `vcc_issuance_suspense`. | — | ADR-020 |
| Reseller payouts (`PAYOUT_ELIGIBLE`) | blocked | Per-jurisdiction legal clearance required; KYC/KYB provider not selected. | — | ADR-018 |
| VCC issuance (`VCC_TO_PROPERTY`) | blocked | VCC provider selection (Stripe Issuing / Marqeta / Conferma / WEX) outstanding. | — | ADR-020 |

## 12. Rewards, Loyalty, Referral

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Rewards domain types | implemented | `EarnRule`, `RewardPosting`, `RewardCampaign`, `FundingSource`, `ReferralInvite`, `FraudDecision`. | `packages/rewards` | ADR-014, ADR-014 amendment 2026-04-22 |
| Margin-based earn (`PERCENT_OF_MARGIN` default) | locked-by-ADR | Earn on `recognized_margin`, never booking gross. Default rule. | (planned in Phase 2) | ADR-014 amendment |
| Funding source attribution | locked-by-ADR | Every posting carries `PLATFORM_FUNDED | HOTEL_FUNDED | SHARED_FUNDED`. Hotel-funded requires `RewardCampaign` + `funding_agreement_ref` + approver. | (planned in Phase 2) | ADR-014 amendment |
| Reward maturation (PENDING → POSTED) | locked-by-ADR | Clawback window + supplier stay confirmation before posting. | (planned in Phase 2) | ADR-014 |
| Referral anti-fraud | locked-by-ADR | Required clearance before referral posting. | (planned in Phase 3) | ADR-014 |
| B2B kickback | locked-by-ADR | Margin-based machinery, account-aware. | (planned in Phase 3) | ADR-014 amendment |
| Hotel-funded reconciliation | blocked | Receivable-from-hotel leg must clear at supplier invoicing; hand-off design Phase 3. | — | ADR-014 amendment |

## 13. Documents (Tax invoices, vouchers, confirmations)

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Document domain types | implemented | `BookingDocument`, `DocumentNumberSequence`, `LegalEntity`, `DeliveryAttempt`, `COMMISSION_INVOICE` type. | `packages/documents` | ADR-016, ADR-020 |
| Document types (TAX_INVOICE, CREDIT_NOTE, DEBIT_NOTE, BB_BOOKING_CONFIRMATION, BB_VOUCHER, RESELLER_GUEST_*) | locked-by-ADR | Three concerns kept separate: money fact (ledger), document fact, branding/display fact. | (planned in Phase 2/3) | ADR-016 |
| Gapless number sequences | locked-by-ADR | Per (legal entity, jurisdiction, fiscal year, document type). Allocated only at issue inside the document-row transaction. | (planned in Phase 2) | ADR-016 |
| Object-storage-backed PDF storage | locked-by-ADR | Content-hashed; immutable once issued; corrections via credit/debit notes. | (planned in Phase 2) | ADR-016 |
| Document issue + delivery workers | locked-by-ADR | Run outside booking saga. | (planned in Phase 2) | ADR-010 amendment, ADR-016 |
| Reseller-branded guest documents | locked-by-ADR | `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`. Branding fallback chain: reseller logo → reseller display name → `Account.name` → platform default with ops alert. | (planned in Phase 3) | ADR-017 |
| `COMMISSION_INVOICE` (BB → supplier/upstream) | locked-by-ADR | Monotonic per tenant+supplier+fiscal_year, separate from gapless tax-doc sequences. | (planned in Phase 3) | ADR-020 |
| Tax engine ADR | planned (blocking) | UAE VAT minimal inline acceptable for Phase 2; full engine with UAE + KSA (ZATCA) + place-of-supply / reverse-charge required before reseller onboarding opens. | — | (pending) |

## 14. Rate Intelligence

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| `BenchmarkReadPort` + `BenchmarkSnapshot` | implemented | Read-only advisory contract types. | `packages/rate-intelligence` | ADR-015 |
| Public-rate benchmark ingestion | locked-by-ADR | Advisory only; never authoritative; never sellable; per-tenant, per-jurisdiction legal review before enablement. | (planned in Phase 4) | ADR-015 |
| Benchmark-aware markup (`MARKET_ADJUSTED_MARKUP`) | locked-by-ADR | Pulls advisory inputs into pricing. | — | ADR-004, ADR-015 |
| Benchmark provider selection | blocked | RateGain DataLabs vs OTA Insight vs Lighthouse vs bespoke scraper — Phase 4 commercial decision. | — | ADR-015 |

## 15. Admin & Internal Surfaces

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Internal API key guard | implemented | `InternalAuthGuard` + `@Actor()` on all `/internal/...` endpoints; `X-Internal-Api-Key` header. | `apps/api/src/internal-auth/` | — |
| `admin_audit_log` (interim) | implemented | Append-only log for `/internal/admin/*` mutations: `CREATE | PATCH | SOFT_DELETE | DELETE`. | `apps/api/src/admin/`, `infra/migrations/core/` | (pre-ADR-028) |
| Markup rule admin CRUD | implemented | `/internal/admin/pricing/markup-rules` full CRUD + soft-delete. | `apps/api/src/admin/markup-rule.*` | ADR-004 |
| Promotion admin CRUD | implemented | `/internal/admin/merchandising/promotions` full CRUD + soft-delete. | `apps/api/src/admin/promotion.*` | ADR-009 |
| Direct-contract admin CRUD | implemented | Contracts, seasons, child age bands. | `apps/api/src/direct-contracts/` | ADR-022 |
| Authored restriction + cancellation admin CRUD | implemented | Phase B authored shape. | `apps/api/src/direct-contracts/` | ADR-023 |
| Hotelbeds internal seam | implemented | `POST /internal/suppliers/hotelbeds/content-sync` and `/search` — dev-oriented HTTP surface for adapter end-to-end. | `apps/api/src/adapters/hotelbeds/` | — |
| Audit read API (`GET /admin/audit/events`) | locked-by-ADR | Permission-gated by `AUDIT_READ` + `AUDIT_READ_SENSITIVE`; emits `AUDIT_QUERY_EXECUTED` on every call. | (planned: ADR-028 step 7) | ADR-028 D9 |
| `bb-audit query` CLI | locked-by-ADR | Same query surface as the API; emits `AUDIT_QUERY_EXECUTED`. | (planned: ADR-028 step 8) | ADR-028 D9 |

## 16. Data Storage Substrate

| Capability | Status | Description | Lives in | ADR |
|---|---|---|---|---|
| Postgres 16 + PostGIS | implemented | Primary store; partitioning support for ADR-028. | `infra/docker/`, `infra/migrations/` | ADR-007 |
| MinIO (S3-compatible) | implemented | Object storage for raw payloads, document PDFs (when ADR-016 implemented). Content-hashed addressing. | `apps/api/src/object-storage/` | ADR-007, ADR-016 |
| Redis | implemented | BullMQ broker (workers) + caching. | `infra/docker/` | ADR-007 |
| Three-role DB separation (`bb_app`, `bb_audit_retention`, `bb_admin`) | locked-by-ADR | Required before audit infrastructure ships. | (planned: ADR-028 step 1) | ADR-028 D2 |

## 17. Locked non-features (rejected for V1/V2)

These rows exist so we don't re-litigate.

| Capability | Status | Why rejected | ADR |
|---|---|---|---|
| Flights | rejected (MVP) | Different economic and integration shape; separate later. | CLAUDE.md §6 |
| Transfers, activities, packages, dynamic packaging | rejected (MVP) | Out of MVP. | CLAUDE.md §6 |
| Gamification, multi-level referral chains | rejected | Anti-pattern; clean referral model only. | ADR-014 |
| Full finance / GL integration | rejected (MVP) | Bookings ledger only; proper finance is a later, deliberate project. | CLAUDE.md §6 |
| Approval workflows / travel policies | deferred | Corporate-only; later phase. | CLAUDE.md §6 |
| Stripe Customer Balance as wallet | rejected | Internal double-entry ledger is the wallet. | ADR-012 |
| Stripe Treasury (UAE) | rejected | Not assumed available. | ADR-012 |
| Reseller-of-reseller chains | rejected | Out of scope; needs ADR + commercial driver. | ADR-017 |
| Cross-currency reseller payouts | deferred | Earning currency must equal payout currency in MVP. | ADR-018 |
| Audit-log mutation API | rejected | No code path can edit an audit row. | ADR-028 D11 |
| Audit-log cryptographic hash chain | rejected (V1/V2) | Append-only DB enforcement is enough until a follow-up ADR. | ADR-028 D11 |
| Audit-log SIEM shipping | rejected (V1/V2) | Out of scope; would ship as logical-replication projection. | ADR-028 D11 |
| Per-row audit-log redaction / right-to-erasure | rejected (V1/V2) | Partition-drop is the only deletion path. GDPR interaction tracked as open item. | ADR-028 D11 |
| Operator-as-self search/booking | rejected (V1) | Operators have no `accountId`; impersonation (ADR-027) is the path. | ADR-026 (E4-B), ADR-027 |
| `IMPERSONATE_BOOKING_WRITE` in V1 | rejected (V1) | Read-only impersonation in V1; mutating actions land in V1.x. | ADR-027 |

---

## Cross-cutting invariants (also load-bearing capabilities)

These appear nowhere as a single function but are guarantees the system
must maintain. Repeating them here keeps them visible alongside features.

- **Pricing is account-aware, not channel-aware alone.** ADR-004.
- **Merchandising never mutates priced rates.** ADR-009.
- **Tender (wallet, loyalty, referral, credit, card) is not pricing.**
  ADR-012, ADR-014.
- **Static / dynamic content split is sacred.** ADR-005.
- **Booking-time snapshots are immutable; live shape stays on supply
  side.** ADR-021.
- **Sourced offers and authored primitives are different shapes; never
  flatten one into the other.** ADR-021.
- **Reseller resale amount is a document property, never a ledger fact,
  never a pricing rule.** ADR-017.
- **Tax invoice ≠ commercial confirmation ≠ branded voucher.** ADR-016.
- **Audit log is append-only at the DB role level.** ADR-028 D1.
- **AUTH and IMPERSONATION audit writes share the business
  transaction.** ADR-028 D7.
