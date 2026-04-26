# ADR-023: Authored direct pricing — restrictions and cancellation policies

- **Status:** Accepted
- **Date:** 2026-04-26
- **Supersedes:** nothing
- **Amends:** ADR-021 (adds implementation-specific design for
  `rate_auth_restriction` and `rate_auth_cancellation_policy` on the
  authored path, including contract/season scoping rules and DB vs
  service-layer enforcement boundaries)
- **Depends on:** ADR-021, ADR-022

## Context

ADR-021 defined `rate_auth_restriction` and `rate_auth_cancellation_policy`
as Phase 3 tables and listed optional `contract_id?` / `season_id?` nullable
FK columns on each so that restrictions and policies can be narrowed to a
specific contract or season.

ADR-022 (Phase A) deferred these two tables entirely — Phase A's six-table
scope was sufficient for authoring and pricing a complete seasonal contract
without restrictions or cancellation policies. However, several implementation
decisions about how these tables will integrate with the Phase A schema need
to be recorded now, before Phase B work begins, so that the design is not
re-derived from scratch during implementation.

This ADR also records the enforcement boundary decisions: which invariants
belong in the DB layer (CHECK constraints) and which belong in the service
layer, following the same pattern established for non-overlap in ADR-022.

## Decision

### D1. Two tables, same contract-scoping pattern as Phase A

**`rate_auth_restriction`** and **`rate_auth_cancellation_policy`** each
follow the Phase A pattern: they carry an optional `contract_id` and an
optional `season_id`, and the composite FK enforcement from ADR-022 (D3)
applies when these columns are non-null.

```
rate_auth_restriction (
  id                CHAR(26)     PK
  tenant_id         CHAR(26)     NOT NULL  FK → core_tenant
  supplier_id       CHAR(26)     NOT NULL  FK → supply_supplier
  canonical_hotel_id CHAR(26)    NOT NULL  FK → hotel_canonical
  rate_plan_id      CHAR(26)               FK → hotel_rate_plan
  room_type_id      CHAR(26)               FK → hotel_room_type
  contract_id       CHAR(26)               FK → rate_auth_contract
  season_id         CHAR(26)               FK → rate_auth_season (id alone)
  stay_date         DATE         NOT NULL
  restriction_kind  VARCHAR(32)  NOT NULL  -- see RestrictionKind enum
  params            JSONB        NOT NULL  -- whitelisted per kind
  effective_from    TIMESTAMPTZ  NOT NULL
  effective_to      TIMESTAMPTZ            -- null = open-ended
  superseded_by_id  CHAR(26)               FK → rate_auth_restriction
  created_at        TIMESTAMPTZ  NOT NULL
)
```

```
rate_auth_cancellation_policy (
  id                 CHAR(26)    PK
  tenant_id          CHAR(26)    NOT NULL  FK → core_tenant
  supplier_id        CHAR(26)    NOT NULL  FK → supply_supplier
  canonical_hotel_id CHAR(26)    NOT NULL  FK → hotel_canonical
  rate_plan_id       CHAR(26)              FK → hotel_rate_plan
  contract_id        CHAR(26)              FK → rate_auth_contract
  policy_version     SMALLINT    NOT NULL
  windows_jsonb      JSONB       NOT NULL
  refundable         BOOLEAN     NOT NULL
  effective_from     TIMESTAMPTZ NOT NULL
  effective_to       TIMESTAMPTZ           -- null = open-ended
  superseded_by_id   CHAR(26)              FK → rate_auth_cancellation_policy
  created_at         TIMESTAMPTZ NOT NULL
)
```

`season_id` is **not** a column on `rate_auth_cancellation_policy`. Cancellation
policies in real paper contracts apply at the rate-plan level across all
seasons in the contract, not per season. A per-season cancellation override
is an edge case that, if needed, can be expressed as a narrow
contract-scoped row.

### D2. Composite FK for non-null season_id in rate_auth_restriction

When `season_id IS NOT NULL` in `rate_auth_restriction`, the composite FK
constraint `(season_id, contract_id)` → `rate_auth_season(id, contract_id)`
applies. This reuses the `UNIQUE(id, contract_id)` target on
`rate_auth_season` from ADR-022 (D3) and enforces that the season belongs to
the referenced contract at the DB layer.

