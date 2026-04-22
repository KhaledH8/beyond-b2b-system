# Canonical Domain Entities

Source of truth for the shape (not exact schema) of domain entities.
Each ADR referenced is the authoritative source; this doc is a
cross-cutting index.

## Tenancy (ADR-006)

- `Tenant`
- `Account` — B2C | AGENCY | SUBSCRIBER | CORPORATE; hierarchical via
  `parent_account_id`
- `User`
- `AccountMembership` — User ↔ Account with role
- `LegalEntity` — per (tenant, jurisdiction) issuing entity for tax
  invoices (ADR-016). Holds tax registration scheme, registration
  number, default currency, structured address.

## Reseller (ADR-017)

Reselling is a **capability** on non-B2C accounts, not a new account
type. AGENCY and SUBSCRIBER (and future classes) opt in via a
`ResellerProfile`.

- `ResellerProfile` — per (tenant, account) reseller enablement.
  Carries `reseller_class` (AGENCY | SUBSCRIBER_GROUP | CORPORATE_TMC
  | OTHER), `onboarding_status`, and pointers to `BillingProfile`,
  `TaxProfile`, `BrandingProfile`, `ResellerResaleRule`,
  `GuestPriceDisplayPolicy`, and optional `CreditLine`.
- `BillingProfile` — versioned billing contact and invoice delivery
  config (email_to, CC, PDF attach, portal/webhook channels).
  Owner is ACCOUNT or LEGAL_ENTITY.
- `TaxProfile` — versioned tax registrations (scheme, number,
  jurisdiction, effective_from/to, evidence doc), tax treatment
  hint, place of business. Feeds the tax engine.
- `BrandingProfile` — versioned logo (object-storage ref, content-
  hashed), display name, primary color, contact block, footer HTML
  (sanitized), locale defaults. Platform default exists for tenant #1.
- `ResellerResaleRule` — versioned guest-facing amount rule. Modes:
  FIXED_GUEST_AMOUNT | FIXED_MARKUP_ABSOLUTE | PERCENT_MARKUP |
  HIDE_PRICE. Carries floor/ceiling/rounding, display_currency,
  fx_strategy.
- `GuestPriceDisplayPolicy` — versioned display toggles
  (show_tax_lines, show_cancellation_policy_snippet, etc.).
  `show_buy_price=true` on a guest doc is rejected at render.
- `ResellerSettlementMode` (enum on `ResellerProfile`, versioned):
  `RESELLER_COLLECTS` (default; reseller bills guest directly) |
  `CREDIT_ONLY` (BB collects guest; reseller earnings are
  non-withdrawable platform credit) | `PAYOUT_ELIGIBLE` (BB
  collects guest; reseller earnings are withdrawable cash, gated).
  See ADR-018.

## Reseller settlement (ADR-018)

Additive to ADR-017. These entities only apply to
`CREDIT_ONLY` and `PAYOUT_ELIGIBLE` resellers; `RESELLER_COLLECTS`
continues to work through ADR-017 + ADR-012 `CreditLine` /
`BillingProfile` only.

- `ResellerKycProfile` — versioned KYB record per (tenant,
  reseller_profile). Fields: `legal_entity_kind` (SOLE_TRADER | LLC |
  CORPORATION | PARTNERSHIP | NON_PROFIT | INDIVIDUAL_NOT_BUSINESS),
  legal entity name, registration number + jurisdiction,
  `beneficial_owners[]`, `directors_or_controllers[]`, business
  address / website / activity code, `aml_risk_rating`,
  `pep_screen_result`, `sanctions_screen_result`, `review_status`
  (NOT_STARTED | IN_REVIEW | APPROVED | REJECTED | SUSPENDED),
  reviewer, `evidence_document_ids[]`. Required for `CREDIT_ONLY`
  and `PAYOUT_ELIGIBLE`. `INDIVIDUAL_NOT_BUSINESS` is never eligible
  for `PAYOUT_ELIGIBLE` in MVP.
