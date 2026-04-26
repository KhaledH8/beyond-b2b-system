# TASKS

Running task list for Beyond Borders. Newest at the top of each section.
Claude must keep this file current at the start and end of every working
session.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

---

## Now (this session)

- [x] **ADR-021 2026-04-22** — rate, offer, restriction, and
      occupancy model. Three layers kept separate: canonical product
      dimensions (`hotel_room_type`, `hotel_rate_plan`,
      `hotel_meal_plan`, `hotel_occupancy_template`,
      `hotel_child_age_band` + four `*_mapping` tables), authored
      rate primitives (`rate_auth_*` — base price, extra-person
      rule, meal supplement, tax/fee components, restriction,
      allotment, cancellation policy), and sourced offer snapshots
      (`offer_sourced_snapshot`, `offer_sourced_component`,
      `offer_sourced_restriction`,
      `offer_sourced_cancellation_policy`). New enums
      `OfferShape ∈ {SOURCED_COMPOSED, AUTHORED_PRIMITIVES,
      HYBRID_AUTHORED_OVERLAY}` and
      `RateBreakdownGranularity ∈ {TOTAL_ONLY, PER_NIGHT_TOTAL,
      PER_NIGHT_COMPONENTS, PER_NIGHT_COMPONENTS_TAX,
      AUTHORED_PRIMITIVES}`. Shared `RestrictionKind` enum across
      authored and sourced shapes. Booking-time snapshots
      (`booking_sourced_offer_snapshot`,
      `booking_authored_rate_snapshot`,
      `booking_cancellation_policy_snapshot`,
      `booking_tax_fee_snapshot`) immutable, written in the
      `CONFIRMED` transaction. Amends ADR-002, ADR-003 (adapter
      declares `offer_shape` + `min_rate_breakdown_granularity` in
      meta; `SupplierRate` carries the shape fields), ADR-004
      (pricing evaluator gains `SOURCED_COMPOSED` and
      `AUTHORED_PRIMITIVES` code paths; pricing trace carries
      shape + granularity), ADR-010 (snapshots written in same
      transaction as `CONFIRMED`), ADR-011 (new `rate_` and
      `offer_` prefixes; `hotel_` / `booking_` extended), ADR-013
      (authored-primitives push writes `rate_auth_*`; composed push
      continues `supply_ingested_rate`).
- [x] Update `docs/data-model/entities.md` — canonical product
      dimensions, sourced-offer snapshot entities, authored-rate
      primitive entities, booking-time snapshot entities; extended
      table-prefix ownership rows.
- [x] Amend `docs/adrs/ADR-011-monorepo-structure.md` — new `rate_`
      and `offer_` prefixes; `hotel_` and `booking_` row extensions;
      infra/migrations layout additions for `rates/` and `offers/`.
- [x] Amend `docs/roadmap.md` — Phase 0 adds ADR-021; Phase 1 ships
      rate-model migrations (canonical dims + mappings + sourced-
      offer snapshot tables) **before** the Hotelbeds adapter;
      Phase 2 adds booking-time snapshot tables (sourced write path
      + empty authored target); Phase 3 adds `rate_auth_*` tables
      and the authored booking-snapshot write path.
- [x] Amend `CLAUDE.md` §9 (compact checklist item 12) and §10
      (two new invariants: authored-vs-sourced shape separation;
      booking-time snapshots immutable, live shape stays on supply
      side).
- [x] **ADR-021 amendment 2026-04-23** — static seasonal contract-
      rate layer + promotion overlay for authored rates. New
      `AuthoringMode ∈ {SEASONAL_CONTRACT, PER_DAY_STREAM}` under
      `OfferShape = AUTHORED_PRIMITIVES`. New entities:
      `rate_contract`, `rate_contract_season`,
      `rate_contract_season_date_band`, `rate_contract_price`,
      `rate_promotion`, `rate_promotion_scope`,
      `rate_promotion_rule`. Optional nullable `contract_id?` /
      `season_id?` narrowing columns added (additive) to
      `rate_auth_extra_person_rule`, `rate_auth_meal_supplement`,
      `rate_auth_restriction`, `rate_auth_cancellation_policy`,
      and `contract_id?` on `rate_auth_fee_component`.
      `rate_auth_base_price`, `rate_auth_tax_component`, and
      `rate_auth_allotment` do not take contract columns.
      Promotion behavior: `discount_kind ∈ {PERCENT,
      FIXED_AMOUNT_PER_NIGHT, FIXED_AMOUNT_PER_STAY,
      NTH_NIGHT_FREE}`; `applies_to ∈ {PRE_SUPPLEMENT_BASE,
      POST_SUPPLEMENT_PRE_TAX, POST_TAX}` (default
      `POST_SUPPLEMENT_PRE_TAX`); stay / booking windows;
      priority; stackable with per-pair STACKING rules.
      Restrictions stay separate in `rate_auth_restriction`.
      Copy-season is a transactional service with
      `copied_from_season_id` lineage + `AuditLog SEASON_COPY`
      entry; new season starts in `DRAFT`. Sourced offers
      untouched.
