# Roadmap — phased delivery plan

Phases are scope gates, not calendar deadlines. A phase ends when its
exit criteria are met, not when a date arrives. Each phase should be
shippable in isolation (internally, not necessarily to end users).

## Phase 0 — Foundation (now)

**Goal:** lock decisions, scaffold repo, minimize rework later.

- [x] ADR-001 foundation
- [x] ADR-002 canonical hotel model
- [x] ADR-003 supplier adapter contract
- [x] ADR-004 pricing rule model
- [x] ADR-005 static/dynamic split
- [x] ADR-006 tenancy and accounts
- [x] ADR-007 tech stack
- [x] ADR-008 mapping strategy
- [x] ADR-009 merchandising and ranking
- [x] ADR-010 booking orchestration
- [x] ADR-011 monorepo structure
- [x] ADR-012 payments, wallet, credit ledger, payouts
- [x] ADR-013 direct hotel connectivity via CRS / channel managers
- [x] ADR-014 loyalty, rewards, referral
- [x] ADR-015 market benchmark / intelligent markup
- [x] ADR-016 document generation, numbering, storage
- [x] ADR-017 reseller billing, resale controls, branded documents
- [x] ADR-018 reseller collections, balances, reserves, and payouts
- [x] ADR-020 collection mode and supplier settlement mode
- [x] ADR-021 rate, offer, restriction, and occupancy model
- [ ] Repo scaffolding (monorepo shell, CI baseline, tsconfig base,
      ESLint, dependency-direction rules)
- [ ] Local dev env (Docker Compose: Postgres + PostGIS, Redis, object
      storage emulator)
- [ ] Observability skeleton (OpenTelemetry wiring, Pino logs)

**Exit:** a developer can clone, `pnpm install`, `pnpm dev`, and see
the empty `apps/api` answer a health check.

## Phase 1 — Read-only core spine

**Goal:** prove the sourcing → mapping → content → search spine on
one aggregator.

- Supplier contract package (ADR-003) with types and the conformance
  test harness.
- **Rate-model migrations (ADR-021) — ships before the Hotelbeds
  adapter.** Canonical product dimensions (`hotel_room_type`,
  `hotel_rate_plan`, `hotel_meal_plan`, `hotel_occupancy_template`,
  `hotel_child_age_band`), the four mapping tables
  (`hotel_room_mapping`, `hotel_rate_plan_mapping`,
  `hotel_meal_plan_mapping`, `hotel_occupancy_mapping`), and the
  sourced-offer snapshot tables (`offer_sourced_snapshot`,
  `offer_sourced_component`, `offer_sourced_restriction`,
  `offer_sourced_cancellation_policy`). No authored-rate
  (`rate_auth_*`) tables yet — Phase 3. No booking-time snapshot
  tables yet — Phase 2.
- First adapter: **Hotelbeds** — `listHotels`, `getHotelContent`,
  `listHotelImages`, `searchAvailability`, `quoteRate`, health check.
  Sandbox credentials configured. Declares
  `offer_shape = SOURCED_COMPOSED` and
  `min_rate_breakdown_granularity = TOTAL_ONLY` (ADR-021); every
  `searchAvailability` response writes one `offer_sourced_snapshot`
  row plus `offer_sourced_cancellation_policy` (structured +
  verbatim prose); raw payload hashed + persisted to object storage.
- Canonical hotel + `SupplierHotel` + `HotelMapping` tables.
- Deterministic mapping only (code match, geo+name exact/tight).
  Fuzzy queue is populated but no review UI yet.
- Static content merge with curator override hooks (no UI yet — admin
  API endpoints only).
- Image pipeline: on-demand fetch, hash-dedup, moderation placeholder
  (admin-visible only until moderated).
- Basic pricing: net cost + tenant-default markup + account-type
  default. Rule storage in place even if few rules exist.
- Search API: `POST /search`, returns ranked priced offers with
  tracing.
