# TASKS

Running task list for Beyond Borders. Newest at the top of each section.
Claude must keep this file current at the start and end of every working
session.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

---

## Now (this session)

- [x] Create foundational repo docs: CLAUDE.md, README.md, TASKS.md,
      docs/architecture/overview.md, docs/adrs/ADR-001-foundation.md,
      docs/prompts/session-start.md, .gitignore baseline.
- [x] ADR-002 canonical hotel data model
- [x] ADR-003 supplier adapter contract
- [x] ADR-004 pricing rule model and precedence
- [x] ADR-005 static vs dynamic content split
- [x] ADR-006 tenancy and account model
- [x] ADR-007 tech stack (provisional)
- [x] ADR-008 hotel mapping strategy
- [x] ADR-009 merchandising and ranking
- [x] ADR-010 booking orchestration
- [x] ADR-011 monorepo structure
- [x] Update architecture overview to reflect ADRs 002–011
- [x] Domain entities cross-cutting index (`docs/data-model/entities.md`)
- [x] Phased roadmap (`docs/roadmap.md`)
- [x] ADR-012 payments, wallet, credit ledger, payouts
- [x] ADR-013 direct hotel connectivity (CRS / channel managers)
- [x] ADR-014 loyalty, rewards, referral
- [x] ADR-015 market benchmark / intelligent markup
- [x] Amend ADR-003 / ADR-004 / ADR-006 / ADR-010 / ADR-011 for the
      scope expansion (additive sections)
- [x] Update CLAUDE.md §3 / §5 / §6 / §9 / §10 for scope expansion
- [x] Update README.md (sources, wallet, rewards, phased scope)
- [x] Update `docs/architecture/overview.md` (invariants + module map)
- [x] Update `docs/data-model/entities.md` (ledger, rewards,
      rate-intelligence, direct-connect entities + table prefixes)
- [x] Update `docs/roadmap.md` for Phase 2–6 revisions
- [x] Connectivity notes: `docs/suppliers/synxis.md`, `rategain.md`,
      `siteminder.md`, `mews.md`, `cloudbeds.md`, `channex.md`
- [x] Design note: `docs/design/payments.md`
- [x] Design note: `docs/design/rewards-referral.md`
- [x] **ADR-014 amendment 2026-04-22** — margin-based reward economics,
      `recognized_margin` / `rewardable_margin` contract, funding-source
      taxonomy (`PLATFORM_FUNDED | HOTEL_FUNDED | SHARED_FUNDED`), new
      rule types (`PERCENT_OF_MARGIN` *default*,
      `FIXED_REWARD_BY_MARGIN_BRACKET`, `HOTEL_FUNDED_BONUS`,
      `MANUAL_OVERRIDE`, `CAP_AND_FLOOR`), `RewardCampaign`,
      `HotelRewardOverride`, `RewardFundingLeg`, `RewardOverrideAudit`
      entities, margin-based B2B kickback, observability by funder and
      margin band.
- [x] Update `docs/design/rewards-referral.md` §5, anti-patterns, §10
      (travel-reward UX lineage: tiers, redeem-at-booking, post-
      completion crediting, wallet clarity, lifetime points).
- [x] Update `docs/data-model/entities.md` rewards section + reward_
      table prefix list.
- [x] Update `CLAUDE.md` §5 / §9 / §10 with margin-based earning and
      funding-source invariants.
- [x] Update `docs/roadmap.md` Phase 2 (margin default), Phase 3
      (hotel-funded campaigns, manual overrides, B2B kickback v1).
- [x] **ADR-016 2026-04-22** — document generation, numbering,
      storage. Document types (`TAX_INVOICE`, `CREDIT_NOTE`,
      `DEBIT_NOTE`, `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`,
      `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`),
      `LegalEntity`, `DocumentNumberSequence` (gapless per legal
      entity + jurisdiction + fiscal year for legal tax docs),
      `DocumentTemplate`, `BookingDocument`, `DeliveryAttempt`,
      object-storage-backed PDF storage, document issue + delivery
      workers outside the booking saga.
- [x] **ADR-017 2026-04-22** — reseller billing, resale controls,
      branded documents. Reselling as a capability (`ResellerProfile`)
      on AGENCY/SUBSCRIBER accounts; versioned `BillingProfile`,
      `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`
      (FIXED_GUEST_AMOUNT | FIXED_MARKUP_ABSOLUTE | PERCENT_MARKUP
      | HIDE_PRICE), `GuestPriceDisplayPolicy`; branding fallback
      chain; hard separation of source cost / BB sell-to-reseller /
      reseller resale amount.