- [x] Update `docs/data-model/entities.md` with seasonal contract
      entities, promotion entities, copy-season workflow note, and
      `BookingAuthoredRateSnapshot` additive fields. Extended
      `rate_` prefix row.
- [x] Amend `docs/adrs/ADR-011-monorepo-structure.md` `rate_`
      prefix row with the seven new tables.
- [x] Amend `docs/roadmap.md` Phase 3 — seasonal contract +
      promotion migrations land before the direct-paper adapter.
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

- [x] Repo scaffolding: `package.json`, `pnpm-workspace.yaml`,
      `turbo.json`, `tsconfig.base.json`, `.prettierrc`,
      `eslint.config.mjs` with `no-restricted-imports` dependency-
      direction enforcement per ADR-011.
- [x] `apps/api` — NestJS shell with `GET /health` endpoint.
- [x] `apps/worker` — NestJS application-context shell; BullMQ
      processors register here in Phase 1.
- [x] `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` — Next.js 15
      App Router shells with placeholder pages and correct
      `tsconfig.json` (ESNext + Bundler resolution).
- [x] `packages/domain` — zero-dependency core types: `Money`,
      `TenantContext`, `CanonicalHotel`, `Account`, `Tenant`,
      three-axis ADR-020 enums (`CollectionMode`,
      `SupplierSettlementMode`, `PaymentCostModel`),
      `MoneyMovementTriple`, `Booking`, `PricingTrace`.
- [x] `packages/supplier-contract` — full `SupplierAdapter` interface
      per ADR-003 + ADR-013 (`IngestionMode`, `ARI_PUSH` capability)
      + ADR-020 (`grossCurrencySemantics`, `commissionParams`,
      three-axis triple on `AdapterSupplierRate`).
- [x] `packages/ledger` — `LedgerEntry`, `WalletAccount`,
      `LedgerEntryKind` (all ADR-012/018/020 kinds), `LedgerPort`.
- [x] `packages/payments` — `PaymentPort` interface (Stripe rail,
      no implementation). ADR-020 no-PaymentIntent guard documented
      in JSDoc.
- [x] `packages/rewards` — `EarnRule`, `RewardPosting`,
      `RewardCampaign`, `FundingSource`, `ReferralInvite`,
      `FraudDecision` (ADR-014 amendment).
- [x] `packages/documents` — `BookingDocument`,
      `DocumentNumberSequence`, `LegalEntity`, `DeliveryAttempt`,
      `COMMISSION_INVOICE` type (ADR-016/020).
- [x] `packages/reseller` — `ResellerProfile`, `BillingProfile`,
      `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`,
      `GuestPriceDisplayPolicy`, `ResellerKycProfile`,
      `PayoutAccount` (ADR-017/018).
- [x] `packages/rate-intelligence` — `BenchmarkReadPort`,
      `BenchmarkSnapshot` (read-only advisory, ADR-015).
- [x] `packages/ui` — placeholder (Phase 1: shadcn/ui).
- [x] `packages/config` — `AppConfig` + `loadConfig()`.
- [x] `packages/testing` — `TEST_TENANT_CONTEXT`, `money()` helper,
      adapter conformance suite placeholder.
- [x] `infra/docker/docker-compose.yml` — Postgres+PostGIS 16,
      Redis 7, MinIO (S3-compatible object storage).
- [x] `infra/migrations/{ledger,payments,rewards,rate-intelligence,
      direct-connect,documents,reseller}/` — empty directories for
      future migrations.
- [x] `.env.example` — local dev environment variable template.
- [x] `README.md` updated — Getting Started, infra URLs, command
      reference, full repo layout.

## Next (Phase 1 — first implementation tasks)

- [x] CI baseline: `.github/workflows/ci.yml` — Node 24, pnpm 10,
      single job: install → build → typecheck → lint → test.
      Root `vitest.config.ts` with `passWithNoTests: true` covers
      all packages; root `"test": "vitest run"` for Phase 0
      (switch back to `turbo run test` in Phase 1 when real tests exist).