- **Money-movement triple declared per rate (ADR-020).** Every
  `SupplierRate` returned by the Hotelbeds adapter carries
  `CollectionMode`, `SupplierSettlementMode`, `PaymentCostModel`,
  and `gross_currency_semantics`. Adapter `meta` declares supported
  modes. Conformance tests enforce the triple. Source selection
  filters invalid `(CollectionMode, SupplierSettlementMode)` pairs.
  No money flow yet — this phase is declarative only.
- Minimal B2C search results page (Next.js). No checkout.
- Admin API: list canonical hotels, view mappings, override content.
- Observability: traces and key metrics for search and content
  refresh.

**Exit:** search a destination, return priced offers from Hotelbeds
with mapped canonical hotels, with a visible pricing trace in logs.

## Phase 2 — Bookable spine + wallet foundation

**Goal:** end-to-end booking for single-hotel carts on one supplier,
with the wallet ledger standing up and basic loyalty earning.

- Booking saga (ADR-010) with all steps and compensations (including
  new `TENDER_RESOLVED` and `REWARDS_ACCRUED` steps), BullMQ workers,
  state machine in Postgres.
- **Booking-time snapshot tables (ADR-021):**
  `booking_sourced_offer_snapshot`,
  `booking_cancellation_policy_snapshot`, and
  `booking_tax_fee_snapshot` (write paths for sourced bookings).
  `booking_authored_rate_snapshot` table schema ships as an empty
  target so migrations are stable; no write path until Phase 3.
  Snapshots are written in the same transaction as `CONFIRMED`.
- **Internal ledger (ADR-012):** `LedgerEntry`, `WalletAccount`,
  balance views. `CASH_WALLET` and `PROMO_CREDIT` books only in this
  phase.
- **Stripe integration (ADR-012):** PaymentIntent authorize + capture,
  refund webhook, dispute webhook. Stripe Connect scaffolding only
  (not yet used for transfers). Webhook ingestion is idempotent,
  keyed by Stripe event id.
- **Tender composition UI** for B2C: pay all-card, or pay
  card+promo_credit. Admin can grant promo credit.
- **Basic loyalty accrual (ADR-014 + 2026-04-22 amendment):** earn rule
  model + one default `PERCENT_OF_MARGIN` rule over `recognized_margin`,
  `funding_source = PLATFORM_FUNDED`. `RewardPosting` + per-funder
  `RewardFundingLeg`, `REWARD_ACCRUAL` posted on `REWARDS_ACCRUED`,
  maturation worker promotes PENDING → POSTED after stay + clawback
  window. `recognized_margin` view exposed by pricing to rewards. No
  redemption UI yet. `HOTEL_FUNDED` / `SHARED_FUNDED` and campaigns are
  Phase 3.
- **Document primitives (ADR-016):** `LegalEntity` +
  `DocumentNumberSequence` + `DocumentTemplate` + `BookingDocument`
  + `DeliveryAttempt` tables. One Beyond Borders legal entity (UAE)
  seeded. Gapless sequential numbering for UAE VAT `TAX_INVOICE` /
  `CREDIT_NOTE` / `DEBIT_NOTE`; monotonic sequences for
  `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`. Object-storage buckets
  (`documents`, write-once policy for legal tax docs).
- **Document issue + delivery workers (ADR-016):** triggered by
  `BookingConfirmed` event (ADR-010 amendment), materializes
  `TAX_INVOICE` + `BB_BOOKING_CONFIRMATION` + `BB_VOUCHER` for the
  direct Beyond Borders B2C flow. Delivery worker handles email with
  retries.
- **UAE VAT minimal tax computation** wired into `TAX_INVOICE`
  issuance (seller BB legal entity registration, standard-rated
  B2C hotel supply). Full tax-engine ADR deferred; this is the
  minimum to ship correct invoices for the BB direct flow.