- `PayoutAccount` — versioned external payout destination per
  (tenant, reseller_profile). Fields: `rail` (STRIPE_CONNECT |
  BANK_TRANSFER_SWIFT | BANK_TRANSFER_LOCAL | FUTURE_RAIL),
  `rail_external_id` (e.g. Stripe connected-account id), account
  holder name (must match KYC legal entity name), country, currency,
  IBAN / BIC / account number / routing number as applicable,
  `verification_status` (UNVERIFIED | PENDING | VERIFIED | FAILED |
  SUSPENDED), activation / deactivation timestamps. Only relevant
  for `PAYOUT_ELIGIBLE`.
- `PendingEarnings` — derived view, not a table. Projects
  `RESELLER_CASH_EARNINGS` ledger rows with `status=PENDING` and no
  maturation row.
- `AvailableEarnings` — derived view, not a table. Matured accruals
  net of holds and reversals, not in-flight for withdrawal, not
  paid_out.
- `ReserveBalance` — per (tenant, reseller_profile, currency,
  `kind`). Kinds: `ROLLING_PERCENT_RESERVE`, `FIXED_FLOOR_RESERVE`,
  `CHARGEBACK_HISTORY_RESERVE`, `RISK_TIER_RESERVE`,
  `NEW_RESELLER_RAMP_RESERVE`. Multiple rules may stack. `held_minor_units`
  is derived from RESERVE_HOLD − RESERVE_RELEASE ledger rows.
- `WithdrawalRequest` — per withdrawal attempt: currency, requested
  / eligible / fee amounts, `payout_account_id`, `status` (SUBMITTED
  | UNDER_REVIEW | APPROVED | REJECTED | IN_PAYOUT_BATCH | PAID |
  FAILED | CANCELLED), reviewer + decision reason, rail reference,
  linked `PayoutBatch`.
- `PayoutBatch` — one currency, one rail. `items[]` reference
  `WithdrawalRequest`s. Status flow: BUILDING → SUBMITTED →
  (PARTIALLY_PAID |) PAID | FAILED. A one-item batch is still a
  batch; batches are the unit of reconciliation against the rail.
  Extends / subsumes the earlier ADR-012 `PayoutBatch` stub.
- `RefundLiabilityRule` — per (tenant, reseller_profile?) rules for
  ordering of recovery across RESERVED, AVAILABLE, PENDING,
  NEGATIVE_AVAILABLE, EXTERNAL_COLLECTIONS. Controls whether
  `NEGATIVE_AVAILABLE` is allowed (default false for
  `CREDIT_ONLY`), and per-tenant negative-cap and escalation
  thresholds.

Earnings state machine values (**derived from ledger rows**, not a
separate persisted enum): `pending`, `available`, `reserved`,
`paid_out`, `clawed_back`. Transitions are encoded by the
`RESELLER_EARNINGS_*` ledger kinds listed under "Ledger and wallet"
below.

## Documents (ADR-016)

Documents are renderings of ledger + booking facts. Never the source
of truth for money facts.

- `DocumentType` (enum): `TAX_INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE`,
  `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`,
  `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`,
  `COMMISSION_INVOICE` (ADR-020; BB → supplier / upstream platform
  for commission earned under `COMMISSION_ONLY` modes; numbered
  monotonic per (tenant, supplier_id, fiscal_year); distinct from
  legal-tax-doc gapless sequences).
- `DocumentNumberSequence` — one per (document_type, scope). Legal
  tax docs use GAPLESS_SEQUENTIAL per (legal_entity, jurisdiction,
  fiscal_year); reseller docs use MONOTONIC_SEQUENTIAL per (tenant,
  reseller_account); BB commercial docs use MONOTONIC_SEQUENTIAL per
  tenant. Platform booking reference and supplier confirmation number
  are NOT in this table.
- `DocumentTemplate` — versioned per (tenant, reseller_account?,
  document_type, jurisdiction?, locale, channel). Source blob ref,
  engine (HANDLEBARS | MJML), branding_profile_ref, approval audit.