- [x] Database tooling baseline — `packages/db` (pg.Pool factory),
      Knex migration runner (`infra/knexfile.ts` + custom
      `ModuleMigrationSource` across module subdirs), `pnpm db:migrate`
      / `pnpm db:rollback` scripts, `DatabaseModule` wired into
      `apps/api`. Migration files:
        `core/20260422000001_core_baseline.ts`   → core_tenant, core_account
        `supply/20260422000002_supply_baseline.ts` → supply_supplier (FK dep)
        `hotel/20260422000003_hotel_baseline.ts`  → hotel_canonical,
          hotel_supplier, hotel_mapping (PostGIS GIST indexes)
        `booking/20260422000004_booking_shell.ts` → booking_booking
          (ADR-020 triple immutable at confirmation)
- [ ] OpenTelemetry wiring — Pino logger + OTel trace/metric
      providers in `apps/api` and `apps/worker`.
- [x] **Rate-model Phase 1 migrations (ADR-021) — unblocks Hotelbeds
      adapter.** Files:
        `rates/20260423000005_rates_canonical_product_dimensions.ts` →
          `hotel_room_type`, `hotel_rate_plan`, `hotel_meal_plan`
          (canonical_hotel_id nullable for platform-global RO/BB/HB/FB/AI
          with partial unique indexes), `hotel_occupancy_template`
          (global + rate-plan-narrowed partial uniques),
          `hotel_child_age_band`
        `rates/20260423000006_rates_product_dimension_mappings.ts` →
          `hotel_room_mapping`, `hotel_rate_plan_mapping`,
          `hotel_meal_plan_mapping` (supplier-global, no
          supplier_hotel_id), `hotel_occupancy_mapping`
          (COALESCE partial unique handles nullable occupancy code).
          All mappings follow the ADR-008 convention: partial unique
          excluding `REJECTED | SUPERSEDED`, `superseded_by_id` chain,
          `mapping_method ∈ {DETERMINISTIC, FUZZY, MANUAL}`,
          `status ∈ {PENDING, CONFIRMED, REJECTED, SUPERSEDED}`.
        `offers/20260423000007_offers_sourced_offer_snapshots.ts` →
          `offer_sourced_snapshot` (TTL index on `valid_until`,
          `rate_breakdown_granularity` constrained to the four
          sourced values; `AUTHORED_PRIMITIVES` rejected at this
          layer), `offer_sourced_component` (ON DELETE CASCADE),
          `offer_sourced_restriction` (ON DELETE CASCADE),
          `offer_sourced_cancellation_policy` (1:1 with snapshot,
          `parsed_with` preserves parser id+version for future
          re-parsing).
      No `rate_auth_*` tables yet (Phase 3). No booking-time
      snapshot tables yet (Phase 2).