- Cancellation flow with policy lookup + supplier cancel +
  `REWARD_CLAWBACK` + `CREDIT_NOTE` issuance against the original
  `TAX_INVOICE`.
- **Collection mode v1 — `BB_COLLECTS` only (ADR-020).** Bookable
  rates in Phase 2 are restricted to `BB_COLLECTS` with
  `SupplierSettlementMode ∈ { PREPAID_BALANCE, POSTPAID_INVOICE }`
  and `PaymentCostModel ∈ { PLATFORM_CARD_FEE,
  BANK_TRANSFER_SETTLEMENT }`. Matches TBO (prepaid) and Hotelbeds
  merchant (postpaid) scope. Supplier-side books ship:
  `supplier_prepaid_balance_<supplier_id>`,
  `supplier_postpaid_payable_<supplier_id>` with admin CRUD for
  top-ups and cycle-invoice settlement (manual in Phase 2). New
  ledger kinds: `SUPPLIER_PREPAID_TOPUP`, `SUPPLIER_PREPAID_DRAWDOWN`,
  `SUPPLIER_POSTPAID_ACCRUAL`, `SUPPLIER_POSTPAID_SETTLEMENT`.
  `recognized_margin` uses the `BB_COLLECTS` formula with platform
  card-fee estimation. Other collection modes (`PROPERTY_COLLECT`,
  `UPSTREAM_PLATFORM_COLLECT`, `VCC_TO_PROPERTY`,
  `COMMISSION_ONLY`) are architecture-first-class but not bookable
  yet.
- Nightly reconciliation job (our bookings vs supplier reports,
  plus ledger vs Stripe events).
- Rule authoring admin UI (basic CRUD over `PricingRule` and
  `LoyaltyEarnRule`).
- Mapping review UI (basic — resolve queued `MappingReviewCase`s).

**Exit:** a B2C user can search, book, pay (card + optional promo
credit), receive a voucher, cancel, and see rewards accrue and
mature. All flows traced and reconciled against both the supplier
and Stripe.

## Phase 3 — Multi-supplier, merchandising, referral, B2B credit, first direct-connect

**Goal:** multi-source distribution with safe merchandising; wallet
and rewards mature into a full consumer-facing surface; first direct
connection live; B2B credit operable.

- Second aggregator: **WebBeds**. Run adapter conformance tests.
- Third aggregator: **TBO**.
- First direct contract live via the direct-contract (paper) adapter.
- **First direct-connect adapter: SynXis Channel Connect (ADR-013).**
  Content + ARI + reservation + change discovery. One pilot property.
- **Authored-rate primitives (ADR-021):** `rate_auth_base_price`,
  `rate_auth_extra_person_rule`, `rate_auth_meal_supplement`,
  `rate_auth_tax_component`, `rate_auth_fee_component`,
  `rate_auth_restriction`, `rate_auth_allotment`,
  `rate_auth_cancellation_policy` migrations ship with the first
  direct-connect adapter. Write path for
  `booking_authored_rate_snapshot` lights up. Pricing evaluator
  gains the `AUTHORED_PRIMITIVES` code path.
- **Seasonal contracts and promotions (ADR-021 amendment
  2026-04-23) — lands before the direct-paper adapter within
  Phase 3.** Migrations: `rate_contract`, `rate_contract_season`,
  `rate_contract_season_date_band`, `rate_contract_price`,
  `rate_promotion`, `rate_promotion_scope`, `rate_promotion_rule`;
  additive nullable `contract_id?` / `season_id?` columns on the
  four `rate_auth_*` tables that support narrow scoping
  (extra-person rule, meal supplement, restriction, cancellation
  policy) plus `contract_id?` on fee component. `BookingAuthoredRateSnapshot`
  gains `authoring_mode`, `contract_id?`, `season_id?`, and
  `applied_promotions_jsonb` (additive). Copy-season service and
  operator UI are Phase 3 admin surface; pricing evaluator gains
  the `SEASONAL_CONTRACT` sub-path within `AUTHORED_PRIMITIVES`,
  including promotion stacking and `applies_to` ordering.