- `BookingDocument` — immutable issued document. Carries number,
  number_sequence_id, template_id+version, recipient, issuing
  legal_entity_id or reseller_account_id, amounts (subtotal, tax
  lines, total), `corrects_document_id?`, `replaces_document_id?`,
  storage_ref, content_hash, issued_at, status (DRAFT | ISSUED |
  SUPERSEDED | VOIDED), delivery attempts.
- `DeliveryAttempt` — per-document delivery log (channel, provider,
  status, provider_message_id). Delivery failure never voids the
  document.
- `DocumentIssuePolicy` — per tenant (and per reseller) config of
  which document types issue for which booking archetypes.

## Identity (ADR-002, ADR-008)

- `CanonicalHotel` — one per real hotel
- `SupplierHotel` — raw per-supplier view
- `HotelMapping` — link with confidence, method, provenance,
  `superseded_by`
- `MappingReviewCase` — ambiguous fuzzy matches for human review

## Content (ADR-005)

- `HotelStaticContent` — versioned contributions
- `HotelImage` — with content hash, moderation status, display rank
- `HotelAmenity` — controlled vocabulary join
- Curator overrides ride as fields on `CanonicalHotel` or a shadow
  table (`CanonicalHotelOverride`) with `curator_user_id`, reason,
  timestamp

## Money-movement axes (ADR-020)

Three orthogonal enums declared per `SupplierRate` and persisted on
every `Booking`:

- `CollectionMode` — who collects the guest's money:
  `BB_COLLECTS | RESELLER_COLLECTS | PROPERTY_COLLECT |
  UPSTREAM_PLATFORM_COLLECT`.
- `SupplierSettlementMode` — how the supplier is paid:
  `PREPAID_BALANCE | POSTPAID_INVOICE | COMMISSION_ONLY |
  VCC_TO_PROPERTY | DIRECT_PROPERTY_CHARGE`.
- `PaymentCostModel` — who bears the acquiring / rail cost:
  `PLATFORM_CARD_FEE | RESELLER_CARD_FEE | PROPERTY_CARD_FEE |
  UPSTREAM_NETTED | BANK_TRANSFER_SETTLEMENT`.

Allowed `(CollectionMode, SupplierSettlementMode)` pairs are a
closed set defined in ADR-020; source selection filters invalid
pairs before pricing. `gross_currency_semantics` (`NET_TO_BB |
GROSS_TO_GUEST | COMMISSION_RATE`) on `SupplierRate` tells pricing
how to derive `net_cost` from the supplier-returned amount.

`recognized_margin` (owned by pricing per ADR-014 amendment
2026-04-22) varies cost inclusion by these axes: `BB_COLLECTS`
includes platform card fee; `RESELLER_COLLECTS` excludes it;
`COMMISSION_ONLY` modes compute margin from the commission stream;
`VCC_TO_PROPERTY` includes the VCC-load fee alongside guest-side
acquiring.

## Supply (ADR-003, ADR-007)

- `Supplier` — static metadata (internal id, type,
  `source_type = AGGREGATOR | DIRECT`)
- `SupplierConnection` — per-tenant credentials + settings
- `SupplierRate` — ephemeral. Carries `CollectionMode`,
  `SupplierSettlementMode`, `PaymentCostModel`, and
  `gross_currency_semantics` (ADR-020); for `COMMISSION_ONLY`
  rates also carries `commission_basis` + `commission_params`.
- `ConfirmedSupplierRate` — ephemeral, short-expiry. Same
  ADR-020 triple as the originating `SupplierRate`.
- `DirectContract`, `DirectContractRate` — internal tables surfaced
  via the direct-contract adapter

## Pricing (ADR-004)

- `PricingRule` — scoped, typed, prioritized
- `PricedOffer` — sellable rate with full trace
- `PricingTrace` — persisted for booked offers; ephemeral for
  search results
- `FxRate` — per-day, per-currency

## Merchandising (ADR-009)