- [~] **Hotelbeds adapter scaffold** — `packages/adapters/hotelbeds/`
      implementing `SupplierAdapter`. Phase 1 scaffold landed; live
      HTTP client, booking confirmation, and cancellation are
      explicitly out of scope here and land in Phase 2.
        - `HOTELBEDS_META` declares `offerShape = SOURCED_COMPOSED`,
          `minRateBreakdownGranularity = TOTAL_ONLY`,
          `ingestionMode = PULL`. Supported money-movement axes
          declared at the meta level; the per-rate triple is
          resolved at normalization time (see correction below).
        - **Correction (2026-04-23): money-movement resolver.**
          The scaffold originally hardcoded `BB_COLLECTS +
          PREPAID_BALANCE + PLATFORM_CARD_FEE` as a universal
          per-rate triple — anti-pattern against ADR-020 (triple is
          per-rate, not per-supplier). Removed and replaced with:
            - Additive contract field `AdapterSupplierRate.moneyMovementProvenance`
              in `@bb/supplier-contract`: `'PAYLOAD_DERIVED' | 'CONFIG_RESOLVED' | 'PROVISIONAL'`.
            - New `packages/adapters/hotelbeds/src/money-movement.ts`:
              `HotelbedsMoneyMovementResolver` interface +
              `createProvisionalResolver`, `createStaticResolver`,
              `createPayloadFirstResolver` factories.
            - `runSourcedSearchAndPersist` now requires a
              `moneyMovementResolver` in its deps and calls it
              per rate; `HotelbedsAdapterDeps` forces composition
              root to inject one (no silent default).
            - PROVISIONAL results ship a fallback triple so the
              required `moneyMovement` field is populated, but
              `moneyMovementProvenance = 'PROVISIONAL'` is the
              loud signal that downstream booking must refuse.
          Phase 2 work: decide which payload signal (if any)
          Hotelbeds actually exposes from live fixtures and wire
          `createPayloadFirstResolver` accordingly; until then
          composition root uses `createProvisionalResolver`.
        - Additive contract changes: `OfferShape` +
          `RateBreakdownGranularity` added to `@bb/domain`;
          `StaticAdapterMeta` + `AdapterSupplierRate` carry the two
          shape fields (ADR-021 amendment to ADR-003).
        - `pnpm-workspace.yaml` gains `packages/adapters/*`.
        - ESLint dep-direction rule restricts the adapter to
          `@bb/domain` + `@bb/supplier-contract` only (ADR-011).
        - Ports (local to the adapter, DB-free): `SupplierRegistrationPort`,
          `RawPayloadStoragePort`, `HotelContentPersistencePort`,
          `MappingPersistencePort`, `SourcedOfferPersistencePort`.
          Concrete impls wire in the composition root next.
        - `runHotelContentSync` — paged pull from Hotelbeds Content
          API, writes raw payload + `hotel_supplier` rows.
        - `runSourcedSearchAndPersist` — per availability response:
          raw payload → `offer_sourced_snapshot` (+ components,
          restrictions, cancellation policy only when disclosed) →
          PENDING rows in the four `hotel_*_mapping` tables → flat
          `AdapterSupplierRate[]` projection. Components/restrictions
          are NOT fabricated (ADR-021 invariant).
        - `createStubHotelbedsClient` — every method throws
          `HotelbedsNotImplementedError` until Phase 2 credentials
          and signing land.
        - `HotelbedsAdapter.book` / `.cancel` throw
          `HotelbedsNotImplementedError` (out of scope).
        - `tsc --noEmit` and `eslint` clean across all 25 workspace
          packages; `pnpm build` clean across 18.
- [~] **Hotelbeds adapter composition-root wiring** — concrete DB-
      backed persistence ports + MinIO raw payload storage + adapter
      registry + booking guard, all under `apps/api`. Phase 1 wiring
      landed; live HTTP client, booking confirmation, and cancellation
      are still Phase 2.
        - New deps: `@aws-sdk/client-s3` on `apps/api`;
          `@bb/adapter-hotelbeds` + `@bb/supplier-contract`
          workspace refs on `apps/api`.
        - `packages/config` extended with MinIO access/secret keys,
          region, and `forcePathStyle` (defaults are dev-compose
          values — `bb_local`/`bb_local_secret`, `us-east-1`, path-
          style on).
        - `apps/api/src/common/ulid.ts` — 26-char ULID generator
          (crypto.randomBytes + Crockford base32, no third-party dep).
        - `apps/api/src/object-storage/object-storage.module.ts` —
          global `S3Client` + bucket providers against MinIO.
        - Five concrete Hotelbeds ports under
          `apps/api/src/adapters/hotelbeds/`:
            - `PgSupplierRegistrationPort` — upserts `supply_supplier`
              (`source_type = 'AGGREGATOR'`) on `(code)`.
            - `PgHotelContentPersistencePort` — upserts
              `hotel_supplier` rows in a single transaction; writes
              the per-hotel raw-payload ref into `raw_content`.
            - `PgMappingPersistencePort` — four tables, all inserts
              `status = 'PENDING', mapping_method = 'DETERMINISTIC'`.
              Room / rate-plan / occupancy mapping inserts resolve
              `hotel_supplier.id` via `INSERT ... SELECT`, so a
              mapping observed for a hotel not yet content-synced is
              a safe no-op instead of an FK failure.
              `ON CONFLICT` targets the partial unique indexes
              (including the occupancy table's `COALESCE(code, '')`
              expression index).
            - `PgSourcedOfferPersistencePort` — writes
              `offer_sourced_snapshot` + 0..N components + 0..N
              restrictions + 0..1 cancellation policy in a single
              transaction. Child rows only written when non-empty
              (ADR-021 invariant: no fabrication).
            - `MinioRawPayloadStoragePort` — content-addressed put:
              key = `hotelbeds/<purpose>/<YYYY/MM/DD>/<sha256>`.
              Hash doubles as filename — idempotent overwrites.
        - `HotelbedsModule` constructs the adapter with
          `createProvisionalResolver({ fallbackTriple, reason })`
          where `reason` spells out "Hotelbeds commercial
          confirmation pending"; every projected rate thus carries
          `moneyMovementProvenance = 'PROVISIONAL'`. `OnModuleInit`
          runs `ensureRegistered()` so the `supply_supplier` row
          exists before any FK-dependent write.
        - `SupplierAdapterRegistry` + `AdaptersModule` — supplier-
          code → `SupplierAdapter` lookup; adding the second
          adapter is a one-import change.
        - `apps/api/src/booking/booking-guard.ts` — `assertRateBookable(rate)`
          throws `ProvisionalMoneyMovementError` when
          `moneyMovementProvenance === 'PROVISIONAL'`. Call site is
          the first step of the booking saga (Phase 2).
        - `pnpm lint`, `pnpm typecheck`, `pnpm build` clean across
          the full workspace (25 / 25 / 18).