- Merchandising: `MerchandisingCampaign`, placements, boost cap
  configuration, sponsored-slot disclosure.
- Ranking module: price-first, with relevance and quality signals,
  respecting merchandising boosts within caps.
- Multi-supplier source selection inside pricing (per ADR-004).
- Per-account markup rules (not just per-type) with admin UI.
- Giata or equivalent cross-reference integration for deterministic
  mapping coverage.
- **Loyalty redemption UI (ADR-014):** tender composition surfaces
  `LOYALTY_REWARD` as a payment option. `TenderPolicy` CRUD in admin.
- **Hotel-funded rewards + campaigns (ADR-014 amendment):**
  `RewardCampaign` + `HotelRewardOverride` admin, funding-agreement
  linkage, `HOTEL_FUNDED` / `SHARED_FUNDED` ledger legs, invoicing
  hand-off for hotel-funded reward cost at supplier reconciliation.
- **Manual reward overrides:** admin surface for `MANUAL_OVERRIDE`
  postings with mandatory reason codes and approval workflow;
  `RewardOverrideAudit` visible in admin.
- **B2B kickback v1:** margin-based kickback rules scoped per
  agency / corporate / subscriber account, payout configurable as
  reward-wallet accrual or invoice credit.
- **B2C referral v1 (ADR-014):** referral code issuance, invite
  tracking, both-sides reward accrual, anti-fraud engine with signal
  ingestion + manual review queue.
- **B2B credit lines + invoicing (ADR-012):** `CreditLine` CRUD,
  `CREDIT_DRAWDOWN` tender, monthly invoice generator, Stripe and
  bank-transfer settlement paths.
- **Reseller capability (ADR-017):** `ResellerProfile` +
  `BillingProfile` + `TaxProfile` + `BrandingProfile` +
  `ResellerResaleRule` + `GuestPriceDisplayPolicy` tables.
  Admin CRUD (platform-admin bootstrapped; reseller self-serve
  deferred to Phase 4 B2B portal). Logo upload with MIME/size/hash
  validation into a `branding-assets` object-storage bucket.
- **Reseller-branded document issue (ADR-016 + ADR-017):**
  `RESELLER_GUEST_CONFIRMATION` and `RESELLER_GUEST_VOUCHER`
  document types, per-reseller `DocumentNumberSequence`, branded
  templates with the fallback chain (logo → display name →
  `Account.name` → platform default + ops alert).
- **Reseller-channel tax invoice:** BB `TAX_INVOICE` issued from
  the Beyond Borders `LegalEntity` to the reseller's
  `BillingProfile`, using the reseller's `TaxProfile` for
  place-of-supply and reverse-charge handling where applicable.
  Delivery per `BillingProfile.invoice_delivery`.
- **Credit / debit note flow** on reseller-channel cancellations
  and amendments, referencing the original `TAX_INVOICE`.
- **Tax engine ADR + UAE/KSA extensibility** — narrow tax-engine
  port consumed by `documents`; UAE implementation mandatory
  before reseller onboarding opens; KSA ZATCA profile stub.