- `MerchandisingCampaign`
- `CampaignPlacement`
- `CampaignTargeting`
- `ResultDisplay` — what the frontend renders (badges, sponsored,
  pinned, rank_reason)

## Booking (ADR-010)

- `Booking` — canonical booking record. Persists the ADR-020
  triple (`CollectionMode`, `SupplierSettlementMode`,
  `PaymentCostModel`) immutably at confirmation so refund /
  dispute / reconciliation decades later see the same semantics.
- `BookingLeg` — per-room or per-night as needed
- `BookingSaga` — durable saga state
- `Guest` — traveler details (PII-sensitive)
- `Voucher` — generated confirmation
- `TenderComposition` — per-booking tender lines (ADR-012)

## Ledger and wallet (ADR-012)

- `WalletAccount` — per (account, balance_type, currency). Types:
  `CASH_WALLET`, `PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD`,
  `AGENCY_CREDIT`, `CORPORATE_CREDIT`, `RESELLER_PLATFORM_CREDIT`
  (ADR-018, `CREDIT_ONLY` mode — non-withdrawable platform credit),
  `RESELLER_CASH_EARNINGS` (ADR-018, `PAYOUT_ELIGIBLE` mode —
  withdrawable cash payable, moves through pending → available →
  reserved → paid_out with clawback).
- `LedgerEntry` — append-only double-entry ledger row with `kind`
  (TOPUP | SPEND | REFUND | PROMO_GRANT | PROMO_REVOKE |
  REWARD_ACCRUAL | REWARD_MATURATION | REWARD_CLAWBACK |
  REWARD_REDEMPTION | CREDIT_DRAWDOWN | CREDIT_SETTLEMENT |
  ADJUSTMENT | RESELLER_EARNINGS_ACCRUAL |
  RESELLER_EARNINGS_MATURATION | RESELLER_EARNINGS_CLAWBACK |
  RESELLER_EARNINGS_RESERVE_HOLD | RESELLER_EARNINGS_RESERVE_RELEASE |
  RESELLER_EARNINGS_WITHDRAWAL_HOLD | RESELLER_EARNINGS_PAID_OUT |
  RESELLER_EARNINGS_WITHDRAWAL_REVERSAL | RESELLER_CREDIT_ACCRUAL |
  RESELLER_CREDIT_REDEMPTION | RESELLER_CREDIT_CLAWBACK |
  RESELLER_CREDIT_EXPIRY | SUPPLIER_PREPAID_TOPUP |
  SUPPLIER_PREPAID_DRAWDOWN | SUPPLIER_POSTPAID_ACCRUAL |
  SUPPLIER_POSTPAID_SETTLEMENT | SUPPLIER_COMMISSION_ACCRUAL |
  SUPPLIER_COMMISSION_RECEIVED | SUPPLIER_COMMISSION_CLAWBACK |
  VCC_LOAD | VCC_SETTLEMENT | VCC_UNUSED_RETURN) and `status`
  (PENDING | POSTED | VOIDED). `RESELLER_*` kinds are ADR-018
  additions; `SUPPLIER_*` and `VCC_*` kinds are ADR-020 additions.
  Every payment-cost-bearing entry carries the resolved
  `PaymentCostModel` (ADR-020). ADR-012 invariants (append-only,
  double-entry, idempotency, single-currency per wallet) apply
  unchanged.
- `BalanceSnapshot` — derived/cached view of a wallet account
- `CreditLine` — B2B credit line (limit, exposure, cycle, terms)
- `Invoice` — B2B invoice generated at cycle close
- `PaymentIntent` — mirror of Stripe PaymentIntent with our refs
- `StripeEventMirror` — webhook event log, idempotency-keyed
- `PayoutBatch` — Stripe Connect transfers. Originally scoped to
  Phase 6 marketplace resale payouts (ADR-012); extended by
  ADR-018 to cover reseller earnings withdrawals driven by
  `WithdrawalRequest`. Rail-agnostic; Stripe Connect is the default
  rail, other bank rails plug in as adapters.