- [x] **Hotelbeds fixture-replay conformance path** —
      `createFixtureHotelbedsClient` in `@bb/testing` implements
      `HotelbedsClient` against two recorded JSON payloads
      (`packages/testing/src/hotelbeds/fixtures/hotels-page-01.json`,
      `availability-01.json`; two hotels, one room, one NRF + one
      FLEX rate) with deterministic raw bytes for content-addressed
      MinIO writes. Conformance test under
      `apps/api/src/adapters/hotelbeds/__tests__/hotelbeds.conformance.test.ts`
      drives `runHotelContentSync` + `runSourcedSearchAndPersist`
      against the live local stack (Postgres + MinIO) and asserts:
        - `supply_supplier` row present (`hotelbeds`, AGGREGATOR).
        - `hotel_supplier` rows for both fixture hotels.
        - `offer_sourced_snapshot` rows (one per rate) with
          `rate_breakdown_granularity = TOTAL_ONLY`, currency EUR,
          raw_payload_hash matching sha256, storage_ref under
          `hotelbeds/availability/`.
        - `offer_sourced_cancellation_policy` written only for the
          rate that actually disclosed one (ADR-021 no-fabrication
          invariant visible in assertions).
        - One `hotel_room_mapping`, two `hotel_rate_plan_mapping`
          (FLEX + NRF), two `hotel_meal_plan_mapping` (BB + RO),
          one `hotel_occupancy_mapping` row observed.
        - Raw payload roundtrips from MinIO via
          `GetObjectCommand` at the snapshot's `storage_ref`.
        - No `rate_auth_*` tables present in this phase
          (invariant: sourced writes never touch authored tables).
        - Every projected `AdapterSupplierRate` carries
          `moneyMovementProvenance = 'PROVISIONAL'` and
          `assertRateBookable(rate)` throws
          `ProvisionalMoneyMovementError`.
      Test skips cleanly when `DATABASE_URL` is absent so CI
      without a local stack is not broken. `pnpm typecheck`,
      `pnpm lint`, and `pnpm test` green.