- **Collection mode v2 — VCC and pay-at-hotel enabled (ADR-020).**
  `SupplierSettlementMode = VCC_TO_PROPERTY` lights up for
  `BB_COLLECTS` rates that require it (e.g. Expedia Rapid Collect,
  selected Hotelbeds merchant rates). New saga step
  `VCC_ISSUED` between supplier-book and capture, with
  `FAILED_VCC_LOAD` failure handling. VCC provider integration
  (provider TBD — Stripe Issuing / WEX / AirPlus) shipped.
  `PROPERTY_COLLECT + COMMISSION_ONLY` lights up: saga skips
  authorize/capture; no BB `TAX_INVOICE` to guest;
  `COMMISSION_INVOICE` document archetype to the supplier;
  `supplier_commission_receivable_<supplier_id>` book + new
  ledger kinds (`SUPPLIER_COMMISSION_ACCRUAL`,
  `SUPPLIER_COMMISSION_RECEIVED`, `SUPPLIER_COMMISSION_CLAWBACK`).
  `PROPERTY_COLLECT + DIRECT_PROPERTY_CHARGE` lights up as
  confirmation-only (no ledger entry on our side).
  `recognized_margin` adopts mode-aware cost-inclusion lists.
  `vcc_issuance_suspense` book + `VCC_LOAD`, `VCC_SETTLEMENT`,
  `VCC_UNUSED_RETURN` ledger kinds.
- **Reseller settlement mode v1 — `RESELLER_COLLECTS` only
  (ADR-018).** `ResellerProfile.settlement_mode` enum with a single
  active value in Phase 3 (default). All reseller-channel bookings
  continue to settle through the reseller's `BillingProfile` +
  `CreditLine`. `CREDIT_ONLY` and `PAYOUT_ELIGIBLE` are
  architecture-first-class but not yet enabled; their tables ship
  in Phase 3 behind a feature flag so that migrations are stable,
  but no production reseller is graduated yet.

**Exit:** searches return results from three aggregators plus a
direct paper contract plus one SynXis-connected property. At least
one sponsored campaign live and auditable. B2C referral program
live with anti-fraud. Agencies can book on credit and receive
monthly invoices.

## Phase 4 — B2B channels + market intelligence + more direct-connect

**Goal:** open the agency, subscriber, and corporate front doors;
introduce market-aware pricing; add a second direct-connect provider.

- B2B portal (Next.js) with role-routed views for agency,
  subscriber, corporate.
- Account invitation and membership management.
- Agency-specific: agent-booking-on-behalf-of flows, markup
  customization per agency, credit line dashboards.
- Subscriber-specific: member-only rate eligibility and visibility
  rules.
- Corporate-specific: negotiated rate surfacing, traveler
  management. Approval flows still deferred.
- SSO (OIDC/SAML) opt-in per account.
- **Rate-intelligence module (ADR-015):** ingestion scheduler, first
  benchmark source (commercial feed or licensed scraper), canonical
  `BenchmarkSnapshot` store, query API for pricing.
- **`MARKET_ADJUSTED_MARKUP` pricing rule (ADR-015):** evaluated
  inside the markup chain, mandatory trace with snapshot id, tenant
  kill-switch.
- **Second direct-connect adapter:** RateGain Channel Manager **or**
  SiteMinder (whichever reaches commercial first).
- **Collection mode v3 — upstream platform collect (ADR-020).**
  `UPSTREAM_PLATFORM_COLLECT + COMMISSION_ONLY` enabled, gated on
  a real Booking.com Demand API (or equivalent) commercial and
  legal confirmation. Saga learns to wait on the upstream-platform
  confirmation webhook before transitioning `CONFIRMED`. Multi-
  currency commission handling with explicit FX. Automated
  commission clawback on cancellations after accrual. VCC
  recovery / `VCC_UNUSED_RETURN` automation for expired or
  uncharged VCCs. Commission reconciliation workflow against
  supplier / upstream statements.
- **Loyalty tiers (ADR-014):** derived tier view + tier-scoped earn
  rules.
- **Reseller settlement v2 — `CREDIT_ONLY` enablement (ADR-018).**
  `ResellerKycProfile` onboarding flow (KYB, beneficial owners,
  sanctions / PEP screening via provider integration),
  `reseller_collections_suspense` book wired into Stripe
  `payment_intent.succeeded` webhook handling for reseller-channel
  bookings where BB collects the guest payment. New ledger kinds:
  `RESELLER_CREDIT_ACCRUAL`, `RESELLER_CREDIT_REDEMPTION`,
  `RESELLER_CREDIT_CLAWBACK`, `RESELLER_CREDIT_EXPIRY`. Tender
  composition surfaces `RESELLER_PLATFORM_CREDIT` as a payment
  option for the reseller on future bookings. No withdrawals,
  no `PayoutAccount` flow.

