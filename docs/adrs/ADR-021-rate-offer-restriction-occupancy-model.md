# ADR-021: Rate, offer, restriction, and occupancy model

- **Status:** Accepted
- **Date:** 2026-04-22
- **Supersedes:** nothing
- **Amends:** ADR-002 (canonical hotel model — adds canonical product
  dimensions: room types, rate plans, meal plans, occupancy templates,
  child age bands; explicit that these are a separate mapping surface
  alongside `HotelMapping`), ADR-003 (supplier adapter contract — the
  `SupplierRate` returned by `searchAvailability` / `quoteRate` is
  refined into a **sourced offer snapshot** with explicit
  `rate_breakdown_granularity`; adapters declare which primitives they
  can reveal), ADR-004 (pricing — the evaluator now has two code paths:
  `SOURCED_OFFER` and `AUTHORED_RATE`; `net_cost` derivation is
  shape-aware; the pricing trace carries the shape + breakdown
  granularity), ADR-010 (booking orchestration — `cancellation_policy`
  and `tax_and_fee_breakdown` are snapshotted at confirmation from
  whichever shape produced the offer; `offer_shape` is persisted on
  `Booking`), ADR-011 (monorepo structure — adds `rate_` and `offer_`
  table prefixes and extends `hotel_` with product-dimension tables),
  ADR-013 (direct connectivity — authored-rate ingestion for CRS /
  channel-manager sources uses the new `rate_*` tables, not a generic
  flat rate table).
- **Depends on:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-010, ADR-013,
  ADR-020

## Context

The DB baseline shipped under Phase 0 (tenant, account, canonical
hotel, supplier-hotel, hotel mapping, booking shell) intentionally
stopped short of anything price- or inventory-shaped. That was the
right call for a foundation migration. It is not enough to stand up
Phase 1.

The platform has to sell hotel nights sourced from **two very
different animals**, and the data model must respect that difference
instead of flattening it.

### Shape A — Sourced, composed offers (bedbanks, OTAs, affiliate APIs)

Hotelbeds, WebBeds, TBO, Expedia Rapid (later), Booking.com Demand
(contingent): the supplier **composes the sellable offer for us**. We
call `searchAvailability` with a date range and room request; the
supplier returns a price for that exact stay, already populated with:

- Their own room-and-rate-plan combination (often as a single opaque
  `rate_key`).
- A total net amount in a supplier currency.
- A board/meal indicator (sometimes normalized, sometimes a free-text
  label).
- A cancellation policy — sometimes structured, sometimes prose.
- A taxes-and-fees hint — sometimes itemized, often just "included"
  or "excluded", with an opaque destination-fee blob.

Critically, these APIs **do not reliably expose the underlying
primitives**. We cannot ask Hotelbeds "what is the per-extra-adult
supplement on this rate plan on this date for this room"; the API
doesn't commit to exposing it, and the number may not even exist as
a stable primitive in the upstream system — it may be an output of
the upstream yield engine that only materializes when the exact
occupancy is asked for.

The truthful statement for these suppliers: **the offer as returned is
the atomic unit.** Re-deriving it from primitives is either impossible
or a fabrication. What we can do — and what we must do — is snapshot
exactly what they returned, including their raw payload, so we can
re-price, reconcile, and dispute truthfully.

### Shape B — Authored primitives (direct contracts, CRS, channel managers)

Direct paper contracts, Sabre SynXis Channel Connect, RateGain,
SiteMinder, Mews, Cloudbeds, Channex: **we or the hotel author the
rate primitives**, and the sellable offer for a given stay is
**composed on our side** (or on a boundary we control) from those
primitives. The natural shape is:

- Room types (Deluxe King, Suite, …).
- Rate plans (BAR, Advance Purchase Non-Refundable, Member, Corporate
  X, …).
- Board/meal plans (Room Only, Bed & Breakfast, Half Board, …) and
  meal-plan supplements per occupant class.
- Occupancy templates (base adults, max adults, max children, max
  total) per (room_type, rate_plan).
- Base rate per (room_type, rate_plan, meal_plan, date) for a "base"
  occupancy.
- Extra-person supplements (extra adult, extra child by age band).
- Child age bands (0–1 free, 2–5 child rate, 6–11 half-adult rate,
  12+ adult rate — per-property).
- Taxes and fees as structured components (city tax per person per
  night, resort fee per stay, VAT percent, …), inclusive or
  additive, per jurisdiction.
- Cancellation policy as a structured timeline.
- Restrictions layered on top: STOP_SELL, CTA (closed to arrival),
  CTD (closed to departure), MIN_LOS, MAX_LOS, ADVANCE_PURCHASE
  windows, RELEASE / CUTOFF hours.
- (Optional, per channel) allotments / quotas.

For channel-manager push ingestion, the primitives arrive as ARI
events and populate these tables directly. For CRS pull, we read the
primitives and cache them with freshness windows. For paper
contracts, an internal tool writes the primitives directly.

### Why this can't be one flat rate table

Pretending both shapes are the same leads predictably to one of two
failure modes:

1. **Flatten sourced into a primitives table.** We'd invent
   per-extra-adult supplements, per-day base rates, and
   structured-policy rows from API responses that never committed to
   exposing them. Every such invented field is a reconciliation hazard
   and a dispute-liability time bomb.
2. **Flatten authored into a snapshot table.** We'd store every
   bookable (room, rate plan, stay dates, occupancy) tuple as a
   pre-composed snapshot row. Direct-connect ARI would explode into
   combinatorial row counts, stop-sells and restrictions would be
   duplicated per tuple, and yield changes would require mass
   rewrites instead of a single primitive update. We'd also lose the
   ability to answer "what is the advance-purchase window on this
   rate plan for April" without scanning a decomposed snapshot set.

ADR-013's `supply_ingested_rate` was a first pass at this for
channel-manager push, but it describes a **composed row shape** (a
rate_key with net_amount and board_code). It is closer to a sourced
snapshot than to authored primitives, and it explicitly does not
model occupancy templates, meal plan supplements, per-day base rates,
age bands, or restrictions. Extending it to carry those would
collapse back into failure mode #1.

