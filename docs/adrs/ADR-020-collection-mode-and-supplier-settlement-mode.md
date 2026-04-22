# ADR-020: Collection mode and supplier settlement mode

- **Status:** Accepted
- **Date:** 2026-04-21
- **Supersedes:** nothing
- **Amends:** ADR-003 (supplier adapter contract — refines the loose
  `booking_payment_model: CHANNEL_COLLECTS | HOTEL_COLLECTS | SPLIT`
  capability added by the 2026-04-21 ADR-013 amendment into three
  independent, first-class axes: `CollectionMode`,
  `SupplierSettlementMode`, `PaymentCostModel`; every rate an adapter
  returns must now carry all three). ADR-004 (pricing — `net_cost`
  semantics vary by `SupplierSettlementMode`; `COMMISSION_ONLY` rates
  price differently from `PREPAID_BALANCE` rates, and this is now
  explicit in the pricing trace rather than hidden in adapter
  behavior). ADR-010 (booking orchestration — payment-related saga
  steps are now conditional on collection mode; `VCC_TO_PROPERTY` adds
  a VCC-load step; `PROPERTY_COLLECT` and `UPSTREAM_PLATFORM_COLLECT`
  skip authorize/capture). ADR-012 (payments — adds supplier-side
  books for prepaid balances, postpaid invoicing, VCC issuance, and
  commission receivables; `bb_platform_fee` recognition becomes
  mode-dependent). ADR-017 (reseller billing — clarifies that
  `RESELLER_COLLECTS` on the reseller axis and `RESELLER_COLLECTS` on
  the collection axis are the same thing under different names; this
  ADR uses the collection-axis name as canonical). ADR-018 (reseller
  settlement — `ResellerSettlementMode` and `CollectionMode` are
  orthogonal axes; this ADR defines their interaction).
- **Depends on:** ADR-003, ADR-004, ADR-010, ADR-012, ADR-017, ADR-018

## Context

The platform must distribute inventory with materially different
money-movement models across its suppliers. Naming a few real-world
patterns the MVP has to accommodate:

- **TBO** — we keep a topped-up balance with TBO; each booking draws
  down that balance. TBO does not collect from the guest; we do.
  Settlement is supplier-side balance arithmetic, reconciled against
  a statement.
- **Hotelbeds "Merchant" rates** — we collect from the guest;
  Hotelbeds invoices us periodically; we pay by bank transfer or a
  deposit-held model.
- **Hotelbeds "Pay at hotel" rates / Expedia Traveler Preference** —
  the guest pays the hotel directly at check-in; we never see the
  cash; the supplier pays us a commission after the stay.
- **Expedia Rapid "Collect" rates** — we collect from the guest, and
  a virtual card (VCC) is issued to the hotel for check-in charging.
- **Booking.com Demand API (if ever commercially enabled)** — BDC
  collects from the guest on its own rails, pays us a commission
  netted on a schedule.
- **Direct contracts we sign with hotels** — typically we collect
  from the guest and bank-transfer the property, or issue a VCC.
- **Subscriber / agency resellers under ADR-018 `CREDIT_ONLY` /
  `PAYOUT_ELIGIBLE`** — we collect from the guest on the reseller's
  behalf; supplier-side settlement is whatever the underlying
  supplier requires, independently.

Prior to this ADR, these differences were described only in prose in
the supplier docs under `docs/suppliers/*` and a single loose
`booking_payment_model: CHANNEL_COLLECTS | HOTEL_COLLECTS | SPLIT`
capability on `StaticAdapterMeta` (ADR-003 + ADR-013 amendment).
That is not enough. Three things are tangled and need to be separated:

1. **Who collects the guest's money** (B2C, reseller, property,
   upstream platform).
2. **How the supplier gets paid** (drawdown, invoice, commission,
   VCC, direct-charge).
3. **Who bears the card-processing / bank-rail cost** (us, the
   reseller, the property, netted by the upstream, or none because
   settlement is bank transfer).

