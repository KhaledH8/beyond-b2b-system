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

## Supply (ADR-003, ADR-007)

- `Supplier` — static metadata (internal id, type,
  `source_type = AGGREGATOR | DIRECT`)
- `SupplierConnection` — per-tenant credentials + settings
- `SupplierRate` — ephemeral
- `ConfirmedSupplierRate` — ephemeral, short-expiry
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

- `Booking` — canonical booking record
- `BookingLeg` — per-room or per-night as needed
- `BookingSaga` — durable saga state
- `Guest` — traveler details (PII-sensitive)
- `Voucher` — generated confirmation
- `TenderComposition` — per-booking tender lines (ADR-012)

## Ledger and wallet (ADR-012)

- `WalletAccount` — per (account, balance_type, currency). Types:
  `CASH_WALLET`, `PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD`,
  `AGENCY_CREDIT`, `CORPORATE_CREDIT`
- `LedgerEntry` — append-only double-entry ledger row with `kind`
  (TOPUP | SPEND | REFUND | PROMO_GRANT | PROMO_REVOKE |
  REWARD_ACCRUAL | REWARD_MATURATION | REWARD_CLAWBACK |
  REWARD_REDEMPTION | CREDIT_DRAWDOWN | CREDIT_SETTLEMENT |
  ADJUSTMENT) and `status` (PENDING | POSTED | VOIDED)
- `BalanceSnapshot` — derived/cached view of a wallet account
- `CreditLine` — B2B credit line (limit, exposure, cycle, terms)
- `Invoice` — B2B invoice generated at cycle close
- `PaymentIntent` — mirror of Stripe PaymentIntent with our refs
- `StripeEventMirror` — webhook event log, idempotency-keyed
- `PayoutBatch` — Stripe Connect transfers (Phase 6)

## Rewards and referral (ADR-014)

- `LoyaltyEarnRule` — scoped earn rule (mirrors PricingRule scope
  semantics)
- `RewardPosting` — metadata around a pending/matured reward (wraps
  the underlying LedgerEntry)
- `ReferralCode` — per B2C account
- `ReferralInvite` — state machine (ISSUED | SIGNED_UP | BOOKED |
  PENDING_REVIEW | PENDING_MATURATION | MATURED | CLAWED_BACK |
  FRAUD_BLOCKED | EXPIRED)
- `FraudDecision` — signals, score, decision, reviewer if manual,
  linked to a ReferralInvite
- `TenderPolicy` — per-tenant rules: caps, stacking, min thresholds

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
| `pay_` | payments | `pay_intent`, `pay_stripe_event`, `pay_credit_line`, `pay_invoice`, `pay_payout_batch` |
| `reward_` | rewards | `reward_earn_rule`, `reward_posting`, `reward_referral_code`, `reward_referral_invite`, `reward_fraud_decision`, `reward_tender_policy` |
| `benchmark_` | rate-intelligence | `benchmark_source`, `benchmark_snapshot`, `benchmark_hotel_mapping` |

A module never writes to another module's tables. Reads are allowed
only through well-defined domain interfaces.