ADR-003 currently describes `SupplierRate` as the single shape an
adapter returns. That contract needs a refinement — `SupplierRate`
is **always** shaped like a sourced-offer snapshot at the adapter
boundary, but authored-rate adapters additionally expose the
underlying primitives through a dedicated ingestion surface (see
ADR-013 push ingestion + this ADR's `rate_auth_*` tables). Downstream
pricing code can still treat offers uniformly; the two shapes diverge
only inside the pricing evaluator and inside reconciliation.

### Why booking makes the distinction permanent

At booking time we must **freeze** whatever shape produced the offer:

- For a sourced booking we freeze the raw payload, the normalized
  snapshot, the cancellation-policy snapshot, and the tax-and-fee
  breakdown exactly as the supplier composed them. If a dispute
  arises in year three we prove that Hotelbeds-as-of-then-quoted-X.
- For an authored booking we freeze the primitives that were resolved
  into the composed offer (base rate + supplements + taxes + cancel
  policy) along with an authored-rate version pointer. If we revise
  the rate plan tomorrow, the booking still carries the snapshot.

In both cases the **snapshot** is on the booking; the **live** shape
is on the supply side. Pricing evaluator never re-derives historical
bookings from live primitives.

## Decision

### Three layers, separated in the schema

1. **Canonical product dimensions** (`hotel_*` extensions). Platform-
   wide vocabulary for rooms, rate plans, meal plans, occupancy
   templates, and child age bands. Both shape A and shape B map into
   these. Mapping tables bridge supplier codes to canonical codes and
   carry confidence + provenance like ADR-008 `HotelMapping` does for
   hotel identity.
2. **Authored rate primitives** (`rate_*`). Direct / CRS / channel-
   manager sources write primitives here. The pricing evaluator
   composes a sellable offer by combining primitives with a requested
   (stay dates, occupancy, channel) tuple. `supply_ingested_rate`
   (ADR-013) is retained for channel-manager push-mode offers that
   arrive as already-composed rows; authored-primitive push modes
   (SynXis ARI, RateGain ARI) write `rate_auth_*` rows instead.
3. **Sourced offer snapshots** (`offer_*`). Bedbank / OTA / affiliate
   sources write offer snapshots here, one row per (search, returned
   offer). These are append-mostly with supersede chains during a
   search session and are purged on a short TTL (except snapshots
   referenced by an active booking, which move into
   `booking_sourced_offer_snapshot`).

The pricing evaluator has two entry points:

```
priceSourcedOffer(offer_id)   → PricedOffer + PricingTrace
priceAuthoredPrimitives(ctx)  → PricedOffer + PricingTrace
```

Both return `PricedOffer` (ADR-004) with identical downstream shape.
The trace records which path was taken and the breakdown granularity.
**No code path fakes one shape from the other.**

### Offer shape enum

A new enum, persisted on `Booking` and carried in adapter
capabilities:

```
OfferShape:
  SOURCED_COMPOSED        // bedbank / OTA / affiliate — one opaque offer
  AUTHORED_PRIMITIVES     // direct / CRS / CM — composed from our primitives
  HYBRID_AUTHORED_OVERLAY // primitives exist + the source also returns its own composition (rare; e.g. some CRS profiles)
```

Pricing and booking may read `offer_shape` to pick paths; adapters
declare supported shapes in `meta`.

### Rate-breakdown granularity enum

```
RateBreakdownGranularity:
  TOTAL_ONLY                // just a stay total (Hotelbeds Merchant opaque)
  PER_NIGHT_TOTAL           // per-night totals, no component split
  PER_NIGHT_COMPONENTS      // per-night rows with room / meal / supplement lines
  PER_NIGHT_COMPONENTS_TAX  // above + separated tax / fee lines
  AUTHORED_PRIMITIVES       // resolved from our own primitives at search time
```

This is a description of **what the source committed to expose**, not
a goal we try to achieve on their behalf. Persisted on every
`offer_sourced_snapshot` and on every booking snapshot.

### Canonical product dimensions

New `hotel_*` tables, platform-wide (no `tenant_id`; these are
catalog entities per canonical hotel, not per-tenant preferences).
Per-tenant visibility / selling rules live elsewhere (pricing rules
scope, merchandising).

- `hotel_room_type` — `(canonical_hotel_id, code, name, description,
  max_occupancy_hint, status)`. `code` is a short, canonical, stable
  identifier we assign (e.g., `DLX_KNG`).
- `hotel_rate_plan` — `(canonical_hotel_id, code, name, rate_class,
  refundable, meal_plan_default_code?, description, status)`.
  `rate_class` is a controlled vocabulary (`PUBLIC_BAR`,
  `ADVANCE_PURCHASE`, `NON_REFUNDABLE`, `MEMBER`, `CORPORATE`,
  `NEGOTIATED`, `OPAQUE_WHOLESALE`). Never a free-text blob.
- `hotel_meal_plan` — `(canonical_hotel_id?, code, name, includes[])`.
  A small number of meal plans are platform-global (RO, BB, HB, FB,
  AI) with optional per-hotel overrides.
- `hotel_occupancy_template` — `(canonical_hotel_id, room_type_id,
  rate_plan_id?, base_adults, max_adults, max_children, max_total,
  standard_bedding)`. Either global to the room type, or narrowed by
  rate plan when authored.
- `hotel_child_age_band` — `(canonical_hotel_id, band_code,
  min_age_inclusive, max_age_inclusive, status)`. Per-hotel because
  age rules are a hotel-level policy, not platform-level.

And the mapping surface from supplier codes to these canonicals:

- `hotel_room_mapping` — `(supplier_id, supplier_hotel_id,
  supplier_room_code, canonical_room_type_id?, mapping_method,
  confidence, status, superseded_by_id?)`. Mirrors the
  `HotelMapping` pattern (ADR-008).
- `hotel_rate_plan_mapping` — `(supplier_id, supplier_hotel_id,
  supplier_rate_code, canonical_rate_plan_id?, rate_class_override?,
  mapping_method, confidence, status, superseded_by_id?)`.
- `hotel_meal_plan_mapping` — `(supplier_id, supplier_meal_code,
  canonical_meal_plan_id, confidence, status, superseded_by_id?)`.
  Smaller vocabulary, often supplier-global rather than hotel-scoped.
- `hotel_occupancy_mapping` — `(supplier_id, supplier_hotel_id,
  supplier_occupancy_code?, canonical_occupancy_template_id?,
  mapping_method, confidence, status)`. Used when the supplier
  addresses occupancy via coded templates rather than `(adults,
  children[])`.

Mappings follow the ADR-008 convention: partial unique index excludes
`REJECTED | SUPERSEDED`; chains use `superseded_by_id`; conflict
resolution is human-in-the-loop.

**Unmapped is acceptable.** Sourced offers can ship without a
canonical room-type mapping — the snapshot carries
`supplier_room_code` as text. Pricing still works; cross-supplier
comparison and analytics degrade gracefully until mapping fills in.

### Authored rate primitives (`rate_auth_*`)

Present only when a source can author primitives. Not used by
bedbank / OTA adapters.

- `rate_auth_base_price` — `(tenant_id, supplier_id, canonical_hotel_id,
  rate_plan_id, room_type_id, meal_plan_id, stay_date,
  amount_minor_units, currency, effective_from, effective_to,
  supersedes_id?, raw_payload_hash?)`. One row per date per
  combination; base occupancy is implied by `occupancy_template`
  attached to the rate plan.
- `rate_auth_extra_person_rule` — `(tenant_id, supplier_id,
  canonical_hotel_id, rate_plan_id, room_type_id, person_kind,
  child_age_band_id?, pricing_mode, amount_minor_units?,
  percent_of_base?, currency, effective_from, effective_to)`.
  `person_kind ∈ {EXTRA_ADULT, CHILD}`. `pricing_mode ∈ {FLAT,
  PERCENT_OF_BASE, FREE}`.
- `rate_auth_meal_supplement` — `(tenant_id, supplier_id,
  canonical_hotel_id, meal_plan_id, person_kind,
  child_age_band_id?, pricing_mode, amount_minor_units?,
  percent_of_base?, currency, effective_from, effective_to)`.
  Supplements are layered on top of a base meal plan.
- `rate_auth_tax_component` — `(tenant_id, canonical_hotel_id?,
  jurisdiction_code, component_code, component_kind, basis,
  rate_percent?, amount_minor_units?, currency?, inclusive,
  effective_from, effective_to)`. `component_kind ∈ {VAT, CITY_TAX,
  TOURISM_FEE, SERVICE_CHARGE, OTHER}`. `basis ∈ {PER_STAY,
  PER_NIGHT, PER_NIGHT_PER_PERSON, PERCENT_OF_BASE}`. Tax is defined
  per jurisdiction; a hotel inherits its jurisdiction's components
  unless overridden at the hotel level.
- `rate_auth_fee_component` — `(tenant_id, canonical_hotel_id,
  component_code, component_kind, basis, amount_minor_units,
  currency, mandatory, payable_to, effective_from, effective_to)`.
  `payable_to ∈ {PROPERTY, PLATFORM, SUPPLIER}`; `component_kind ∈
  {RESORT_FEE, CLEANING_FEE, EXTRA_BED_FEE, OTHER}`.
- `rate_auth_restriction` — `(tenant_id, supplier_id,
  canonical_hotel_id, rate_plan_id?, room_type_id?, stay_date,
  restriction_kind, params, effective_from, effective_to,
  superseded_by_id?)`. `restriction_kind` is the ADR-wide enum (see
  below). `params` is a small JSONB — e.g. `{"min_los":3}` or
  `{"hours":48}` — rather than a column per kind.
- `rate_auth_allotment` — `(tenant_id, supplier_id,
  canonical_hotel_id, rate_plan_id, room_type_id, stay_date,
  total_units, held_units, effective_from, effective_to)`. Optional,
  only for channels that ship inventory counts.
- `rate_auth_cancellation_policy` — `(tenant_id, supplier_id,
  canonical_hotel_id, rate_plan_id, policy_version, windows_jsonb,
  refundable, effective_from, effective_to, superseded_by_id?)`.
  `windows_jsonb` is a structured timeline `[{ from_hours_before,
  to_hours_before, fee_type, fee_amount, fee_currency, fee_basis }]`.
  Versioned and immutable; composition references a specific policy
  version.

Restriction kinds enum (authoritative list; shape A also uses the
same kinds where it can, but shape A typically doesn't reveal enough
to populate them):

```
RestrictionKind:
  STOP_SELL
  CTA                    // closed to arrival
  CTD                    // closed to departure
  MIN_LOS                // params: { min_los }
  MAX_LOS                // params: { max_los }
  ADVANCE_PURCHASE_MIN   // params: { days }
  ADVANCE_PURCHASE_MAX   // params: { days }
  RELEASE_HOURS          // params: { hours } — channel-manager release window
  CUTOFF_HOURS           // params: { hours } — supplier-side cutoff
```

### Sourced offer snapshots (`offer_*`)

Present for every adapter returning composed offers at search time.

- `offer_sourced_snapshot` — `(id, tenant_id, supplier_id,
  canonical_hotel_id?, supplier_hotel_code, supplier_rate_key,
  search_session_id, check_in, check_out,
  occupancy_adults, occupancy_children_ages_jsonb,
  supplier_room_code, canonical_room_type_id?,
  supplier_rate_code, canonical_rate_plan_id?,
  supplier_meal_code, canonical_meal_plan_id?,
  total_amount_minor_units, total_currency,
  rate_breakdown_granularity, received_at, valid_until,
  raw_payload_hash, raw_payload_storage_ref,
  superseded_by_id?, status)`. TTL-driven; rows referenced by a
  booking are copied/linked into `booking_sourced_offer_snapshot`.
- `offer_sourced_component` — `(offer_snapshot_id, component_kind,
  description, amount_minor_units, currency,
  applies_to_night_date?, applies_to_person_kind?, inclusive)`.
  Populated only to the extent the supplier exposed a breakdown.
  `component_kind ∈ {ROOM_RATE, MEAL_SUPPLEMENT, EXTRA_PERSON_CHARGE,
  TAX, FEE, DISCOUNT, OTHER}`. For `TOTAL_ONLY` granularity this
  table is empty; for `PER_NIGHT_COMPONENTS_TAX` it is fully
  populated.
- `offer_sourced_restriction` — `(offer_snapshot_id, restriction_kind,
  params, source_verbatim_text?)`. Populated when the supplier
  revealed restriction-like metadata (e.g. non-refundable, MIN_LOS).
  `source_verbatim_text` preserves the prose form for legal
  defensibility.
- `offer_sourced_cancellation_policy` — `(offer_snapshot_id,
  windows_jsonb, refundable, source_verbatim_text?, parsed_with)`.
  `parsed_with` records which parser / version produced the
  structured form, so we can re-parse historical snapshots after
  parser improvements without destroying the original.

Raw payloads follow ADR-003's "raw is kept" rule: body stored in
object storage (MinIO / S3), hash + storage ref persisted here.

### Booking-time snapshots

At `CONFIRMED` transition the booking takes a snapshot that pins the
economic terms for the life of the booking:

- `booking_sourced_offer_snapshot` — a frozen copy of the
  `offer_sourced_snapshot` used, its `offer_sourced_component` rows,
  its cancellation policy, and a pointer to the raw payload. Never
  joined to the live offer row after confirmation.
- `booking_authored_rate_snapshot` — a frozen, flattened view of the
  authored primitives resolved at confirmation: base-per-night rows,
  supplements applied, tax/fee components materialized, cancellation
  policy version id. Small JSONB + structured columns where
  retrieval needs are obvious.
- `booking_cancellation_policy_snapshot` — structured timeline used
  to evaluate cancellation-fee events. Source-agnostic shape: both
  shapes produce it. Source provenance recorded in `captured_from ∈
  {SUPPLIER_STRUCTURED, SUPPLIER_PROSE_PARSED, AUTHORED_POLICY}`.
- `booking_tax_fee_snapshot` — frozen per-line tax and fee rows
  (including zero-rate lines) used to generate `TAX_INVOICE`
  (ADR-016). Distinct from `booking_sourced_offer_snapshot` because
  tax/fee decisions may require tax-engine evaluation (ADR-016 /
  Phase 3 tax engine) rather than verbatim supplier passthrough.

All booking snapshot tables are append-only and immutable post-
confirmation. Corrections go through credit/debit notes per ADR-016.

### What goes where — economic components reference

| Concept | Authored shape | Sourced shape |
|---|---|---|
| Base rate | `rate_auth_base_price` | implicit in `offer_sourced_snapshot.total_amount` (or `offer_sourced_component.ROOM_RATE` if exposed) |
| Extra adult | `rate_auth_extra_person_rule(EXTRA_ADULT)` | `offer_sourced_component.EXTRA_PERSON_CHARGE` if exposed; else invisible inside total |
| Extra child | `rate_auth_extra_person_rule(CHILD)` + `hotel_child_age_band` | `offer_sourced_component.EXTRA_PERSON_CHARGE` if exposed; age bands do not flow back from sourced |
| Meal supplement | `rate_auth_meal_supplement` | `offer_sourced_component.MEAL_SUPPLEMENT` if exposed |
| City / tourism tax | `rate_auth_tax_component(CITY_TAX)` | `offer_sourced_component.TAX` if exposed; else inside total and noted on payload |
| VAT | `rate_auth_tax_component(VAT)` | usually inside total for foreign suppliers; inclusive/exclusive recorded on snapshot |
| Resort / cleaning fee | `rate_auth_fee_component` | `offer_sourced_component.FEE` if exposed; otherwise lands in destination-fee blob on raw payload |
| Stop-sell | `rate_auth_restriction(STOP_SELL)` | pricing never sees a stop-sold offer (supplier omits it) |
| CTA / CTD | `rate_auth_restriction(CTA|CTD)` | usually invisible; would cause a `RateExpired` at `quoteRate` if violated upstream |
| Min/Max LOS | `rate_auth_restriction(MIN_LOS|MAX_LOS)` | `offer_sourced_restriction` if disclosed |
| Advance purchase | `rate_auth_restriction(ADVANCE_PURCHASE_MIN|MAX)` | `offer_sourced_restriction` if disclosed |
| Release / cutoff | `rate_auth_restriction(RELEASE_HOURS|CUTOFF_HOURS)` | effectively channel-internal; not exposed by sourced APIs |
| Cancellation policy | `rate_auth_cancellation_policy` | `offer_sourced_cancellation_policy` (structured + verbatim) |
| Allotment | `rate_auth_allotment` | n/a; supplier absorbs inventory control |

The booking-time snapshot flattens whichever column applies into a
uniform shape (`booking_cancellation_policy_snapshot`,
`booking_tax_fee_snapshot`), so downstream (documents,
reconciliation, rewards) never has to branch on shape.

### Contract refinements

**ADR-003 refinement.** `SupplierRate` gains two fields:

- `offer_shape: OfferShape` — always set.
- `rate_breakdown_granularity: RateBreakdownGranularity` — always set.

`StaticAdapterMeta` gains:

- `supports_authored_primitives: bool` — true for CRS / CM / direct
  adapters that expose primitives.
- `min_rate_breakdown_granularity: RateBreakdownGranularity` — the
  weakest granularity the supplier may return. Conformance suite
  asserts snapshots never claim a stronger granularity than this.

Sourced adapters set `offer_shape = SOURCED_COMPOSED` on every
`SupplierRate`. Authored adapters set `offer_shape =
AUTHORED_PRIMITIVES`, populate `rate_auth_*` on push / scheduled
pull, and compose `SupplierRate`s at search time.

**ADR-004 refinement.** Pricing evaluator takes either an
`offer_snapshot_id` or an authored composition context. `net_cost`
derivation:

- Sourced: `total_amount` on snapshot, adjusted by
  `gross_currency_semantics` (ADR-020).
- Authored: sum of base + supplements over the stay, plus additive
  tax/fee components (exclusive), minus discount components.

The `PricingTrace` records `offer_shape` and
`rate_breakdown_granularity` alongside the rule chain.

**ADR-010 refinement.** `booking_cancellation_policy_snapshot`,
`booking_tax_fee_snapshot`, and exactly one of
`booking_sourced_offer_snapshot` / `booking_authored_rate_snapshot`
must be written in the same transaction as the `CONFIRMED`
transition. If the snapshot write fails, confirmation fails.

**ADR-013 refinement.** Direct-connect push ingestion has two
variants:

- **Composed push** — channel manager only exposes a composed rate
  row per stay (smaller channel managers). Continues to write
  `supply_ingested_rate` (keep this as-is).
- **Primitives push** — CRS / modern CM that streams ARI as
  primitives (SynXis, RateGain ARI). Writes `rate_auth_*` directly.

An adapter may be primitives-push upstream but still emit
`SupplierRate`s with `offer_shape = AUTHORED_PRIMITIVES` composed on
read. A given adapter may not mix both within the same supplier.

### Additive constraints and conventions

- All primary keys CHAR(26) ULIDs (existing convention).
- All money: `(amount_minor_units BIGINT, currency CHAR(3))`.
- All dates: stay dates are property-local `DATE`; effective windows
  are UTC `timestamptz`.
- Every `rate_auth_*` row carries `effective_from` / `effective_to`
  and a `supersedes_id` for auditability.
- Every `offer_sourced_*` row is TTL-bounded; referenced snapshots
  are copied into `booking_sourced_offer_snapshot` before the TTL
  fires.
- `raw_payload_storage_ref` is the object-storage key; never inline
  the raw body in Postgres.
- Restriction `params` JSONB is validated by a small whitelist-per-
  kind schema at write time. Unknown keys are rejected.

## Consequences

- Two concrete pricing code paths, deliberately non-merged. The
  evaluator will branch on `offer_shape`. That is the intended shape.
- New module-owned tables under the existing ownership rules
  (ADR-011): `hotel_*` additions stay in content/mapping; `rate_*`
  in supply; `offer_*` in supply; `booking_*` snapshots in booking.
- Phase 1 migrations expand: canonical dims + mappings + sourced-
  offer tables must land before Hotelbeds can write snapshots.
  Authored `rate_*` tables can wait until the first direct-connect
  integration (Phase 3 per ADR-013) — nothing in Phase 1 or 2 writes
  them.
- The booking shell from the Phase 0 baseline gains four dependent
  snapshot tables. These are additive; the existing `booking_booking`
  columns do not change.
- The pricing trace gains two fields (`offer_shape`,
  `rate_breakdown_granularity`). Existing trace consumers (none yet)
  tolerate extra fields.
- Conformance-suite work: the Phase 1 conformance suite must assert
  adapters correctly declare their `offer_shape` and
  `min_rate_breakdown_granularity`, and that snapshots returned
  respect the declaration.

## Scope by phase

### Phase 1 migrations (land before Hotelbeds adapter)

Canonical product dimensions:

- `hotel_room_type`
- `hotel_rate_plan`
- `hotel_meal_plan`
- `hotel_occupancy_template`
- `hotel_child_age_band`

Mappings (schema only; deterministic population follows with the
adapter):

- `hotel_room_mapping`
- `hotel_rate_plan_mapping`
- `hotel_meal_plan_mapping`
- `hotel_occupancy_mapping`

Sourced-offer snapshots:

- `offer_sourced_snapshot`
- `offer_sourced_component`
- `offer_sourced_restriction`
- `offer_sourced_cancellation_policy`

Nothing else. No authored-rate tables in Phase 1 — no adapter writes
them until Phase 3.

### Phase 2 migrations (land with booking saga)

Booking-time snapshots:

- `booking_sourced_offer_snapshot`
- `booking_cancellation_policy_snapshot`
- `booking_tax_fee_snapshot`

`booking_authored_rate_snapshot` table schema ships in Phase 2 as an
empty target so migrations are stable, but no write path exists
until Phase 3.

### Phase 3 migrations (land with first direct-connect)

Authored-rate primitives:

- `rate_auth_base_price`
- `rate_auth_extra_person_rule`
- `rate_auth_meal_supplement`
- `rate_auth_tax_component`
- `rate_auth_fee_component`
- `rate_auth_restriction`
- `rate_auth_allotment`
- `rate_auth_cancellation_policy`

Write path for `booking_authored_rate_snapshot`.

### Later

- Tax engine ADR (Phase 3 prerequisite) determines whether
  `rate_auth_tax_component` is the authoritative tax store or whether
  it is a caching layer over a tax-engine port. For now the table is
  the source of truth; the tax engine will read from it.
- Content-side pipelines for canonical rate-plan / meal-plan
  curation are out of scope here — the mapping tables are the seam.

## What a Hotelbeds Phase 1 adapter must do, concretely

Because this is the reason for pausing: to unblock Hotelbeds the
Phase 1 rate-model migrations and minimal write paths must land
first. Specifically Hotelbeds must:

- Populate `hotel_room_mapping`, `hotel_rate_plan_mapping`,
  `hotel_meal_plan_mapping` deterministically where possible on first
  content sync. Queue fuzzy matches; unmapped is allowed.
- On every `searchAvailability` response:
  - Write one `offer_sourced_snapshot` per returned offer.
  - Write `offer_sourced_component` rows only when the Hotelbeds
    response actually exposes component-level data (usually it does
    not — default `TOTAL_ONLY`).
  - Write `offer_sourced_cancellation_policy` with both the
    structured form (when Hotelbeds returns policy windows) and
    `source_verbatim_text` (always).
  - Hash + store raw payload in MinIO / S3, persist
    `raw_payload_hash` + `raw_payload_storage_ref`.
- Declare `offer_shape = SOURCED_COMPOSED` and
  `min_rate_breakdown_granularity = TOTAL_ONLY` in adapter `meta`.
  Hotelbeds's `commitValue` / detailed breakdown fields, where
  present, upgrade to `PER_NIGHT_TOTAL` on specific rate classes —
  capture that variation per offer, not per adapter.

Everything else in the Phase 1 spec (ADR-020 triple declarative,
search API endpoint, pricing trace, basic markup rule) remains
unchanged. No authored-rate tables, no booking-time snapshots, no
`rate_auth_*` writes — those are Phase 2 / Phase 3.

## Open items

- Canonical rate-class vocabulary — the ADR-level controlled list
  above is a starting point; may extend during Hotelbeds Phase 1
  based on actual returned rate classes. Any addition goes to the
  enum, not to a free-text column.
- Tax-engine boundary (Phase 3) — may change whether
  `rate_auth_tax_component` remains authoritative.
- Re-parsing sourced cancellation-policy prose — parser versioning
  supported (`parsed_with`), but we explicitly do not back-fill
  historical snapshots automatically; booking-time snapshots remain
  immutable regardless of parser changes.
- Channel-manager composed-push adapters continue using
  `supply_ingested_rate` (ADR-013). Unifying that table with
  `offer_sourced_snapshot` is deliberately deferred; unifying now
  would expand Phase 1 without benefit.

## Amendment 2026-04-23 — static seasonal contracts and promotions

The original ADR-021 defined authored primitives under a single
assumed shape: per-day streaming (`rate_auth_base_price` with one
row per `(supplier, hotel, rate_plan, room_type, meal_plan,
stay_date)`). That fits yield-managed direct-connect (SynXis,
RateGain ARI, Mews) where the PMS streams a price per day. It does
**not** fit a large and commercially important class of direct
supply:

- **Static seasonal paper contracts.** A hotel signs a contract
  valid 2026-11-01 → 2027-10-31, defines three seasons
  ("Low", "Shoulder", "Peak") with multiple non-contiguous date
  bands each, and gives one rate per (season, room type, rate
  plan, meal plan, occupancy). Per-day authoring is a category
  mismatch — there is no per-day rate to author, and forcing one
  into `rate_auth_base_price` by compiling a season into 365
  rows-per-combination is write amplification that breaks audit
  (which row did the contract actually specify? all of them
  redundantly), breaks copy-season (which is a first-class
  operation on seasons, not on per-day rows), and breaks
  promotions (which we want to author against the season and
  watch in effect across its date bands).

Separately, the ADR did not define a **promotion overlay** for
authored rates. Real direct-rate commercial practice is: set a
static seasonal base, then layer named promotions ("Summer Early
Bird", "Stay 4 Pay 3", "-15% on Deluxe King in Shoulder") with
their own scope, windows, priority, and stacking rules.
Restrictions (STOP_SELL, CTA, MIN_LOS, …) are a separate concern
from promotions and stay in `rate_auth_restriction`.

Neither of these shapes belongs on the sourced side. Bedbank / XML
/ OTA connectivity returns composed offers and stays in
`offer_sourced_*`. Nothing in this amendment touches the sourced
side; it expands the authored side only.

### Two authoring modes under the authored-primitives shape

`OfferShape = AUTHORED_PRIMITIVES` is refined with an **authoring
mode**, persisted on `rate_contract` and on any standalone
`rate_auth_*` row that is not contract-scoped:

```
AuthoringMode:
  SEASONAL_CONTRACT   // static seasonal base authored per season;
                      // expanded to stay-date prices at evaluation
                      // time by looking up the season for each
                      // stay night. Paper contracts live here.
  PER_DAY_STREAM      // per-day base authored by an upstream
                      // stream (CRS / CM ARI). `rate_auth_base_price`
                      // per-day rows are the canonical store.
```

A given `(supplier, canonical_hotel, rate_plan)` selects **one**
authoring mode at a time. Mixing modes on the same rate plan is a
conflict and is rejected at contract activation. A hotel that has
both a seasonal paper contract on one rate plan and a CRS-streamed
price on another rate plan is fine — they are different rate plans.

**The existing `rate_auth_base_price` table is retained unchanged.**
It is the per-day store for `PER_DAY_STREAM`. Seasonal contracts do
**not** write to it. Pricing resolves the per-night base for a stay
via one of two code paths inside the `AUTHORED_PRIMITIVES` branch —
select by the rate plan's authoring mode. Booking-time snapshots
flatten both into the same `booking_authored_rate_snapshot` shape
so downstream never branches on authoring mode.

### Contracts and seasons

A new commercial-agreement spine under the `rate_` prefix. Contracts
are scoped to `(tenant, supplier, canonical_hotel)`. Contract
versioning follows the ADR-021 supersede pattern; in-flight
revisions go through status transitions rather than in-place edits.

- `rate_contract` — the agreement. Fields: `id`, `tenant_id`,
  `supplier_id` (typically the `DIRECT_PAPER` supplier; may also be
  used by a `DIRECT_CRS` supplier configured for static rates),
  `canonical_hotel_id`, `contract_code` (human-readable, unique
  per tenant + supplier + hotel), `name`, `default_currency CHAR(3)`,
  `effective_from`, `effective_to`, `signed_at`, `signed_by_ref`,
  `authoring_mode = 'SEASONAL_CONTRACT'` (enum; this ADR amendment
  introduces `SEASONAL_CONTRACT` — `PER_DAY_STREAM` does not use
  this table), `status ∈ {DRAFT | ACTIVE | SUSPENDED | EXPIRED |
  TERMINATED | SUPERSEDED}`, `supersedes_id?`, `created_at`,
  `created_by`, `updated_at`. Rate-plan / room-type coverage is
  modeled by the presence or absence of `rate_contract_price` rows
  rather than by a separate coverage table — absent pricing means
  the combination is not sold under this contract.
- `rate_contract_season` — a named season within a contract.
  Fields: `id`, `contract_id`, `code` (free string unique within
  the contract — e.g. `LOW`, `SHOULDER`, `PEAK`), `name`,
  `priority` (integer; higher wins when the date-band resolution
  is ambiguous; documented explicitly below), `notes?`, `status ∈
  {DRAFT | ACTIVE | ARCHIVED}`, `copied_from_season_id?`,
  `copied_at?`, `copied_by_ref?`, `created_at`, `created_by`.
  Copy-season audit fields are first-class on the row.
- `rate_contract_season_date_band` — a non-contiguous date band
  belonging to a season. One season → N bands. Fields: `id`,
  `season_id`, `date_from DATE`, `date_to DATE` (inclusive,
  property-local), `status`. A season without any band is not
  eligible at pricing; a band with `date_to < date_from` is
  rejected at write.

  **Overlap semantics.** Within a single contract, two bands from
  different seasons may overlap on a date. The higher
  `season.priority` wins; ties break to the lower `season.code`
  lexically and then to lower `season.id`. Overlap within the
  **same** season is allowed (redundancy is not harmful) but
  flagged at authoring time. Cross-contract overlap is resolved by
  contract selection upstream (only one active contract per
  `(supplier, hotel, rate_plan)` at a stay date) and is therefore
  not a pricing-time concern.

- `rate_contract_price` — the authored base rate. One row per
  `(contract, season, room_type, rate_plan, meal_plan,
  occupancy_template)`. Fields: `id`, `contract_id`, `season_id`,
  `room_type_id` (canonical FK — must belong to the contract's
  hotel), `rate_plan_id` (canonical FK — must belong to the
  contract's hotel), `meal_plan_id` (canonical FK), `occupancy_template_id`
  (FK — the base occupancy this price is quoted for; extra-person
  supplements ride on top), `base_amount_minor_units BIGINT`,
  `currency CHAR(3)` (defaults to `contract.default_currency`),
  `status ∈ {DRAFT | ACTIVE | ARCHIVED}`, `created_at`,
  `created_by`. Partial unique index on `(contract_id, season_id,
  room_type_id, rate_plan_id, meal_plan_id, occupancy_template_id)
  WHERE status = 'ACTIVE'`.

### Relationship to existing `rate_auth_*` primitives

Contracts introduce the base price. Everything else continues to
live in the existing authored-primitive tables, and gains an
**optional** narrowing scope so an extra-adult supplement or a
restriction can be contract-scoped when real-world contracts
actually vary those by contract.

The existing tables are **unchanged** except for three optional
nullable FK columns added in this amendment:

- `rate_auth_extra_person_rule.contract_id?`
- `rate_auth_extra_person_rule.season_id?`
- `rate_auth_meal_supplement.contract_id?`
- `rate_auth_meal_supplement.season_id?`
- `rate_auth_restriction.contract_id?`
- `rate_auth_restriction.season_id?`
- `rate_auth_fee_component.contract_id?`
- `rate_auth_cancellation_policy.contract_id?`

Default (NULL) means "contract-independent": the rule applies to
every active seasonal contract for the same `(supplier, hotel,
rate_plan)` tuple. A non-null `contract_id` (and optional
`season_id`) narrows the rule to that contract (and optionally
that season). Resolution at pricing time is most-specific-wins:
contract+season → contract → supplier+hotel. The partial unique
indexes on these tables extend to include the new columns so
narrow rules can coexist with wide defaults.

`rate_auth_base_price` is **not** given these columns. Its
presence is mode-discriminator evidence — a rate plan either has
seasonal rows (SEASONAL_CONTRACT mode, priced via
`rate_contract_price`) or per-day rows (PER_DAY_STREAM mode, priced
via `rate_auth_base_price`), never both.

`rate_auth_tax_component` is **not** given contract columns. Taxes
are jurisdictional, not contractual. The tax engine (Phase 3
prerequisite) reads them without caring which contract priced the
base.

`rate_auth_allotment` is **not** given a `contract_id`. Allotments
are inventory units shipped by a channel; contract-gated static
inventory (common in paper contracts) is authored as an
**allotment on the rate plan** whose contract scope is implied by
the rate plan's active contract. Explicit contract-scoped
allotments are deferred until a real paper-contract operation asks
for them.

### Where each economic component lives (authored, amended view)

| Concept | Where (SEASONAL_CONTRACT) | Where (PER_DAY_STREAM) |
|---|---|---|
| Room type catalog | `hotel_room_type` (ADR-021 v1) | `hotel_room_type` |
| Rate plan catalog | `hotel_rate_plan` (ADR-021 v1) | `hotel_rate_plan` |
| Meal plan catalog | `hotel_meal_plan` (ADR-021 v1) | `hotel_meal_plan` |
| Occupancy template | `hotel_occupancy_template` (ADR-021 v1) | `hotel_occupancy_template` |
| Child age band | `hotel_child_age_band` (ADR-021 v1) | `hotel_child_age_band` |
| Base rate (per night) | `rate_contract_price` via `(season, date_band)` lookup for each stay night | `rate_auth_base_price` per stay date |
| Extra adult | `rate_auth_extra_person_rule(EXTRA_ADULT)` — optional `contract_id?` / `season_id?` narrowing | `rate_auth_extra_person_rule(EXTRA_ADULT)` — `contract_id` always NULL |
| Extra child | `rate_auth_extra_person_rule(CHILD)` + `hotel_child_age_band` — optional contract/season narrowing | `rate_auth_extra_person_rule(CHILD)` + `hotel_child_age_band` |
| Meal supplement | `rate_auth_meal_supplement` — optional contract/season narrowing | `rate_auth_meal_supplement` |
| Tax components | `rate_auth_tax_component` — jurisdictional, not contract-scoped | `rate_auth_tax_component` |
| Fee components | `rate_auth_fee_component` — optional `contract_id?` | `rate_auth_fee_component` |
| Restrictions | `rate_auth_restriction` — optional `contract_id?` / `season_id?` | `rate_auth_restriction` |
| Cancellation policy | `rate_auth_cancellation_policy` — optional `contract_id?` | `rate_auth_cancellation_policy` |
| Allotment | `rate_auth_allotment` (contract-scope implied by active contract on rate plan) | `rate_auth_allotment` |
| Promotions | `rate_promotion` + scope + rules (this amendment) | `rate_promotion` + scope + rules (this amendment) |

### Promotion overlay for authored rates

Promotions are a **discount overlay applied on top of the authored
composed rate**. They never change the base, never mutate the
contract, and never mutate the per-day stream. They live in their
own tables, are evaluated in a deterministic order, and are
recorded in the pricing trace as distinct lines so reconciliation
and documents can show "base X − promo Y = sell Z".

Promotions apply to authored rates only. Sourced offers carry
supplier-driven discounts inside the composed total — those are
already captured in `offer_sourced_component(DISCOUNT)` when the
supplier exposes them. We do not overlay our own promotions on
sourced offers in this amendment; cross-rate promotional
merchandising on sourced supply is a pricing-rule / merchandising
concern (ADR-004, ADR-009) and deliberately stays out of ADR-021.

#### Entities

- `rate_promotion` — one row per named promotion. Fields: `id`,
  `tenant_id`, `supplier_id`, `canonical_hotel_id?`
  (NULL → supplier-wide; populated → hotel-specific), `contract_id?`
  (NULL → any active contract; populated → narrow to one),
  `code` (human-readable, unique per tenant), `name`, `description?`,
  `discount_kind`, `discount_value NUMERIC(12,4)?` (for PERCENT),
  `discount_amount_minor_units BIGINT?` (for FIXED kinds),
  `discount_currency CHAR(3)?` (for FIXED kinds; else NULL),
  `applies_to ∈ {PRE_SUPPLEMENT_BASE, POST_SUPPLEMENT_PRE_TAX,
  POST_TAX}` (default `POST_SUPPLEMENT_PRE_TAX`),
  `stay_window_from DATE?`, `stay_window_to DATE?`,
  `booking_window_from`, `booking_window_to` (UTC timestamptz;
  nullable for open-ended),
  `min_nights INT?`, `max_nights INT?`,
  `min_advance_days INT?`, `max_advance_days INT?`,
  `priority INT` (default 100; lower priority evaluates first in
  stacking chain),
  `stackable BOOL` (default FALSE),
  `max_total_uses INT?`, `used_count INT` (default 0; advisory —
  decrement at booking confirmation in saga),
  `status ∈ {DRAFT | ACTIVE | PAUSED | EXHAUSTED | EXPIRED |
  ARCHIVED}`, `created_at`, `created_by`, `updated_at`.

  `discount_kind ∈ {PERCENT, FIXED_AMOUNT_PER_NIGHT,
  FIXED_AMOUNT_PER_STAY, NTH_NIGHT_FREE}`. CHECK constraint:
  PERCENT requires `discount_value` in `(0, 1]`, FIXED_* require
  `discount_amount_minor_units > 0` and `discount_currency`,
  NTH_NIGHT_FREE uses `discount_value` as the "N" (e.g. 4 → every
  4th night free).

- `rate_promotion_scope` — narrows the promotion to a subset of
  the rate surface. Multiple rows per promotion, each row narrows
  along one dimension; multiple rows on the same dimension are
  OR'd, rows on different dimensions are AND'd. Fields: `id`,
  `promotion_id`, `scope_dimension ∈ {ROOM_TYPE, RATE_PLAN,
  MEAL_PLAN, SEASON, DATE_BAND}`, plus the dimension-specific
  nullable FKs — `room_type_id?`, `rate_plan_id?`,
  `meal_plan_id?`, `season_id?`, `date_band_id?`. CHECK
  constraint: exactly one non-null FK per row, matching
  `scope_dimension`. Absent scope rows for a dimension means "any
  value on that dimension".

- `rate_promotion_rule` — extensible eligibility, exclusion,
  stacking, and cap rules that don't fit cleanly into columns.
  Fields: `id`, `promotion_id`, `rule_kind ∈ {ELIGIBILITY,
  EXCLUSION, STACKING, CAP}`, `params JSONB` (whitelisted per
  kind at write), `status`. Examples:

  - `ELIGIBILITY`: `{"account_types": ["B2C"]}`,
    `{"reseller_resale_rule_excluded": ["HIDE_PRICE"]}`
  - `EXCLUSION`: `{"excluded_account_ids": ["..."]}`,
    `{"excluded_rate_classes": ["NON_REFUNDABLE"]}`
  - `STACKING`: `{"stackable_with": ["..."]}`,
    `{"never_stack_with": ["..."]}`, `{"max_concurrent": 2}`
  - `CAP`: `{"max_discount_amount_minor_units": 50000,
    "currency": "AED"}`, `{"max_percent": 0.30}`

  Columns on `rate_promotion` cover the common case; rules are
  the escape hatch for the long tail. Unknown params keys are
  rejected at write time.

#### Discount application order

Promotions apply **after** the seasonal base + extra-person +
meal supplements are composed, and **before or after** tax /
fee depending on `applies_to`. The canonical authored pricing
order for a stay night, before the ADR-004 markup chain runs, is:

1. Resolve `season` for the stay night (season_date_band lookup).
2. Read `rate_contract_price` for `(contract, season, room_type,
   rate_plan, meal_plan, occupancy_template)` → `base`.
3. Add `rate_auth_extra_person_rule` results for occupants beyond
   the base template (per occupant, by age band where relevant).
4. Add `rate_auth_meal_supplement` if the booked meal plan
   differs from the contract default.
5. **Apply promotions with `applies_to = PRE_SUPPLEMENT_BASE`** —
   this is rare (it discounts the room rate before supplements
   are added) and mostly exists for edge cases where a promo
   says "X% off the room rate only".
6. Re-evaluate the composition so supplements recalculate off the
   discounted base when the previous step fired (supplements
   defined as percent of base shift; supplements defined as flat
   do not).
7. **Apply promotions with `applies_to = POST_SUPPLEMENT_PRE_TAX`**
   — the common case. Discount is a line in the trace, shown as
   a negative `offer_sourced_component.DISCOUNT`-equivalent row
   on the authored path.
8. Add `rate_auth_tax_component` and `rate_auth_fee_component`
   per their `basis` and `inclusive` flags.
9. **Apply promotions with `applies_to = POST_TAX`** — used for
   final-amount-off promos (e.g. "flat AED 100 off the total
   bill"). Rare. Never used to recompute tax.

Stacking resolution within a single `applies_to` bucket:

- If `stackable = FALSE` (default): only the highest-priority
  eligible promo in the bucket fires (lower `priority` wins).
  Others are trace-recorded as "not applied — preempted by <id>".
- If `stackable = TRUE`: all eligible promos in the bucket fire
  in ascending `priority` order, each applying to the running
  total from the previous step. `rate_promotion_rule(STACKING)`
  rules can further restrict which specific pairs may or may not
  stack.
- `max_concurrent` in a STACKING rule caps how many promos may
  fire in the same bucket across the whole stay.

Every applied promotion produces a line in the booking's
`booking_authored_rate_snapshot` (promotion_id, applied_amount,
currency, applies_to, priority, stacked_with[]) so the trace is
recoverable years later even if the promotion row is later
archived. Promotion rows are soft-deleted via `status = ARCHIVED`;
hard deletion is disallowed.

#### Restrictions remain separate

Nothing in this amendment changes `rate_auth_restriction`.
Restrictions gate whether a rate is **available** at all on a
stay date (STOP_SELL, CTA, CTD, MIN_LOS, MAX_LOS, advance-purchase
windows, release/cutoff). Promotions only change **price** when
the rate is already available. A STOP_SELL wins over the most
generous promotion; an ADVANCE_PURCHASE_MIN fires a non-eligible
error before any promotion is considered.

### Copy-season workflow

Copy-season is a first-class operation on `rate_contract_season`
plus its date bands and prices. It is a **server-side service**,
not a client-side multi-write; correctness requires atomicity.

Behavior:

1. Given `source_season_id`, `target_contract_id` (same contract
   or a different one), optional `date_shift` (e.g. "+365 days"),
   and an operator actor ref, the service:
   a. Creates a new `rate_contract_season` row in
      `target_contract_id` with a caller-provided `code` / `name`.
      Sets `copied_from_season_id = source_season_id`,
      `copied_at = now`, `copied_by_ref = actor`.
   b. Clones each `rate_contract_season_date_band` under the source
      season, shifting `date_from` / `date_to` by `date_shift`.
   c. Clones each `rate_contract_price` under the source season,
      preserving `(room_type_id, rate_plan_id, meal_plan_id,
      occupancy_template_id, base_amount_minor_units, currency)`.
      Only clones rows with `status = ACTIVE`.
   d. Optionally clones `rate_auth_extra_person_rule`,
      `rate_auth_meal_supplement`, `rate_auth_restriction`,
      `rate_auth_cancellation_policy` rows whose `season_id`
      equals `source_season_id` — gated by an operator flag; default
      false (do not clone secondary primitives).
   e. Writes the operation to `AuditLog` (ADR-002/entities.md
      cross-cutting audit) with `kind = 'SEASON_COPY'`, payload
      `{source_season_id, target_season_id, date_shift,
      cloned_bands, cloned_prices, cloned_secondary_primitives}`.
2. All of (a)–(e) run in a single Postgres transaction. Partial
   copies are not allowed.
3. The new season starts in `status = DRAFT`. An operator must
   explicitly activate it — this is the guardrail against an
   accidental copy instantly priced live.

We **do not** add a dedicated `rate_contract_season_copy_log`
table. `copied_from_season_id` on the row plus the `AuditLog`
entry is sufficient; a dedicated table would duplicate the audit
trail without adding a query pattern we need.

### Booking-time snapshot unchanged in shape

`booking_authored_rate_snapshot` is extended (additively) to carry:

- `authoring_mode ∈ {SEASONAL_CONTRACT, PER_DAY_STREAM}`
- `contract_id?`, `contract_code?`, `season_id?`, `season_code?`
  (resolved per stay night — most stays are within one season,
  but a stay crossing a season boundary records per-night season
  resolution in the per-night rows)
- `applied_promotions_jsonb` — structured per-promotion lines as
  described above.

Downstream (documents, rewards, reconciliation) is still
shape-agnostic: it reads the flattened per-night breakdown and
the applied-promotions block uniformly regardless of authoring
mode.

### Contract refinements — adapter `meta`

The adapter `meta` block (ADR-003 + ADR-021 v1) gains:

- `supports_seasonal_contracts: bool` — true for the direct-paper
  adapter and any direct-CRS adapter where we use static-rate
  configuration. False for pure ARI-stream adapters.
- `supports_promotions: bool` — true for the direct-paper adapter
  and any adapter whose upstream allows us to author promotions on
  top. False for pure ARI-stream adapters (which receive already-
  promoted per-day prices).

### Phasing (amendment)

This amendment does **not** change Phase 1. The canonical product
dimensions, mapping tables, and sourced-offer snapshot tables
remain Phase 1 and remain the prerequisite for the Hotelbeds
adapter.

**Phase 3 migrations are extended** to include the seasonal
contract and promotion tables, ordered to land **before** the
direct-paper adapter task within the same phase:

- `rate_contract`
- `rate_contract_season`
- `rate_contract_season_date_band`
- `rate_contract_price`
- `rate_promotion`
- `rate_promotion_scope`
- `rate_promotion_rule`

Plus the additive nullable columns on the four existing
`rate_auth_*` tables listed above. These are additive ALTERs (no
backfill needed because `rate_auth_*` has no rows until the same
Phase 3 migration batch lands).

**No adapter code, no pricing engine code, no service
implementation of copy-season is in scope for this amendment.**
The amendment is doc + migration scope only.

### Open items (amendment)

- **Which adapter owns seasonal authoring as its first use case?**
  Default assumption: `direct-contract (paper)` adapter in Phase 3.
  A direct-CRS adapter may later add a second implementation.
- **Operator UI for contract authoring and copy-season** is out of
  scope here. Phase 3 admin surface will expose these; until then
  contracts are loaded via admin API.
- **Cross-hotel promotions** (one promo spanning multiple hotels
  under one chain) are deliberately out of scope in this
  amendment. A promotion targets exactly one `canonical_hotel_id`
  or the supplier-wide NULL. Multi-hotel promos can be authored
  as N promotions sharing a `code` prefix until real operational
  demand justifies a multi-hotel entity.
- **Promotion budget enforcement** uses `max_total_uses` +
  `used_count` advisory accounting. Strict budget enforcement
  under concurrent confirms is a saga-side concern (idempotent
  decrement in the `CONFIRMED` transaction); spec'd here but
  implemented with the Phase 3 adapter work.