Collapsing these into one dimension produces confused cost
accounting, wrong `recognized_margin` (and therefore wrong reward
accruals per ADR-014), double-counted or missing card fees, invalid
saga paths (e.g. authorizing a Stripe `PaymentIntent` for a
`PROPERTY_COLLECT` rate), and documents that claim we sold a supply
we never actually collected for.

## Decision

### Three orthogonal axes, all first-class

Every bookable rate carries three independent enums. They are
declared by the supplier adapter per rate (not per supplier — a single
supplier can offer multiple modes simultaneously) and persisted on
the `Booking` row so that the decision is durable for the lifetime
of the booking, including refunds and disputes that arrive years
later.

```
CollectionMode enum {
  BB_COLLECTS                 // Beyond Borders collects from the guest
  RESELLER_COLLECTS           // Reseller collects from the guest
  PROPERTY_COLLECT            // Hotel / property collects at check-in
  UPSTREAM_PLATFORM_COLLECT   // Upstream platform (e.g. Booking.com
                              //   Demand API) collects from the guest
}

SupplierSettlementMode enum {
  PREPAID_BALANCE             // We hold a topped-up balance with the
                              //   supplier; bookings draw down
  POSTPAID_INVOICE            // Supplier invoices us periodically;
                              //   we settle by bank transfer / card
  COMMISSION_ONLY             // We never remit a gross amount; the
                              //   supplier (or the upstream platform)
                              //   pays us commission after stay
  VCC_TO_PROPERTY             // A virtual card is issued to the
                              //   property; the property charges the
                              //   VCC; we (or the supplier) are the
                              //   VCC issuer / funding source
  DIRECT_PROPERTY_CHARGE      // Guest's own card is charged directly
                              //   by the property at check-in; no
                              //   intermediary holds guest money
}

PaymentCostModel enum {
  PLATFORM_CARD_FEE           // BB absorbs the acquiring fee
  RESELLER_CARD_FEE           // Reseller absorbs the acquiring fee
  PROPERTY_CARD_FEE           // The property absorbs the card fee
                              //   at check-in
  UPSTREAM_NETTED             // Upstream platform nets its own
                              //   processing costs against the
                              //   commission it remits to us
  BANK_TRANSFER_SETTLEMENT    // Settlement rail is bank transfer;
                              //   no card acquiring fee (may still
                              //   have FX / transfer fees)
}
```

These are **inputs to pricing and booking**, not outputs. Pricing
does not choose a `CollectionMode`; the adapter tells pricing what
the rate supports, and pricing respects it.

### Which combinations are allowed

Not every `(CollectionMode, SupplierSettlementMode)` pair is
coherent. Invalid combinations are rejected at adapter conformance
test time and again at pricing time:

| Collection ↓ / Settlement → | PREPAID_BALANCE | POSTPAID_INVOICE | COMMISSION_ONLY | VCC_TO_PROPERTY | DIRECT_PROPERTY_CHARGE |
|---|---|---|---|---|---|
| **BB_COLLECTS**             | ✅ (TBO)                    | ✅ (Hotelbeds merchant)    | ❌ forbidden               | ✅ (Expedia Rapid Collect) | ❌ forbidden |
| **RESELLER_COLLECTS**       | ✅ (reseller-channel / TBO) | ✅ (reseller-channel / HB) | ❌ forbidden               | ✅ (reseller + VCC)        | ❌ forbidden |
| **PROPERTY_COLLECT**        | ❌ forbidden                | ❌ forbidden               | ✅ (pay-at-hotel + comm.) | ❌ forbidden               | ✅ (pay-at-hotel, no commission on our side) |
| **UPSTREAM_PLATFORM_COLLECT** | ❌ forbidden              | ❌ forbidden               | ✅ (BDC Demand API)        | ❌ forbidden               | ❌ forbidden |

Rationale for the ❌s:

- `BB_COLLECTS + COMMISSION_ONLY` is incoherent: if we collect the
  gross from the guest, the supplier is not paying us a commission;
  we pay them a net. Any "commission-looking" differential here is
  just our margin on a merchant-of-record sale.