- [x] Amend ADR-006 (reseller capability + `LegalEntity`),
      ADR-010 (document-issue worker outside saga), ADR-011
      (`packages/documents` + `packages/reseller` + table
      prefixes `doc_` / `reseller_`), ADR-012 (tax invoice is a
      document, not a ledger entry; reseller ledger writes only
      the sell-to-reseller amount).
- [x] Update `docs/data-model/entities.md` with reseller,
      billing, tax, branding, document entities and `doc_` /
      `reseller_` prefixes.
- [x] Update `CLAUDE.md` §2, §5, §9 (items 10–14), §10 for the
      reseller capability model, document model, and ledger-vs-
      document / tax-invoice-vs-commercial-voucher invariants.
- [x] Update `docs/roadmap.md` Phase 2 (document primitives +
      Beyond Borders direct tax invoice + BB voucher + confirmation)
      and Phase 3 (reseller capability + branded guest docs +
      reseller-channel tax invoice + tax engine ADR).
- [x] **ADR-018 2026-04-21** — reseller collections, balances,
      reserves, and payouts. Three settlement modes
      (`RESELLER_COLLECTS` default, `CREDIT_ONLY`,
      `PAYOUT_ELIGIBLE`), two new wallet books
      (`RESELLER_PLATFORM_CREDIT` non-withdrawable,
      `RESELLER_CASH_EARNINGS` withdrawable), earnings state
      machine derived from ledger (pending → available → reserved
      → paid_out with clawback), new ledger kinds, new entities
      (`ResellerKycProfile`, `PayoutAccount`, `ReserveBalance`,
      `WithdrawalRequest`, `PayoutBatch`, `RefundLiabilityRule`),
      hard KYC/KYB + sanctions/PEP + verified-PayoutAccount gating
      for `PAYOUT_ELIGIBLE`, `INDIVIDUAL_NOT_BUSINESS` never
      eligible in MVP, `reseller_collections_suspense` book for
      BB-collected guest payments on reseller-channel bookings.
- [x] Amend ADR-012 (new wallet balance types, new ledger kinds,
      reseller-collections suspense book, extended `PayoutBatch`
      scope; launch gate shared with `CASH_WALLET` jurisdictional
      review) and ADR-017 (`settlement_mode` on `ResellerProfile`,
      split onboarding with KYC + payout-account steps, anti-
      patterns for silent credit-to-cash conversion and routing
      guest payments into a `CASH_WALLET`).
- [x] Update `docs/data-model/entities.md` with reseller settlement
      entities, extended ledger kinds, `reseller_collections_suspense`
      book, and `pay_` / `reseller_` prefix additions.
- [x] Update `docs/architecture/overview.md` with invariants 13–17
      covering reseller settlement mode gating, distinct credit vs
      cash earnings books, ledger-derived state machine, payout
      evidence gate, and `PayoutBatch` reconciliation rule.
- [x] Update `docs/roadmap.md`: Phase 3 ships settlement-mode tables
      and `RESELLER_COLLECTS` only; Phase 4 enables `CREDIT_ONLY`
      with KYC; Phase 5 enables `PAYOUT_ELIGIBLE` per-jurisdiction
      behind the same legal-review gate as `CASH_WALLET`. Historical
      credit-to-cash conversion on upgrade called out as explicitly
      out of scope.
- [x] **ADR-020 2026-04-21** — collection mode and supplier
      settlement mode. Three orthogonal enums: `CollectionMode`
      (`BB_COLLECTS` | `RESELLER_COLLECTS` | `PROPERTY_COLLECT` |
      `UPSTREAM_PLATFORM_COLLECT`), `SupplierSettlementMode`
      (`PREPAID_BALANCE` | `POSTPAID_INVOICE` | `COMMISSION_ONLY`
      | `VCC_TO_PROPERTY` | `DIRECT_PROPERTY_CHARGE`),
      `PaymentCostModel` (`PLATFORM_CARD_FEE` | `RESELLER_CARD_FEE`
      | `PROPERTY_CARD_FEE` | `UPSTREAM_NETTED` |
      `BANK_TRANSFER_SETTLEMENT`). Strict allowed-combinations
      matrix; forbidden triples rejected at source selection before
      pricing runs. New adapter rate fields
      (`gross_currency_semantics`, `commission_basis`,
      `commission_params`), new pricing trace step
      `COLLECTION_AND_SETTLEMENT_BIND`, new saga step `VCC_ISSUED`
      (for `VCC_TO_PROPERTY`). New supplier-side internal books
      (`supplier_prepaid_balance_<id>`,
      `supplier_postpaid_payable_<id>`,
      `supplier_commission_receivable_<id>`, `vcc_issuance_suspense`)
      and new ledger kinds (`SUPPLIER_PREPAID_*`,
      `SUPPLIER_POSTPAID_*`, `SUPPLIER_COMMISSION_*`, `VCC_*`).
      New `COMMISSION_INVOICE` document archetype (BB → supplier /
      upstream), monotonic per tenant+supplier+fiscal_year,
      separate from legal-tax-doc gapless sequences. Mode-aware
      `recognized_margin`: `BB_COLLECTS` includes platform card
      fee, `RESELLER_COLLECTS` excludes it, `COMMISSION_ONLY`
      modes compute margin from the commission stream rather than
      a gross-to-net differential.