**Exit:** each B2B channel can onboard an account, book, pay or
invoice, see only what their account is entitled to. Pricing is
market-aware on configured hotels with a visible benchmark trace.
A second direct-connect integration is live on at least one
property.

## Phase 5 — Scale, more direct-connect, cash wallet

**Goal:** grow beyond MVP economics without rewriting foundations.

- Market-aware pricing rules expansion (country/region/city, season,
  rate-class combined with benchmarks).
- Search index migration to OpenSearch once Postgres search strains.
- Fuzzy-match mapping with human-review queue at scale.
- Advanced content moderation.
- Temporal evaluation for saga orchestration (if ADR-010 revisit
  triggers fire).
- Expedia Rapid integration (if commercial signed).
- **Additional direct-connect adapters:** Mews, Cloudbeds, Channex
  as demand dictates.
- **Cash wallet (`CASH_WALLET`) launch** pending jurisdictional
  legal clearance (UAE stored-value review; ADR-012 open item).
- **Referral program hardening** based on Phase 3 fraud learnings —
  tune anti-fraud thresholds, add velocity controls, expand manual
  review tooling.
- **Reseller settlement v3 — `PAYOUT_ELIGIBLE` enablement (ADR-018),
  jurisdiction-gated.** `PayoutAccount` verification (Stripe Connect
  connected-account for supported markets, local bank rails
  elsewhere), full earnings lifecycle (pending → available →
  reserved → paid_out with clawback), `ReserveBalance` rules
  (rolling percent, chargeback history, new-reseller ramp),
  `WithdrawalRequest` + `PayoutBatch` pipeline, `RefundLiabilityRule`
  enforcement. Launch per-jurisdiction only after legal clearance
  for that tenant + country. Shares the same stored-value gating
  as `CASH_WALLET` where applicable. Reseller self-serve
  withdrawal UI deferred to Phase 4 B2B portal.

## Phase 6 — Platform productization and marketplace payouts

**Goal:** make tenant #2 a configuration event; enable marketplace
money movement.

- Tenant #2 onboarding flow.
- White-label theming per tenant.
- Partner/public API for external integrators.
- Data export for tenants that leave.
- Multi-tenant admin console.
- **Stripe Connect separate charges + transfers (ADR-012)** for
  marketplace payouts (agency commission payouts, tenant-of-tenant
  resale revenue sharing).
- **Payout batches and reconciliation** — ledger-native, with
  Stripe transfer ids cross-referenced.
- Possible Booking.com Demand API (only if commercial + legal
  confirm).

## What is explicitly **not** on this roadmap

- Flights, transfers, activities, dynamic packaging.
- Full finance / accounting / GL integration (beyond the internal
  ledger defined in ADR-012).
- Corporate approval workflows and travel policy engines.
- Multi-level referral chains (MLM patterns explicitly out; ADR-014).
- Cashback-as-cash conversion by default (ADR-012 open item).
- Converting historical `RESELLER_PLATFORM_CREDIT` into withdrawable
  cash on a `CREDIT_ONLY` → `PAYOUT_ELIGIBLE` upgrade — explicitly
  out of scope (ADR-018). Old credit stays credit; only new
  accruals post to the cash book.
- Mirroring upstream-platform guest collections into our ledger
  as `PaymentIntent`s — explicitly out of scope (ADR-020). We
  never touched that money; only the commission receivable is our
  concern.
- `BB_COLLECTS + COMMISSION_ONLY` and other ADR-020-forbidden
  combinations — not a roadmap item, they are closed-set rejected.
- Reseller-of-reseller chains (ADR-017).

Adding any of these requires a new ADR and a roadmap update.