- `BB_COLLECTS + DIRECT_PROPERTY_CHARGE` is incoherent: "we collect"
  and "the property charges the guest's card" describe the same
  cash flow going to two places.
- `PROPERTY_COLLECT + PREPAID_BALANCE` / `POSTPAID_INVOICE` would
  mean the hotel collects the guest's money **and** we also pay
  the supplier — a duplicate payment.
- `PROPERTY_COLLECT + VCC_TO_PROPERTY` — if the property is
  collecting from the guest, no VCC is needed.
- `UPSTREAM_PLATFORM_COLLECT + PREPAID_BALANCE / POSTPAID_INVOICE` —
  the upstream platform already holds the guest's money; us paying
  a gross amount to the supplier on top would double-pay.
- `UPSTREAM_PLATFORM_COLLECT + VCC_TO_PROPERTY` — the platform
  handles the property-side settlement as part of its commission
  model; we do not issue VCCs.

`RESELLER_COLLECTS` inherits whatever supplier-side mode the
underlying supplier requires. The reseller's choice to collect from
their guest does not change the property / supplier settlement. In
this ADR, `RESELLER_COLLECTS` on the `CollectionMode` axis is the
**canonical name** for what ADR-017 calls the
`RESELLER_COLLECTS` settlement mode of `ResellerProfile`; ADR-018's
`ResellerSettlementMode` axis is orthogonal to this one and
describes reseller-side treatment only.

### Allowed `PaymentCostModel` pairings

`PaymentCostModel` is determined by `CollectionMode` and the
settlement rail, not chosen freely:

| CollectionMode           | Typical PaymentCostModel         | Also possible |
|---|---|---|
| `BB_COLLECTS`            | `PLATFORM_CARD_FEE`              | `BANK_TRANSFER_SETTLEMENT` (top-up from B2B wallet / invoice pay) |
| `RESELLER_COLLECTS`      | `RESELLER_CARD_FEE`              | `BANK_TRANSFER_SETTLEMENT` on the reseller's side |
| `PROPERTY_COLLECT`       | `PROPERTY_CARD_FEE`              | — |
| `UPSTREAM_PLATFORM_COLLECT` | `UPSTREAM_NETTED`             | — |

Supplier-settlement-side rails (we → supplier) carry their own
cost: `PREPAID_BALANCE` top-ups and `POSTPAID_INVOICE` settlements
typically settle via `BANK_TRANSFER_SETTLEMENT`. `VCC_TO_PROPERTY`
carries a VCC-issuance cost (card-network fee on the VCC load,
borne by the VCC funder — us).

### Supplier adapter contract impact (ADR-003)

`StaticAdapterMeta` additions (additive to ADR-003 + its 2026-04-21
amendment):

```
supported_collection_modes:         CollectionMode[]
supported_supplier_settlement_modes: SupplierSettlementMode[]
supported_payment_cost_models:       PaymentCostModel[]
```

`SupplierRate` additions (on every rate the adapter returns):

```
collection_mode:           CollectionMode
supplier_settlement_mode:  SupplierSettlementMode
payment_cost_model:        PaymentCostModel
gross_currency_semantics:  NET_TO_BB | GROSS_TO_GUEST | COMMISSION_RATE
   // NET_TO_BB       — supplier returns the amount we owe them
   // GROSS_TO_GUEST  — supplier returns the amount the guest pays;
   //                   our net is gross - commission
   // COMMISSION_RATE — supplier returns a percent / fixed commission
   //                   payable to us; gross is the property rate
commission_basis?:         PERCENT | FIXED | TIERED
commission_params?:        { ... }   // required when mode is COMMISSION_ONLY
```

The loose `booking_payment_model: CHANNEL_COLLECTS | HOTEL_COLLECTS |
SPLIT` capability declared by the 2026-04-21 ADR-003 amendment is
**superseded** by these three axes but kept as a synonym for
transitional adapters; conformance tests emit a deprecation warning
if only the loose form is set.