When `season_id IS NULL`, the restriction applies to all seasons in the
contract (if `contract_id` is set) or to all seasons across all contracts
for the `(supplier, hotel, rate_plan)` combination (if `contract_id` is also
NULL). MATCH SIMPLE semantics (ADR-022 D4) handle both cases without a
custom NULL-aware FK declaration.

### D3. Restriction kinds enum

The authoritative list, persisted as the `restriction_kind` column value and
validated by a DB CHECK constraint:

```
STOP_SELL              — no availability on this stay date
CTA                    — closed to arrival
CTD                    — closed to departure
MIN_LOS                — params: { "min_los": <int> }
MAX_LOS                — params: { "max_los": <int> }
ADVANCE_PURCHASE_MIN   — params: { "days": <int> }
ADVANCE_PURCHASE_MAX   — params: { "days": <int> }
RELEASE_HOURS          — params: { "hours": <int> } — channel-manager release window
CUTOFF_HOURS           — params: { "hours": <int> } — supplier-side cutoff
```

STOP_SELL, CTA, CTD have no params; the CHECK constraint enforces
`params = '{}'` for these kinds.

MIN_LOS, MAX_LOS, ADVANCE_PURCHASE_MIN, ADVANCE_PURCHASE_MAX,
RELEASE_HOURS, CUTOFF_HOURS each require exactly the key listed above in
params; unknown keys are rejected at write time by the service layer (not the
DB). The DB CHECK validates `restriction_kind` values only; params validation
is the service's responsibility because JSONB structure checks in PostgreSQL
are verbose and hard to maintain.

### D4. Scope resolution at pricing time: most-specific-wins

When the pricing evaluator resolves a restriction for a given
`(stay_date, supplier, hotel, rate_plan, room_type)`:

1. `contract_id IS NOT NULL AND season_id IS NOT NULL` — contract + season
   scope (most specific)
2. `contract_id IS NOT NULL AND season_id IS NULL` — contract scope
3. `contract_id IS NULL AND supplier_id + hotel + rate_plan match` —
   supplier-level default

Higher specificity wins. If two restrictions of equal specificity with the
same `restriction_kind` and overlapping `effective_from`/`effective_to` both
match, the one with the lower (earlier) `id` wins. The evaluator treats this
as a data authoring problem and does not raise an error.

STOP_SELL, CTA, CTD are boolean: the presence of a matching active row means
the restriction applies, regardless of params. All other kinds use the params
value from the winning row.

### D5. Cancellation policy versioning

`rate_auth_cancellation_policy.policy_version` is an integer that increments
each time a new policy is authored for the same
`(tenant, supplier, hotel, rate_plan, contract)` scope.
`superseded_by_id` chains to the newer version.

The pricing evaluator reads the row with the highest `policy_version` whose
`effective_from <= now()` and `effective_to IS NULL OR effective_to >= now()`.

Booking-time snapshots (`booking_cancellation_policy_snapshot`) pin the
`policy_version` resolved at confirmation. A subsequent policy update does
not rewrite existing booking snapshots; corrections flow through ADR-016
credit/debit notes.

`windows_jsonb` is a structured timeline:

```json
[
  {
    "from_hours_before": 72,
    "to_hours_before": 0,
    "fee_type": "PERCENT_OF_TOTAL",
    "fee_value": 100
  },
  {
    "from_hours_before": null,
    "to_hours_before": 72,
    "fee_type": "FLAT",
    "fee_value": 0,
    "fee_currency": null
  }
]
```

`fee_type ∈ { PERCENT_OF_TOTAL, FLAT, FIRST_NIGHT }`. Windows are ordered
by `from_hours_before` descending (furthest in advance first). A NULL
`from_hours_before` means "any time before the adjacent window". A NULL
`fee_value` or 0 means free cancellation in that window.

The service validates the window array structure at write time. The DB stores
it as JSONB without a schema CHECK — maintaining a JSONB schema check in SQL
is impractical for a variable-length array; the service is the authoritative
validator.