- [x] Amend ADR-003 (three axes on `StaticAdapterMeta` and
      `SupplierRate`, supersedes `booking_payment_model`),
      ADR-004 (mode-aware net cost, `COLLECTION_AND_SETTLEMENT_BIND`
      trace step, mode-aware `recognized_margin`), ADR-010 (saga
      branching on `CollectionMode`, `VCC_ISSUED` step between
      `SUPPLIER_BOOKED` and `PAYMENT_CAPTURED`, `FAILED_VCC_LOAD`
      state), ADR-012 (supplier-side books, new `LedgerEntry`
      kinds, `PaymentCostModel` on payment entries, no
      `PaymentIntent` mirror on `PROPERTY_COLLECT` /
      `UPSTREAM_PLATFORM_COLLECT`, reseller earnings accrual
      write-gate requires `BB_COLLECTS`), ADR-017 (cross-link
      with ADR-020 clarifying `RESELLER_COLLECTS` dual meaning),
      ADR-018 (anti-pattern: reseller earnings accrual on
      `PROPERTY_COLLECT` / `UPSTREAM_PLATFORM_COLLECT` rejected
      at ledger-write time).
- [x] Update `docs/data-model/entities.md` with "Money-movement
      axes" section (three enums), extend `SupplierRate` /
      `ConfirmedSupplierRate` / `Booking` to carry the triple,
      add supplier-side internal books, extend `LedgerEntry` kinds
      with `SUPPLIER_*` and `VCC_*`, add `COMMISSION_INVOICE`
      document archetype, tag `doc_` prefix with ADR-020.
- [x] Update `docs/architecture/overview.md` with invariants
      18–22 (three-axis triple declared per rate, forbidden
      combinations filtered at source selection, mode-aware
      `recognized_margin`, no `TAX_INVOICE` on `PROPERTY_COLLECT`
      / `UPSTREAM_PLATFORM_COLLECT`, no `PaymentIntent` mirror
      for money BB never touched).
- [x] Update `docs/roadmap.md`: Phase 1 ships the three enums
      declaratively with forbidden triples enforced; Phase 2 ships
      `BB_COLLECTS` + (`PREPAID_BALANCE` | `POSTPAID_INVOICE`) as
      the only bookable path; Phase 3 enables `VCC_TO_PROPERTY`
      and `PROPERTY_COLLECT` + `COMMISSION_ONLY`; Phase 4 enables
      `UPSTREAM_PLATFORM_COLLECT`. Forbidden combinations listed
      as explicitly out of scope.

## Next (Phase 0 — finishing the foundation)

- [ ] Repo scaffolding: pnpm workspaces + Turborepo + `tsconfig.base.json`
      + ESLint with `import/no-restricted-paths` for dependency direction.
- [ ] Empty `apps/api` (NestJS) with a health endpoint.
- [ ] Empty `apps/worker` sharing the composition root.
- [ ] Empty `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` (Next.js).
- [ ] `packages/domain` with zero-dependency core types scaffold.
- [ ] `packages/supplier-contract` with the interface from ADR-003
      (including the ADR-013 ingestion-mode amendment).
- [ ] `packages/ledger` skeleton — `LedgerEntry`, `WalletAccount`,
      balance view ports (no implementation yet).
- [ ] `packages/payments` skeleton — Stripe port interface only.
- [ ] `packages/rewards` skeleton — earn-rule and referral-invite
      types, maturation-worker entry point.
- [ ] `packages/rate-intelligence` skeleton — `BenchmarkSnapshot`
      type + read-only query port.
- [ ] Local dev Docker Compose: Postgres+PostGIS, Redis, object storage
      emulator. (Optional: add Stripe CLI service for webhook testing.)