Adapters must declare each rate's triple at the time of returning
the rate. The booking saga persists the triple onto the `Booking` row
at confirmation, versioning it forward so that later pipeline
changes never rewrite a historical booking's semantics.

### Pricing impact (ADR-004)

Step 2 (net cost resolution) in the ADR-004 pipeline is refined:

- **`NET_TO_BB`** (default; current behavior) — the supplier's
  returned amount is our net cost, converted to pricing currency,
  marked up per the rule chain, producing `bb_sell_to_reseller_amount`
  (reseller channel) or `bb_sell_to_guest_amount` (B2C) as today.
- **`GROSS_TO_GUEST`** — the supplier's returned amount is the
  amount the guest pays. Our effective `net_cost` = `gross − commission`.
  Pricing still proceeds through the rule chain, but markup rules
  operate on top of `net_cost`, not on the guest-facing gross. A
  mandatory trace step records the `gross → net` reduction with the
  commission rule id used.
- **`COMMISSION_RATE`** — the supplier does not return a gross; it
  returns a commission rate applied to a separately-known property
  rate (from static content or from the supplier's own content
  pulls). `net_cost` is the property rate minus commission; pricing
  proceeds from there.

Pricing trace gains a new step type `COLLECTION_AND_SETTLEMENT_BIND`
immediately after net cost resolution. It records:

- `collection_mode`, `supplier_settlement_mode`, `payment_cost_model`
- `gross_currency_semantics` and the resolved `net_cost`
- Any commission rule applied

This trace entry is persistent on booked offers per ADR-004 rules.

### `recognized_margin` impact (ADR-014 amendment)

`recognized_margin` is already owned by pricing and consumed by
rewards (ADR-014 amendment 2026-04-22). ADR-020 makes its inclusion
list dependent on `CollectionMode` and `PaymentCostModel`:

| Mode combination | `recognized_margin` formula (conceptual) |
|---|---|
| `BB_COLLECTS` + `PREPAID_BALANCE` / `POSTPAID_INVOICE` | `bb_sell − net_cost − platform_card_fee_estimate − fx_buffer_used` |
| `BB_COLLECTS` + `VCC_TO_PROPERTY` | `bb_sell − net_cost − platform_card_fee_estimate − vcc_load_fee_estimate` |
| `RESELLER_COLLECTS` + `(any supplier settlement)` | `bb_sell_to_reseller − net_cost − fx_buffer_used`. **No platform card fee** — the reseller absorbed it. |
| `PROPERTY_COLLECT` + `COMMISSION_ONLY` | `commission_receivable − commission_bad_debt_provision` (conceptual). **No gross**; `bb_sell` is not a meaningful input here. |
| `PROPERTY_COLLECT` + `DIRECT_PROPERTY_CHARGE` (no commission) | `0` by default — we earn nothing on these rates. Explicit. |
| `UPSTREAM_PLATFORM_COLLECT` + `COMMISSION_ONLY` | `commission_receivable_net_of_upstream_fees` |

This is not a schema change in `recognized_margin` itself — it
remains a computed value owned by pricing per ADR-014. What changes
is the cost-inclusion list, and the fact that for commission-only
modes, `recognized_margin` must be computed from the commission
stream rather than from a (non-existent) gross-to-net differential.

Rewards consuming `recognized_margin` continue to operate through
the same narrow interface; the computation inside pricing is
mode-aware. The guarantee is: `recognized_margin` is never
negative without an explicit reason code, and is never greater than
the money we actually earned on the booking.

### Booking orchestration impact (ADR-010)

Saga steps become conditional on `CollectionMode`:

- **`BB_COLLECTS`** — full saga as per ADR-010 (tender resolution,
  authorize, supplier-book, capture). No change.
