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
- First adapter: **Hotelbeds** — `listHotels`, `getHotelContent`,
  `listHotelImages`, `searchAvailability`, `quoteRate`, health check.
  Sandbox credentials configured.
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
- **Internal ledger (ADR-012):** `LedgerEntry`, `WalletAccount`,
  balance views. `CASH_WALLET` and `PROMO_CREDIT` books only in this
  phase.
- **Stripe integration (ADR-012):** PaymentIntent authorize + capture,
  refund webhook, dispute webhook. Stripe Connect scaffolding only
  (not yet used for transfers). Webhook ingestion is idempotent,
  keyed by Stripe event id.
- **Tender composition UI** for B2C: pay all-card, or pay
  card+promo_credit. Admin can grant promo credit.
- **Basic loyalty accrual (ADR-014):** earn rule model + one default
  rule, `REWARD_ACCRUAL` posted on `REWARDS_ACCRUED`, maturation
  worker that runs daily and promotes PENDING → POSTED after stay +
  clawback window. No redemption UI yet.
- Voucher generation (PDF) + email (transactional provider).
- Cancellation flow with policy lookup + supplier cancel +
  `REWARD_CLAWBACK`.
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
- **B2C referral v1 (ADR-014):** referral code issuance, invite
  tracking, both-sides reward accrual, anti-fraud engine with signal
  ingestion + manual review queue.
- **B2B credit lines + invoicing (ADR-012):** `CreditLine` CRUD,
  `CREDIT_DRAWDOWN` tender, monthly invoice generator, Stripe and
  bank-transfer settlement paths.

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
- **Loyalty tiers (ADR-014):** derived tier view + tier-scoped earn
  rules.

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

Adding any of these requires a new ADR and a roadmap update.