- [x] **Hotelbeds adapter live HTTP client (Phase 2)** — real
      HTTP transport with signing, retry/backoff, timeout, and
      capture, plus runtime client-kind switch at the composition
      root. Booking confirmation, cancellation, and the
      worker-side content-sync cron are explicitly still out of
      scope and remain Phase 2+/Phase 3 follow-ups.
        - `packages/adapters/hotelbeds/src/live-client.ts` —
          `createLiveHotelbedsClient(config)`. Auth per
          developer.hotelbeds.com `/getting-started`:
          `Api-key: <apiKey>` + `X-Signature:
          SHA256_hex(apiKey + secret + epochSeconds)` recomputed per
          request. `Accept: application/json`,
          `Accept-Encoding: gzip`. Endpoints:
          `GET /hotel-content-api/1.0/hotels?fields=all&from&to&language&useSecondaryLanguage=false`
          and `POST /hotel-api/1.0/hotels`.
        - Retry policy: 429 / 500 / 502 / 503 / 504, AbortError
          timeouts, network TypeErrors. Honors `Retry-After`
          (seconds or HTTP-date). Default 3 retries with
          exponential backoff + jitter from a 200ms base.
        - Per-request timeout via `AbortSignal.timeout(...)`;
          default 15s, configurable.
        - Optional capture: when `captureDir` is set, every
          successful raw response is also written to
          `<captureDir>/<purpose>/<iso>-<sha256>.json`. Capture
          failures never fail a real request — observability only.
          Files can be promoted into
          `packages/testing/src/hotelbeds/fixtures/` to extend the
          regression suite verbatim.
        - Response normalization: live shape → adapter contract.
          Content `name` accepts both `string` and `{content}`;
          availability response unwraps `hotels.hotels` to match
          `HotelbedsAvailabilityResponse.hotels`. Hotel `code` is
          coerced to string at the boundary so downstream typing
          stays clean.
        - Typed `HotelbedsHttpError` carries `status`,
          `headers`, `bodyPreview`, `requestedUrl` so retry logic
          can branch and ops can debug.
        - `packages/adapters/hotelbeds/src/fixture-client.ts` —
          canonical `createFixtureHotelbedsClient` moved from
          `@bb/testing` so the composition root can pick the
          fixture kind without a runtime testing-package
          dependency. `@bb/testing` now thin-re-exports.
        - `apps/api/src/adapters/hotelbeds/hotelbeds.config.ts` —
          adapter-local env binding (`HOTELBEDS_CLIENT_KIND` ∈
          `stub | fixture | live`, plus `HOTELBEDS_API_KEY`,
          `HOTELBEDS_API_SECRET`, `HOTELBEDS_BASE_URL`,
          `HOTELBEDS_REQUEST_TIMEOUT_MS`,
          `HOTELBEDS_MAX_RETRIES`,
          `HOTELBEDS_RETRY_BASE_DELAY_MS`,
          `HOTELBEDS_CAPTURE_DIR`,
          `HOTELBEDS_FIXTURE_DIR`). Default kind is `stub` so a
          fresh checkout boots without credentials. `live` kind
          requires API key + secret; `fixture` kind requires a
          fixture dir. Validation runs at module init so
          misconfiguration fails loudly.
        - `HotelbedsModule` switches client by `cfg.kind` and
          keeps `createProvisionalResolver` on every kind: the
          booking guard refuses every rate from every client
          until ops swaps the money-movement resolver. This is
          deliberate — Phase 2 unlocks HTTP, not bookings.
        - `packages/adapters/hotelbeds/src/live-client.test.ts` —
          5 unit tests pin the load-bearing primitives without
          hitting the network: signing matches the SHA256 vector;
          `Api-key` + `X-Signature` ride every request; 503
          retries to eventual 200; 401 is non-retryable;
          availability shape normalization unwraps
          `hotels.hotels`. Conformance test (fixture replay
          against the real DB + MinIO stack) continues to gate
          adapter behavior end to end.
        - `vitest.config.ts` — `include` glob extended to
          `packages/*/*/src/**/*.{test,spec}.ts` so adapter
          packages (one extra directory level) are discovered.
        - `.env.example` — new Hotelbeds section with all
          adapter env vars and inline guidance.
        - `pnpm typecheck` (27/27), `pnpm lint` (26/26),
          `pnpm test` (9/9 across 2 files) green.
- [ ] Adapter conformance suite — formalize ADR-003 conformance
      harness in `packages/testing/` (applies to every adapter;
      Hotelbeds fixture-replay is the first implementation).
- [ ] Hotel mapping pipeline — deterministic match phase
      (`packages/mapping/`).
- [ ] Supplier content merge — static pipeline into
      `CanonicalHotel` (`packages/content/`).
- [ ] Basic pricing evaluator — `PERCENT_MARKUP` rule, trace output
      (`packages/pricing/`).