- **`RESELLER_COLLECTS`** — tender composition is billed against
  the reseller's `BillingProfile` / `CreditLine` (or netted inside
  the reseller's `CREDIT_ONLY` / `PAYOUT_ELIGIBLE` collections
  suspense per ADR-018), not a guest-facing `PaymentIntent`.
- **`PROPERTY_COLLECT`** — steps 3 (authorize) and 5 (capture) are
  **skipped** entirely. The saga progresses `TENDER_RESOLVED` (with
  an empty tender composition on our side, since we collect no
  money) → `SUPPLIER_BOOKED` → `CONFIRMED` → `NOTIFIED`. No
  `PaymentIntent` is created. `REWARDS_ACCRUED` and document issue
  still run, but document semantics differ (see below).
- **`UPSTREAM_PLATFORM_COLLECT`** — same as `PROPERTY_COLLECT` on
  our side — no `PaymentIntent`. The upstream platform confirms the
  booking after collecting; our saga waits on the upstream webhook
  before transitioning to `CONFIRMED`.

New saga step (inserted after step 4 "create supplier booking" when
`SupplierSettlementMode = VCC_TO_PROPERTY`):

**4.5 Issue VCC.** Load a virtual card for the net cost amount in
the supplier's required currency, bind it to the supplier booking,
and return the VCC reference to the supplier booking payload where
required. Compensation on a later failure: cancel / refund the VCC
load to the funding source.

New failure state: `FAILED_VCC_LOAD` (retryable with exponential
backoff; fatal after policy threshold → rollback prior steps).

The state machine is extended only additively:

```
DRAFT
  → PRICING_CONFIRMED
  → RATE_QUOTED
  → TENDER_RESOLVED              // empty composition for PROPERTY_COLLECT
                                 // and UPSTREAM_PLATFORM_COLLECT modes
  → PAYMENT_AUTHORIZED           // skipped when no guest payment
  → SUPPLIER_BOOKED
  → VCC_ISSUED                   // new; only VCC_TO_PROPERTY
  → PAYMENT_CAPTURED             // skipped when no guest payment
  → CONFIRMED
  → NOTIFIED
  → REWARDS_ACCRUED
```

### Ledger and payments impact (ADR-012)

New internal books (same double-entry machinery, additive):

- `supplier_prepaid_balance_<supplier_id>` — one book per supplier
  we hold a prepaid balance with. Top-ups (our bank transfer to the
  supplier) post as credit entries; drawdowns post as debit entries
  tied to bookings. Supersedes the informal "topped-up balance with
  TBO" described in `docs/suppliers/`.
- `supplier_postpaid_payable_<supplier_id>` — payable accrued from
  bookings under `POSTPAID_INVOICE`. Clears when the cycle invoice
  is paid.
- `supplier_commission_receivable_<supplier_id>` — receivable
  accrued under `COMMISSION_ONLY`, booked only when the commission
  is earnable per the supplier's contract (typically after stay).
- `vcc_issuance_suspense` — VCC loads recognized at load time;
  clears when the property charges the VCC and the charge settles.

No new `balance_type` values on `WalletAccount` — these are
**platform-internal** books, not customer-facing wallets, and
follow the ADR-012 pattern of internal books like
`revenue_suspense` and `reseller_collections_suspense` (ADR-018).

New `LedgerEntry.kind` values (additive):

```
SUPPLIER_PREPAID_TOPUP
SUPPLIER_PREPAID_DRAWDOWN
SUPPLIER_POSTPAID_ACCRUAL
SUPPLIER_POSTPAID_SETTLEMENT
SUPPLIER_COMMISSION_ACCRUAL
SUPPLIER_COMMISSION_RECEIVED
SUPPLIER_COMMISSION_CLAWBACK
VCC_LOAD
VCC_SETTLEMENT
VCC_UNUSED_RETURN
```

`PaymentCostModel` is carried on every payment-side `LedgerEntry`
that represents an acquiring cost so that margin reports and
reconciliation can segment by who bore the fee.

### Document impact (ADR-016, ADR-017)

Documents that make sense per collection mode:

| CollectionMode | Document set (conceptual) |
|---|---|
| `BB_COLLECTS` (B2C direct) | `TAX_INVOICE` (BB → guest), `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`. Unchanged. |
| `BB_COLLECTS` (reseller-channel, BB collects on reseller behalf — ADR-018 `CREDIT_ONLY` / `PAYOUT_ELIGIBLE`) | `TAX_INVOICE` (BB → reseller for `bb_sell_to_reseller_amount`), `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`. Unchanged from ADR-017 + ADR-018. |
| `RESELLER_COLLECTS` | `TAX_INVOICE` (BB → reseller), `RESELLER_GUEST_CONFIRMATION`, `RESELLER_GUEST_VOUCHER`. Unchanged. |
| `PROPERTY_COLLECT` + `COMMISSION_ONLY` | **No** BB `TAX_INVOICE` to the guest — we did not sell them a supply. A `BB_BOOKING_CONFIRMATION` is still issued to the guest (or to the reseller, per channel). A **commission invoice** from BB to the supplier / upstream is issued after commission recognition (new document archetype, see below). |
| `PROPERTY_COLLECT` + `DIRECT_PROPERTY_CHARGE` (no commission) | `BB_BOOKING_CONFIRMATION` only. No BB `TAX_INVOICE`, no commission doc. |
| `UPSTREAM_PLATFORM_COLLECT` + `COMMISSION_ONLY` | `BB_BOOKING_CONFIRMATION` (if we surface the booking to the guest at all), plus a commission-doc handshake with the upstream platform. No BB `TAX_INVOICE` to the guest. |

**New document archetype** added to the ADR-016 enum (additive):

```
COMMISSION_INVOICE  // BB → supplier / upstream platform, for
                    //   commission earned under COMMISSION_ONLY modes
```

Numbered monotonic per (tenant, supplier_id, fiscal_year) — a
separate sequence from the legal-tax-doc gapless sequences.
Whether a given jurisdiction treats a commission invoice as a
taxable supply is a tax-engine concern and does not change the
document model.

### Avoiding double payment-processing fees

The platform must never pay an acquiring fee twice on the same
booking gross. Rules:

1. **One collector per booking.** `CollectionMode` is scalar per
   booking; it is not a multi-valued field. The single collector
   bears the single guest-side acquiring fee.
2. **VCC-to-property and guest acquiring are a known double-fee
   risk.** When `BB_COLLECTS + VCC_TO_PROPERTY`, we pay the guest-
   side card fee **and** the VCC-issuance / property-side fee.
   This is not double-charging the guest; it is double cost to the
   margin, and must be reflected in `recognized_margin`. The
   supplier-contract review is responsible for ensuring the rate
   clears both fees with margin left. Conformance test: for every
   adapter that offers `VCC_TO_PROPERTY` rates, the adapter
   fixture must include a worked example showing both fees in the
   `recognized_margin` trace.
3. **Commission netting is explicit, never implicit.**
   `UPSTREAM_NETTED` means the upstream platform already subtracted
   its processing cost before remitting. Our `recognized_margin`
   calculation must use the received (netted) amount, not a gross
   that we never received. A commission ledger entry that does not
   identify whether it is gross or netted is rejected at ledger
   write time.
4. **No "mirrored" payment entries.** Under
   `UPSTREAM_PLATFORM_COLLECT`, we do **not** create a
   `PaymentIntent` mirror of the upstream's collection. The guest-
   to-upstream flow is not our rail and is not our ledger concern.
   Only the commission receivable is.

### Interactions with ADR-018 reseller settlement

`CollectionMode` and `ResellerSettlementMode` (ADR-018) are
orthogonal but constrained:

- `ResellerProfile.settlement_mode = RESELLER_COLLECTS` (ADR-018
  default) forces `CollectionMode = RESELLER_COLLECTS` on every
  rate offered through that reseller, regardless of what the
  underlying supplier allows. If a supplier's rate only supports
  `BB_COLLECTS`, it is **not sellable** through a
  `RESELLER_COLLECTS` reseller; filter at source selection.