- `reseller_collections_suspense` — internal platform book (ADR-012
  amendment 2026-04-21) holding BB-collected guest payments for
  reseller-channel bookings in `CREDIT_ONLY` / `PAYOUT_ELIGIBLE`
  modes before the double-entry split into revenue, platform fee,
  and reseller earnings accrual.
- `supplier_prepaid_balance_<supplier_id>` — internal platform book
  (ADR-012 amendment 2026-04-21 / ADR-020) per supplier we hold a
  topped-up balance with (TBO-style). Credits from our bank
  transfers to the supplier; debits from booking drawdowns under
  `SupplierSettlementMode = PREPAID_BALANCE`.
- `supplier_postpaid_payable_<supplier_id>` — internal platform book
  per supplier we settle by invoice. Accruals on confirmed bookings
  under `POSTPAID_INVOICE`; clears on cycle-invoice settlement.
- `supplier_commission_receivable_<supplier_id>` — internal platform
  book per supplier that pays us commission under `COMMISSION_ONLY`.
  Accruals on commission recognition (policy-owned, typically
  post-stay); clears on commission receipt. Clawbacks reverse.
- `vcc_issuance_suspense` — internal platform book for virtual-card
  loads issued under `VCC_TO_PROPERTY`. Clears when the property's
  charge settles against the VCC.

## Rewards and referral (ADR-014 + 2026-04-22 amendment)

- `LoyaltyEarnRule` — scoped earn rule (mirrors PricingRule scope
  semantics). Fields: `scope`, `formula`, `formula_params`,
  `funding_source` (`PLATFORM_FUNDED | HOTEL_FUNDED | SHARED_FUNDED`),
  `rewardable_margin_config` (floor, ceiling, fraction),
  `cap_and_floor`, `priority`, `status`. `formula ∈
  {PERCENT_OF_MARGIN *default*, FIXED_REWARD_BY_MARGIN_BRACKET,
  HOTEL_FUNDED_BONUS, MANUAL_OVERRIDE, CAP_AND_FLOOR, PERCENT_OF_NET
  *deprecated-default*, PERCENT_OF_MARKUP, FIXED_PER_NIGHT, TIERED}`.
- `RewardPosting` — metadata around a pending/matured reward. Wraps
  one or more `LedgerEntry` rows on the buyer side plus the
  corresponding `RewardFundingLeg`s. Carries `funding_source`,
  `campaign_id?`, `override_id?`, `recognized_margin`,
  `rewardable_margin`, `formula_applied`, `actor_id?` (for manual
  overrides), `reason_code?`.
- `RewardFundingLeg` — per-funder ledger leg. One per
  `funding_source` slice (single leg for `PLATFORM_FUNDED`, two for
  `SHARED_FUNDED`). Carries `funder` (PLATFORM | HOTEL | SUPPLIER),
  `funder_ref_id`, `amount`, `funding_agreement_ref?`, `approved_by?`,
  `ledger_entry_id`.
- `RewardCampaign` — time-bounded boost. Fields: `scope` (hotel,
  supplier, rate-plan, market, account-segment), `bonus_formula`,
  `funding_source`, `funding_agreement_ref`, `approved_by`,
  `budget_cap?`, `stackable_with[]`, `start_at`, `end_at`, `status`
  (DRAFT | ACTIVE | EXHAUSTED | EXPIRED | CANCELLED).
- `HotelRewardOverride` — persistent per-hotel or per-supplier
  override (distinct from a time-bounded campaign). Carries
  funding-source metadata.
- `RewardOverrideAudit` — append-only log of `MANUAL_OVERRIDE`
  postings: actor, reason code, previous/new state, linked
  `RewardPosting`.
- `ReferralCode` — per B2C account.
- `ReferralInvite` — state machine (ISSUED | SIGNED_UP | BOOKED |
  PENDING_REVIEW | PENDING_MATURATION | MATURED | CLAWED_BACK |
  FRAUD_BLOCKED | EXPIRED).
- `FraudDecision` — signals, score, decision, reviewer if manual,
  linked to a ReferralInvite.