- [ ] CI baseline: typecheck, lint, unit tests, dependency-direction
      lint (including pricing → rate-intelligence allowed but not
      reverse).
- [ ] OpenTelemetry wiring (backend + workers).
- [ ] Aggregator stubs: `docs/suppliers/hotelbeds.md`, `webbeds.md`,
      `tbo.md` capturing known API shape, auth, quirks.
- [ ] `docs/flows/search.md`, `docs/flows/booking.md`,
      `docs/flows/tender-resolution.md`, `docs/flows/reward-lifecycle.md`
      (first drafts).

## Later (beyond Phase 0)

See `docs/roadmap.md`. Phase 1 onward.

## Open risks / uncertainties

- [!] **Rayna** integration — technical availability and data shape
      unconfirmed. Adapter is conditional.
- [!] **Booking.com Demand API** — commercial eligibility unknown; do
      not build toward it yet.
- [!] **Direct contract intake heterogeneity** — PDFs, spreadsheets,
      emails. Intake tooling budget must not be underestimated.
- [!] **Direct-connect certification tax** — SynXis, RateGain,
      SiteMinder, Mews, Cloudbeds, Channex each carry commercial /
      onboarding / certification overhead beyond adapter code. Plan a
      quarter of calendar time per provider to first-live with one
      hotel (ADR-013).
- [!] **Mapping at scale** — fuzzy matching and human review UI are
      Phase 2+ work; coverage depends on a cross-reference like Giata,
      which is a commercial decision.
- [!] **Supplier rate-limit and sandbox quality** — varies widely; plan
      for per-adapter back-pressure and recorded fixtures for CI.
- [!] **Multi-hotel carts** — deliberately out of MVP (ADR-010). Adding
      later is non-trivial.
- [!] **Payment provider choice** — Stripe confirmed by ADR-012 as the
      rail (via Stripe Connect). Stripe Customer Balance and Stripe
      Treasury explicitly rejected as the wallet.
- [!] **UAE stored-value wallet legal review** — `CASH_WALLET`
      (ADR-012) is paused pending jurisdictional legal clearance.
      `PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD` are
      non-stored-value and lower-risk to launch first.
- [!] **Referral fraud** — anti-fraud is non-optional before launch
      (ADR-014). Budget real operational tooling, not just signals.
- [!] **Rate-intelligence legal/ethics** — public-rate benchmark
      ingestion (scraping or commercial feeds) requires per-tenant,
      per-jurisdiction legal review before enablement (ADR-015).
- [!] **Benchmark source commercial selection** — RateGain DataLabs
      vs OTA Insight vs Lighthouse vs bespoke scraper; Phase 4 decision.
- [!] **Auth provider** — decision deferred to Phase 1 infra selection.
- [!] **`recognized_margin` contract owned by pricing** (ADR-014
      amendment) — rewards consumes it via a narrow read interface.
      Exact inclusion list (especially payment processing cost
      estimation brackets and supplier post-booking rebates) must be
      finalized with finance before Phase 2 build. Without this the
      default `PERCENT_OF_MARGIN` rule cannot be computed
      deterministically.
- [!] **Hotel-funded reward reconciliation** (ADR-014 amendment) —
      `funding_source = HOTEL_FUNDED` implies a receivable-from-hotel
      leg that must clear at supplier invoicing. Hand-off design is
      Phase 3; do not ship `HOTEL_FUNDED` before that clears.
- [!] **Tax engine ADR outstanding** (ADR-016 / ADR-017) — UAE VAT
      minimal implementation inline for Phase 2 Beyond Borders
      direct flow is acceptable; full tax engine with UAE + KSA
      (ZATCA) profiles and place-of-supply / reverse-charge logic
      must land before reseller onboarding opens in Phase 3.
- [!] **Legal tax-doc sequence contention at scale** (ADR-016) —
      gapless sequential counters serialize under load. Phase 2
      is fine; revisit at Phase 5+ if booking rate stresses the
      single-sequence lock.
- [!] **Reseller onboarding tooling** (ADR-017) — branding upload
      moderation, KYC for reseller `TaxProfile.registrations`,
      DKIM / custom sending domain per reseller. Phase 3 back-office
      scope; MVP reseller admin is platform-admin-operated.
- [!] **Reseller DKIM and sending-domain policy** (ADR-017) —
      guest-facing email from a platform address with reseller
      `Reply-To` is acceptable for MVP, but bounces and
      deliverability for reseller-branded mail over a long horizon
      need Phase 4 custom-domain support.
- [!] **Reseller-of-reseller chains** explicitly out of scope
      (ADR-017). Adding later requires an ADR and a commercial
      driver; do not pre-architect.