- `ResellerProfile.settlement_mode ∈ { CREDIT_ONLY, PAYOUT_ELIGIBLE }`
  forces `CollectionMode = BB_COLLECTS` regardless of what the
  reseller might wish — BB is the collector because that is the
  point of the mode.
- `PROPERTY_COLLECT` and `UPSTREAM_PLATFORM_COLLECT` are incompatible
  with `CREDIT_ONLY` and `PAYOUT_ELIGIBLE`: if we never collect the
  guest's money, there is nothing to accrue to the reseller's
  earnings book. Filter at source selection.

These constraints are enforced at search / source-selection time,
not at checkout. A `PROPERTY_COLLECT` rate never reaches a
reseller's portal under `CREDIT_ONLY` in the first place.

## Consequences

- Supplier onboarding must declare the triple explicitly. This is a
  higher bar than "add credentials and go," which is correct — real
  commercial differences between rate types (merchant vs
  pay-at-hotel vs commission-only) surfaced as a single
  `booking_payment_model` flag were already producing fragile code.
- `recognized_margin` becomes mode-aware. Rewards earning on a
  `PROPERTY_COLLECT + COMMISSION_ONLY` booking earns off
  commission, not off a non-existent gross differential. This
  prevents the silent-margin-erosion anti-pattern ADR-014 already
  flagged.
- The booking saga branches on mode, but the branching is bounded
  and enumerable — five conditional steps across the state machine,
  not an open set.
- Document model gains one new archetype (`COMMISSION_INVOICE`).
  The BB `TAX_INVOICE` is still the legal tax record, but it is no
  longer unconditional: on `PROPERTY_COLLECT` and
  `UPSTREAM_PLATFORM_COLLECT` rates where we never sold the
  underlying supply, a BB `TAX_INVOICE` is an anti-pattern.
- Phase sequencing becomes straightforward (see §Phase plan below).

## Anti-patterns explicitly forbidden

- **Issuing a BB `TAX_INVOICE` on a `PROPERTY_COLLECT` or
  `UPSTREAM_PLATFORM_COLLECT` booking.** We did not sell the supply
  to the guest; we earned a commission. The legal tax record, if
  any, lives on the commission leg and is governed by the
  tax-engine ADR.
- **Creating a `PaymentIntent` mirror of an upstream-platform
  collection.** We never touched that money.
- **Computing `recognized_margin` from a gross we never received.**
  Under `UPSTREAM_NETTED`, use the netted amount. Under
  `COMMISSION_ONLY`, use the commission stream, not the gross
  hotel rate.
- **Routing a `BB_COLLECTS + COMMISSION_ONLY` combination through
  checkout.** The combination is forbidden; source selection must
  filter it out before pricing runs.
- **Mixing `PROPERTY_COLLECT` with a non-empty tender composition
  on our side.** The guest pays the property; no `TenderComposition`
  lines exist on our books.
- **Using the legacy `booking_payment_model` capability as the
  source of truth.** It is retained as a transitional synonym only;
  conformance tests must verify the explicit triple.
- **Silent FX on `COMMISSION_ONLY` commission remittance.** A
  different currency between commission rate and payout rail must
  go through an explicit FX ledger entry.
- **Writing reseller earnings (ADR-018) against a
  `PROPERTY_COLLECT` booking.** We never collected, so there is
  nothing to accrue; attempting to post a
  `RESELLER_EARNINGS_ACCRUAL` or `RESELLER_CREDIT_ACCRUAL` on such
  a booking must fail at ledger-write time.

## Phase plan

**Phase 1 (read-only core spine) — declarative only.**

- Every `SupplierRate` returned by the Hotelbeds adapter carries
  the three-axis triple. The adapter's `meta` declares supported
  modes. Conformance tests check that the triple is populated.
- Source selection filters invalid `(CollectionMode,
  SupplierSettlementMode)` pairs.