- [x] **Internal Hotelbeds API seam** — minimal, dev-oriented HTTP
      surface for triggering the adapter end-to-end:
        - `POST /internal/suppliers/hotelbeds/content-sync` →
          runs `runHotelContentSync` through `HotelbedsContentSyncService`
          (a thin DI wrapper that injects `HOTELBEDS_CLIENT`,
          `PgHotelContentPersistencePort`, `MinioRawPayloadStoragePort`).
          Body: `{ tenantId, pageSize?, maxPages? }`. Response carries
          `{ supplier, clientKind, tenantId, pagesFetched, hotelsUpserted }`.
        - `POST /internal/suppliers/hotelbeds/search` →
          calls `SupplierAdapterRegistry.get('hotelbeds').fetchRates(...)`
          which runs the full sourced-search write path. Body:
          `{ tenantId, supplierHotelId, checkIn, checkOut,
          occupancy:{ adults, children, childAges? }, currency? }`.
          Response carries `{ supplier, clientKind, tenantId,
          rateCount, rates: [...] }`. Each rate projection includes
          `moneyMovementProvenance` and an honest `isBookable: false`
          + `bookingRefusalReason` from the booking guard, so the
          PROVISIONAL safeguard is never quietly hidden by the seam.
        - `apps/api/src/adapters/hotelbeds/hotelbeds.module.tokens.ts` —
          extracted `HOTELBEDS_ADAPTER` and added `HOTELBEDS_CLIENT`
          tokens so adapter-internal services can share the same
          runtime-selected client without depending on the module.
        - `HOTELBEDS_CLIENT` is now a dedicated provider keyed by
          `pickClient(loadHotelbedsConfig())`. The adapter factory
          and `HotelbedsContentSyncService` both inject it; the
          `stub | fixture | live` switch lives in exactly one place.
        - Controller is mounted on `AdaptersModule` (alongside the
          `SupplierAdapterRegistry`); `HotelbedsModule` exports
          `HOTELBEDS_ADAPTER`, `HOTELBEDS_CLIENT`,
          `HotelbedsContentSyncService` for downstream consumers.
        - `apps/api/src/adapters/hotelbeds/__tests__/hotelbeds.controller.test.ts` —
          integration test boots a real Nest app via
          `Test.createTestingModule`, forces `HOTELBEDS_CLIENT_KIND=fixture`
          + `HOTELBEDS_FIXTURE_DIR` to the in-repo fixtures, drives both
          endpoints over HTTP, asserts response shape +
          `clientKind=fixture` + `isBookable=false` + 400 on bad bodies.
          Skips cleanly when `DATABASE_URL` is absent.
        - Hand-rolled body validators (no class-validator dep added)
          throw `BadRequestException` from @nestjs/common on missing
          / malformed fields. Endpoints reject bodies before any
          adapter call.
        - Constructor injection in module / service / controller
          uses explicit `@Inject(ClassRef)` so vitest's esbuild
          transpiler (which does not implement
          `emitDecoratorMetadata`) does not break Nest DI in tests.
          Production tsc emits the metadata anyway — `@Inject` is
          additive, not load-bearing in prod.
        - `pnpm typecheck` (27/27), `pnpm lint` (26/26),
          `pnpm test` (12/12 across 3 files) green.