- [!] **Reseller `PAYOUT_ELIGIBLE` jurisdictional launch review**
      (ADR-018) — operating the payout pipeline in any given country
      may require holding a payment-institution / e-money /
      marketplace-facilitator licence. `PAYOUT_ELIGIBLE` does not
      enable in production for a jurisdiction until legal clearance
      is recorded against that tenant + country. Shares the same
      gate as ADR-012 `CASH_WALLET`. MVP launch sequencing:
      `RESELLER_COLLECTS` everywhere, then `CREDIT_ONLY`, then
      `PAYOUT_ELIGIBLE` per-jurisdiction.
- [!] **KYC / KYB provider selection for reseller onboarding**
      (ADR-018) — document capture, sanctions / PEP screening, and
      ongoing monitoring require a provider integration (Sumsub /
      Onfido / Persona / equivalent). Phase 4 commercial decision.
      Without this, `CREDIT_ONLY` and `PAYOUT_ELIGIBLE` cannot
      onboard real resellers.
- [!] **Tax withholding on reseller payouts** (ADR-018) — whether
      we withhold tax at payout in specific jurisdictions (US
      1099-K style reporting, VAT on platform fee, GCC withholding
      edges) is a tax-engine concern. Deferred to the tax-engine
      ADR; must resolve before `PAYOUT_ELIGIBLE` launches in any
      jurisdiction with a withholding obligation.
- [!] **Multi-currency reseller payouts** (ADR-018) — MVP requires
      earning currency and payout currency to match. Cross-currency
      payouts with explicit FX are Phase 4+.
- [!] **Chargeback and dispute operational playbook** (ADR-018) —
      post-payout clawbacks are modelled by `RefundLiabilityRule`
      but require real operational tooling for dispute workflow
      and reseller-facing communication. Phase 4 back-office scope.
- [!] **Card-fee estimation contract with finance** (ADR-020) —
      mode-aware `recognized_margin` requires a deterministic
      platform-card-fee estimate at pricing time (by BIN range,
      card brand, tenant merchant category). Must be agreed with
      finance and pricing before Phase 2, since it feeds the
      default `PERCENT_OF_MARGIN` reward rule and drives the
      `BB_COLLECTS` vs `RESELLER_COLLECTS` margin gap.
- [!] **VCC provider selection** (ADR-020) — `VCC_TO_PROPERTY`
      requires a virtual-card-issuance integration (Stripe Issuing,
      Marqeta, Adyen Issuing, or specialist travel-VCC issuer such
      as Conferma / WEX). Provider choice affects FX handling,
      acceptance at hotels, and chargeback rights on the BB side.
      Phase 3 commercial decision; do not ship `VCC_TO_PROPERTY`
      before it resolves.
- [!] **Commission recognition timing policy** (ADR-020) — whether
      `SUPPLIER_COMMISSION_ACCRUAL` posts on `SUPPLIER_BOOKED`,
      on stay, or on cleared supplier payment is a revenue-
      recognition decision. Must be finalized with finance before
      `COMMISSION_ONLY` modes go live in Phase 3. Impacts clawback
      shape, reseller earnings timing on `RESELLER_COLLECTS`, and
      `recognized_margin` availability for reward maturation.
- [!] **`COMMISSION_INVOICE` tax treatment** (ADR-020 + pending
      tax engine ADR) — commission invoices BB raises to a
      supplier or upstream platform are a separate tax
      determination from guest-facing `TAX_INVOICE`s. Place-of-
      supply, reverse-charge, and VAT registration edges (UAE /
      KSA / cross-border) must be covered by the tax-engine ADR
      before Phase 3 launch of `COMMISSION_ONLY` / `PROPERTY_COLLECT`.
- [!] **Upstream-collect webhook handshake design** (ADR-020) —
      `UPSTREAM_PLATFORM_COLLECT` depends on Expedia / Booking.com /
      equivalent confirmation, cancellation, and remittance
      webhooks. Handshake semantics (retries, signature
      verification, idempotency keys, statement reconciliation
      granularity) are per-platform and must be designed in
      Phase 4; do not pre-architect.
- [!] **Legacy `booking_payment_model` retirement** (ADR-020
      supersedes ADR-003's single-enum shape) — any existing
      adapter metadata, rate rows, or bookings carrying
      `booking_payment_model` need a one-way migration to the
      three-axis triple. Migration and deprecation timing is a
      Phase 1 task; the old field must not linger past Phase 2
      to avoid two sources of truth on payment flow.