- `TenderPolicy` — per-tenant rules: caps, stacking, min thresholds.

**`recognized_margin` / `rewardable_margin`** are not stored entities;
they are computed values attached to each `RewardPosting` and also
exposed as a read-only view over a booking's `PricingTrace`. The
pricing module owns the computation contract; rewards consumes it
through a narrow typed interface. Definition: ADR-014 amendment
(2026-04-22).

## Rate intelligence (ADR-015)

- `BenchmarkSource` — provider adapter metadata + credentials ref
- `BenchmarkSnapshot` — per (canonical_hotel_id, stay_date, source)
  distribution + sample count + freshness
- `BenchmarkHotelMapping` — provider id → canonical_hotel_id mapping
  (parallel to ADR-008 mapping, separate namespace)

## Direct-connect supply (ADR-013)

- `DirectConnectProperty` — per (tenant, supplier, property code)
  enablement with `onboarding_status`
- `supply_ingested_rate` — push-mode ARI ingestion store with
  freshness windows and supersede chains
- `ChannelManagerConnection` — per (tenant, supplier) credentials,
  push endpoint token, webhook secret

## Cross-cutting

- `AuditLog` — admin actions, curator overrides, mapping decisions,
  campaign changes
- `TenantSetting` — runtime-configurable per tenant
- `FeatureFlag` — rollout control

## Identifier conventions

- All primary keys are opaque (ULIDs or UUIDv7) — never leak a
  supplier id as our primary key.
- All money fields are `(amount_minor_units INT, currency CHAR(3))`
  pairs — no floats.
- All time fields are UTC `timestamptz`; property-local times are
  stored as `(date, local_time, timezone)` triples where needed.
- All soft-deletable rows have `status` enums, not a `deleted_at`
  boolean hack.

## Table ownership and module boundary

Table prefixes communicate which module owns what:

| Prefix | Owner module | Examples |
|---|---|---|
| `core_` | tenancy/domain | `core_tenant`, `core_account`, `core_user` |
| `hotel_` | content/mapping | `hotel_canonical`, `hotel_supplier`, `hotel_mapping`, `hotel_image` |
| `supply_` | supplier | `supply_supplier`, `supply_connection`, `supply_direct_contract`, `supply_ingested_rate`, `supply_direct_connect_property` |
| `pricing_` | pricing | `pricing_rule`, `pricing_fx_rate` |
| `merch_` | merchandising | `merch_campaign`, `merch_placement` |
| `booking_` | booking | `booking_booking`, `booking_saga`, `booking_voucher`, `booking_tender` |
| `ledger_` | ledger | `ledger_entry`, `ledger_wallet_account`, `ledger_balance_snapshot` |
| `pay_` | payments | `pay_intent`, `pay_stripe_event`, `pay_credit_line`, `pay_invoice`, `pay_payout_batch`, `pay_payout_account`, `pay_withdrawal_request`, `pay_reserve_balance`, `pay_refund_liability_rule` |
| `reward_` | rewards | `reward_earn_rule`, `reward_posting`, `reward_funding_leg`, `reward_campaign`, `reward_hotel_override`, `reward_override_audit`, `reward_referral_code`, `reward_referral_invite`, `reward_fraud_decision`, `reward_tender_policy` |
| `benchmark_` | rate-intelligence | `benchmark_source`, `benchmark_snapshot`, `benchmark_hotel_mapping` |
| `reseller_` | reseller (ADR-017, ADR-018) | `reseller_profile`, `reseller_billing_profile`, `reseller_tax_profile`, `reseller_branding_profile`, `reseller_resale_rule`, `reseller_guest_price_display_policy`, `reseller_kyc_profile` |
| `doc_` | documents (ADR-016, ADR-020) | `doc_legal_entity`, `doc_number_sequence`, `doc_template`, `doc_booking_document`, `doc_delivery_attempt`, `doc_issue_policy` |

A module never writes to another module's tables. Reads are allowed
only through well-defined domain interfaces.