- [x] **Channel-aware search + first-slice pricing** — normalized
      search seam above sourced offers (`offer_sourced_snapshot`)
      that drives the four commercial channels (B2C / AGENCY /
      SUBSCRIBER / CORPORATE) through one contract.
        - Migrations:
            - `infra/migrations/pricing/20260427000001_pricing_markup_rule.ts`
              — three precedence scopes (ACCOUNT / HOTEL / CHANNEL)
              with a CHECK enforcing exactly one scope key per row.
              Time-bound (`valid_from`, `valid_to`); status-gated;
              partial indexes for the four hot lookup paths and for
              the TTL sweeper.
            - `infra/migrations/merchandising/20260427000002_merchandising_promotion.ts`
              — `PROMOTED | RECOMMENDED | FEATURED` tags scoped to a
              `supplier_hotel_id`, optional `account_type` channel
              filter, identical time-bound + status pattern.
        - Domain types (`packages/domain/src/pricing.ts`):
            - `MarkupRuleScope`, `MarkupRuleSnapshot` (operational
              shape the evaluator sees), `AccountContext`,
              `PriceQuote`, `AppliedMarkup`.
            - Search contract: `SearchRequest`, `SearchResponse`,
              `SearchResultHotel`, `SearchResultRate`, `PromotionTag`,
              `SearchOccupancy`, `SearchResponseMeta`.
        - `packages/pricing` — new package, pure (no DB):
            - `money.ts` — BigInt minor-unit helpers + percent markup
              with half-away-from-zero rounding; rejects malformed
              decimal strings.
            - `evaluator.ts` — `evaluateSourcedOffer(offer, rules, ctx)`:
              precedence ACCOUNT > HOTEL > CHANNEL, priority breaks
              ties within scope, deterministic id tie-break. Returns
              `EvaluatedOffer` (price quote + trace). Unknown
              `markupKind` values are skipped — adding a kind is
              additive.
            - `evaluator.test.ts` — 10 unit tests cover money
              round-trip, sub-percent precision, scope precedence,
              priority tie-break, multi-tenant isolation, unknown-
              kind fallthrough.
            - ESLint rule: `@bb/pricing` may depend on `@bb/domain`
              only (and later `@bb/rate-intelligence`). `@bb/pricing`
              is added to `BACKEND_INTERNAL` so frontend apps never
              import it.
        - `apps/api/src/search/` — channel-aware search module:
            - Four Pg repositories: `PgAccountRepository`,
              `PgHotelSupplierRepository`, `PgMarkupRuleRepository`,
              `PgPromotionRepository`. Repositories load only the
              candidate set for one request; precedence picking
              stays in the pure evaluator (single source of truth).
            - `SearchService` orchestrates: account → adapter
              fetchRates (per supplier hotel) → code→hotel_supplier
              translation → rule + promotion fetch in parallel →
              evaluator → group by hotel → sort by cheapest selling
              price ascending. Promotion tag attaches to the result
              but never reorders past price ascending (CLAUDE.md
              merchandising-doesn't-mutate-price invariant).
            - `SearchController` — `POST /search`, hand-rolled body
              validator, 400 on malformed input. The booking guard
              still runs per rate so PROVISIONAL is surfaced as
              `isBookable: false` + `bookingRefusalReason` —
              consumers can render prices but cannot mistake them
              for sellable inventory.
            - `SearchModule` registered in `app.module.ts`. Imports
              `AdaptersModule` and `DatabaseModule`; explicitly does
              not import object-storage / payments / booking modules.
        - Integration test: `apps/api/src/search/__tests__/search.controller.test.ts`
          boots Nest in fixture mode, seeds tenant + AGENCY account,
          a CHANNEL 10% rule and a HOTEL 15% rule, plus a PROMOTED
          merchandising tag. Asserts HOTEL precedence wins, sell ==
          net + markup exactly (BigInt minor units), promotion tag
          attached, every rate is `isBookable: false`, trace records
          the rule firing, malformed body → 400.
        - `pnpm typecheck` (29/29), `pnpm lint` (28/28),
          `pnpm test` (24/24 across 5 files) green.
- [ ] Pricing layer follow-ups (sequenced):
        - Multi-supplier search (currently calls Hotelbeds only).
        - Currency conversion step (`CURRENCY_CONVERSION` trace kind
          already in `@bb/domain`; engine wiring lands when the FX
          module exists).
        - Tax / fee composition (ADR-004 step 3).
        - Promotion / discount kind (`PROMOTION_APPLIED` post-markup).
        - `FIXED_MARKUP_ABSOLUTE` and `MARKET_ADJUSTED_MARKUP` rule
          kinds (the second pulls in `@bb/rate-intelligence`).
        - `canonical_hotel_id` scope on rules + promotions once the
          mapping pipeline lands; supplier_hotel_id stays as a
          fallback for unsynced inventory.
        - Auth on `/search` once the auth module ships — for now the
          endpoint is open by design (sequenced behind the contract).
- [ ] Supplier notes: `docs/suppliers/hotelbeds.md`,
      `webbeds.md`, `tbo.md`.
- [ ] Flow docs: `docs/flows/search.md`, `docs/flows/booking.md`.

## Later (Phase 3 — pre-adapter order for direct rates)

These are not active-session tasks. They are recorded here so that
the ordering is explicit and not lost when Phase 3 begins. Full
Phase 3 scope lives in `docs/roadmap.md`.

- [ ] **Seasonal-contract + promotion migrations (ADR-021
      amendment 2026-04-23) — lands before the direct-paper
      adapter implementation in Phase 3.** Migration files under
      `infra/migrations/rates/`:
        `NNNN_rate_contract.ts` → `rate_contract`,
          `rate_contract_season`, `rate_contract_season_date_band`,
          `rate_contract_price`
        `NNNN_rate_promotion.ts` → `rate_promotion`,
          `rate_promotion_scope`, `rate_promotion_rule`
        `NNNN_rate_auth_contract_columns.ts` → additive nullable
          `contract_id?` / `season_id?` on `rate_auth_extra_person_rule`,
          `rate_auth_meal_supplement`, `rate_auth_restriction`,
          `rate_auth_cancellation_policy`; `contract_id?` on
          `rate_auth_fee_component`. No backfill — these tables
          are empty until Phase 3.
      Booking snapshot additive columns (`authoring_mode`,
      `contract_id?`, `season_id?`, `applied_promotions_jsonb`) on
      `booking_authored_rate_snapshot` land in the same batch.
- [ ] Copy-season service (transactional clone;
      `copied_from_season_id` lineage + `AuditLog SEASON_COPY`
      entry; new season starts `DRAFT`). No operator UI yet.
- [ ] Direct-paper adapter implements `SupplierAdapter` with
      `authoring_mode = SEASONAL_CONTRACT`,
      `supports_seasonal_contracts = true`,
      `supports_promotions = true`, `offer_shape =
      AUTHORED_PRIMITIVES`; composes offers at search time from
      `rate_contract_price` + extra-person/meal supplements + tax
      + fee, applies promotions per `applies_to` order, writes
      `booking_authored_rate_snapshot` at `CONFIRMED`.

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