- No saga, no ledger write, no document — the spine is still
  search-only in Phase 1.

**Phase 2 (bookable spine + wallet foundation) — one axis live.**

- Only `BB_COLLECTS + (PREPAID_BALANCE | POSTPAID_INVOICE)` is
  bookable. `PaymentCostModel = PLATFORM_CARD_FEE` or
  `BANK_TRANSFER_SETTLEMENT`. This matches the TBO + Hotelbeds
  merchant scope already on the Phase 2 roadmap.
- Supplier-side books (`supplier_prepaid_balance_*`,
  `supplier_postpaid_payable_*`) ship in Phase 2 with basic admin
  CRUD. Top-up and invoice-settlement entries are manual in Phase 2.
- `recognized_margin` uses the `BB_COLLECTS` formula from the table
  above.
- Saga runs the full ADR-010 path.

**Phase 3 (multi-supplier + first direct-connect + reseller
capability).**

- `VCC_TO_PROPERTY` enabled — VCC issuance step in the saga, VCC
  load ledger entries, per-supplier VCC funding source config.
- `PROPERTY_COLLECT + COMMISSION_ONLY` enabled — commission
  receivable book, `COMMISSION_INVOICE` document archetype, saga
  branch that skips auth/capture. This matches Hotelbeds
  pay-at-hotel and Expedia Traveler-Preference-style rates.
- `PROPERTY_COLLECT + DIRECT_PROPERTY_CHARGE` enabled — booking
  confirmation only, no ledger entry on our side, no commission.
- `RESELLER_COLLECTS` formalized per ADR-017 + this ADR's
  constraints.

**Phase 4+ (B2B portal + market intelligence + more direct-connect).**

- `UPSTREAM_PLATFORM_COLLECT + COMMISSION_ONLY` enabled, gated on a
  real Booking.com Demand API (or equivalent) commercial and legal
  confirmation. Do not pre-build webhook handlers for a platform
  we are not contracted with.
- Multi-currency commission handling with explicit FX, commission
  clawback automation on cancellations after accrual, VCC recovery
  of unused loads.

**Phase 5+ (scale).**

- Reconciliation at commission-ledger scale (supplier statements
  vs our `supplier_commission_receivable_*` books), automated
  commission-clawback workflows.

## Open items

- **Card-fee estimation for `recognized_margin`.** Whether we use
  a flat blended rate per rail, per-BIN lookups, or actual
  Stripe-reported `balance_transaction.fee` values is a pricing
  contract decision co-owned with finance. Must resolve before
  Phase 2 goes live; otherwise `PERCENT_OF_MARGIN` reward rules
  are non-deterministic (ADR-014 amendment open item inherits
  here).
- **VCC provider selection.** Stripe Issuing, WEX, AirPlus, or
  bank-issued. Phase 3 commercial decision. The VCC ledger shape
  is rail-agnostic per this ADR.
- **Commission recognition timing.** Accrue on booking, on stay
  end, or on receipt? Policy-owned per supplier contract; the
  ledger records both `SUPPLIER_COMMISSION_ACCRUAL` and
  `SUPPLIER_COMMISSION_RECEIVED` so the timing question can be
  answered without a schema change.
- **`COMMISSION_INVOICE` tax treatment.** Whether a BB →
  supplier / platform commission invoice is a taxable supply
  (and where) is a tax-engine concern. The tax engine ADR
  (still outstanding per ADR-016 / ADR-017) must cover it before
  Phase 3 commission flows go live.
- **Upstream-collect webhook handshake.** Booking.com Demand API
  and equivalents require webhook confirmation of guest payment
  before we consider the booking `CONFIRMED`. The exact saga wait
  shape is provider-specific and lives in a Phase 4 design note,
  not here.
- **Legacy `booking_payment_model` retirement.** The
  `CHANNEL_COLLECTS | HOTEL_COLLECTS | SPLIT` flag remains as a
  deprecated synonym. A future ADR or amendment will remove it
  once all adapters have been migrated to the explicit triple.