### D6. Restrictions gate availability; promotions change price

This boundary is explicitly enforced in the pricing evaluator:

- `rate_auth_restriction` rows are evaluated **before** the pricing chain
  runs. If any active restriction on the stay dates produces STOP_SELL, CTA,
  CTD, or a LOS / advance-purchase violation, the evaluator returns a
  `RateUnavailableError`, and no price is computed.
- Promotions (`rate_promotion`, ADR-021 amendment) are evaluated **after**
  the base price is composed and availability is confirmed. A promotion
  cannot override a restriction.

No code path applies a promotion to a stay date that has a blocking
restriction. This ordering is not a runtime policy — it is an architectural
invariant of the evaluator's call sequence.

### D7. INACTIVE contracts block restriction and cancellation policy writes

The service enforces the same INACTIVE guard that ADR-022 (D7) establishes
for seasons and child age bands: before writing a restriction or cancellation
policy row scoped to a contract, the service calls
`ContractRepository.findById(contractId, tenantId)` and rejects the write
with `BadRequestException` if the contract is INACTIVE.

Restrictions and policies with `contract_id IS NULL` (supplier-level
defaults) are not contract-lifecycle-gated; they are managed independently.

### D8. Hard delete is not permitted for restriction or cancellation policy rows

`rate_auth_restriction` and `rate_auth_cancellation_policy` rows are
**superseded, not deleted**. The service sets `superseded_by_id` on the old
row and creates a new row. The old row remains in the table for audit and
for repricing historical bookings that referenced it.

This differs from seasons and child age bands (ADR-022 D9), which are
hard-deleted. Restrictions and cancellation policies are lightweight and
carry `effective_from`/`effective_to` windows, so supersede-chaining is the
correct immutability mechanism. Seasons have natural FK guards that prevent
deletion while rates reference them; restrictions have no such referencing
child tables.

### D9. Phase B migration scope

The Phase B migration adds exactly these two tables. No other changes to
Phase A tables are required — the Phase A schema already has the FK targets
needed (`rate_auth_season(id, contract_id)`, `rate_auth_contract(id)`,
`hotel_rate_plan(id)`, `hotel_room_type(id)`).

Phase B does **not** add the optional `contract_id?` / `season_id?`
columns to the broader `rate_auth_*` tables described in ADR-021's amendment
(`rate_auth_extra_person_rule`, `rate_auth_meal_supplement`, etc.) — those
columns belong to a future slice after the restriction infrastructure is live
and tested.

## Consequences

- The pricing evaluator has a defined call sequence: resolve restrictions →
  check availability → compose price → apply promotions. Any future
  evaluator code must maintain this order.
- Cancellation policy rows are append-only from the service's perspective;
  the only mutation is setting `superseded_by_id`. Deleting a policy row is
  forbidden.
- Booking-time snapshots (`booking_cancellation_policy_snapshot`) must
  record the `policy_version` and a copy of `windows_jsonb` resolved at
  confirmation, not a FK to the live policy row. This is consistent with
  ADR-021's immutable-snapshot requirement.
- Restriction `params` validation is a service-layer responsibility. Any
  new `restriction_kind` added to the enum requires a corresponding params
  schema entry in the service validator.

## Open items

- **Restriction bulk import** — paper contracts often specify multiple
  stop-sell or LOS dates at once. A bulk-write API path needs the same
  non-overlap and contract-INACTIVE guards but without a per-row
  transaction cost. Deferred to Phase B implementation.
- **Restriction effective_to = NULL (open-ended)** — a STOP_SELL with no
  end date is valid, but the pricing evaluator must handle it correctly.
  The query filter `(effective_to IS NULL OR effective_to >= now())` is
  specified here; the evaluator implementation must not assume a non-null
  upper bound.
- **Channel-manager ARI restrictions** — `RELEASE_HOURS` and `CUTOFF_HOURS`
  are primarily needed for channel-manager push sources, not paper contracts.
  They are included in the enum now so that the restriction model is unified,
  but no channel-manager adapter writes them until Phase 3 (ADR-013).
