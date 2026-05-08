# ADR-024: FX strategy — search/display conversion, reference rates, and locked checkout FX

- **Status:** Accepted — partially implemented (C1–C5d.2 shipped 2026-04-28; C5d.3 / C5d.4 / C6 / C7 pending; D4 and D7 reconciled with shipped schema 2026-04-28, D11 added)
- **Date:** 2026-04-27
- **Supersedes:** nothing
- **Amends:** nothing (additive layer; pricing engine and ledger semantics unchanged)
- **Depends on:** ADR-004 (pricing rule model), ADR-010 (booking orchestration),
  ADR-012 (payments / wallet / credit ledger), ADR-014 (loyalty / rewards;
  amended 2026-04-22), ADR-021 (rate/offer model), ADR-022 (authored direct
  pricing core), ADR-023 (authored restrictions/cancellation)

## Context

Slice B7 ("mixed-currency hardening") closed the silent-wrong-sort hazard
in search by making `compareSellingPriceAsc` cross-currency safe and adding
`meta.currencies` to the search response. B7 explicitly did NOT introduce
FX conversion: rates in different currencies sort alphabetically by currency
code rather than by value. The minimal mitigation was deliberate — FX
conversion is its own architectural concern with audit, freshness, fallback,
locking, and provider-selection decisions that did not belong inside a
sorting hardening slice.

This ADR records the three-tier FX strategy the project will use to close
the B7 gap, plus the supporting data model, audit posture, and tenancy
posture. The intent was to lock the architecture decisions before
implementation began.

**Implementation status (2026-04-28):** Implementation is underway and
complete through C5d.2. The original "no code yet" framing applied at
draft time; it is preserved above for historical accuracy. See D10 and
the "Implementation order" section below for the current delivery status.

The system has three distinct FX concerns that prior implementations in
similar projects often conflate. Keeping them apart is load-bearing:

1. **Live display conversion** during search/listing — fast, fresh, paid
   API. Converts a quoted source-currency amount into the user's display
   currency for ranking and presentation.
2. **Reference / fallback rate** — free, official, daily. Used when the
   live provider is unavailable, and as the audit baseline so every applied
   rate can be reasoned about against an independent benchmark.
3. **Locked checkout FX** — at booking confirmation, the rate the customer
   sees must be the rate that settles, regardless of how rates move
   between confirmation and capture. This is a tender-time concern, not a
   pricing concern.

CLAUDE.md §5 and §10 already require that **pricing produces a sellable
amount in source currency, and tender never mutates that amount**. This
ADR honors that boundary: live display conversion is a presentation layer
on top of pricing; locked checkout FX is a tender attribute attached to
the booking. The pricing engine, the wallet ledger, and the recognized-
margin calculation continue to operate in supplier/authored source
currency.

## Decision

### D1. Three-tier FX model

The project uses three FX sources, each with a distinct role. Provisional
defaults locked here:

| Tier | Role | Provider (provisional) | When used |
|---|---|---|---|
| 1 | Live search/display conversion | **Open Exchange Rates (OXR)** | Every search request that requests a display currency different from any rate's source currency |
| 2 | Reference / fallback | **European Central Bank (ECB)** daily reference rates | (a) When OXR is unavailable; (b) as the audit baseline for every applied conversion; (c) for low-traffic cron-driven recompute |
| 3 | Locked checkout FX | **Stripe FX Quotes** | Once at booking confirmation, to bind the customer-facing settlement rate |

The three tiers MUST NOT be substituted for one another. ECB is not a
checkout-lock source (it is a daily reference, not a tradable quote);
Stripe FX Quotes are not a search-time source (Quotes are issued for a
specific payment intent, not for browsing); OXR is not a checkout-lock
source (rates drift between search and capture).

### D2. Tier 1 — Open Exchange Rates as live search/display provider

OXR is the default live FX provider for v1. Selection criteria honored:

- Wide major-pair coverage including AED and other GCC pairs likely needed
  by the direct-contract supply.
- HTTP API with simple latest-rates endpoint suitable for in-process
  caching.
- Commercially available paid plan with TLS, SLA, and contractual freshness.

OXR is referenced via a single internal client wrapper. Search code never
calls OXR directly; it consults a cached rate table populated by that
wrapper. This isolates the provider behind an interface so tier-1 swaps in
the future do not ripple into search.

**Cache freshness window** is intentionally not locked here (see Open
items). The wrapper will expose freshness metadata so callers can decide
whether to use a cached rate or refresh.

### D3. Tier 2 — ECB daily reference snapshot

ECB publishes EUR-base reference rates once per business day. The
project pulls these via a cron job and writes them to a dedicated table
(`fx_rate_snapshot`, schema below). ECB rates are:

- **The audit baseline.** Every applied OXR rate has a same-day ECB rate
  in the snapshot table; the delta between OXR and ECB is the project's
  evidence that OXR rates were within a sane band.
- **The fallback.** When OXR is unavailable (provider outage, exhausted
  quota, network failure), the search service falls back to the most
  recent ECB snapshot rather than refusing to serve. This degrades
  freshness, not availability.
- **Never** the checkout-lock source.

Pulling ECB independently means the project has an FX baseline even if
OXR is never paid for, which keeps the audit story intact during early
operational phases.

### D4. Tier 3 — Locked checkout FX

*Amended 2026-04-28 to reflect shipped implementation.*

At booking confirmation, when the booking's source currency differs
from its charge currency, `BookingFxLockResolver` resolves a locked
rate via the following decision tree:

1. `source_currency == charge_currency` → `NO_LOCK_NEEDED`. No row is
   written; booking confirms in source currency.
2. Stripe FX Quote succeeds → `STRIPE_FX_QUOTE` lock. Stripe quote id
   and TTL are persisted in `booking_fx_lock`.
3. Stripe fails (any error) AND OXR has a fresh DIRECT or INVERSE
   snapshot for the pair → `SNAPSHOT_REFERENCE` lock with
   `provider = 'OXR'`. `fx_rate_snapshot.id` is persisted as the
   auditable trace.
4. Both fail (or Stripe fails and OXR has only a CROSS_RATE) →
   `NO_LOCK_AVAILABLE`. No row is written; the saga confirms in source
   currency. CROSS_RATE is excluded because `booking_fx_lock` is
   single-snapshot per row and a two-leg conversion cannot be honestly
   attributed to one snapshot.

**Two distinct lock kinds can be the authoritative charge-time rate:**
a Stripe FX Quote *or* an OXR-only snapshot reference. Either
satisfies the "rate the customer's card settles at" contract; the
provider-tagged shape is recorded on the row.

ECB is intentionally absent from booking-time lock at three independent
layers: (1) the `booking_fx_lock_provider_chk` CHECK allows only
`('STRIPE', 'OXR')`; (2) `FxRateService.loadOxrOnlyConverter` is called
in the fallback path and passes an empty ECB array; (3) resolver unit
tests assert the OXR-only converter is loaded.

**Stripe FX Quote lifecycle.** `booking_fx_lock` is a write-once
record of *which rate the saga committed to at confirmation time*, not
a mutable state machine. There is no `status`, no `captured_at`, and
no PENDING→CAPTURED transition. The Quote's `lock_expires_at` is
recorded as a historical attribute, not a live constraint enforced
after the row is written. If the Quote expires before confirmation,
the resolver does not "refresh" — the next confirmation attempt
re-resolves from scratch and allocates a new quote id. Capture-time
outcome (did Stripe actually settle at the quoted rate?) is observed
via the PaymentIntent record and Stripe webhooks; correlating that
back to `booking_fx_lock` is an open item (see Open items).

**Refund / cancellation-fee lifecycle.** A booking accumulates further
`booking_fx_lock` rows over its lifetime — one `REFUND` or
`CANCELLATION_FEE` row per such event, derived deterministically from
the booking's `CONFIRMATION` row. See D11.

**Jurisdictional escape hatch.** If Stripe FX Quotes become unavailable
or non-compliant in a jurisdiction (CLAUDE.md §10 flags "Stripe
Treasury is not assumed for UAE"; FX Quotes ride on Stripe Payments
not Treasury, but the constraint is recorded), the `lock_kind` enum
can be extended — with a deliberate edit to the coherence CHECK — for
a third provider, without changing the resolver's contract.

### D5. Server-side display conversion at search response

Display-currency conversion happens **server-side**, inside the search
response assembly, not on the client. Reasons:

- Centralizes provider selection, caching, fallback, and audit attribution.
  Per CLAUDE.md "tenancy is a day-one concern" — moving conversion to the
  client would push provider keys, cache invalidation, and audit duties
  to every channel that consumes the API.
- Keeps `meta.currencies` honest. The B7 contract already declares the
  set of currencies the response is ranked against; a client that converts
  independently can produce a different ranking from a different display
  currency, which breaks the deterministic-sort guarantee.
- Lets the pricing audit trail include FX provenance. A response carries
  the rate that was applied; an independent client cannot.

Search responses gain three additional shapes (concrete shape locked in
the implementation slice, not here):

- A request input `displayCurrency: CurrencyCode` (optional). When absent,
  rates are returned in their source currencies as today (B7 behavior is
  preserved as the no-conversion baseline).
- A response per-rate field exposing both the source-currency amount and
  the converted display amount when conversion was applied.
- A response meta-level field exposing the applied FX provider, applied
  rate(s), and timestamp for auditability.

Existing single-currency responses are unchanged when `displayCurrency`
is omitted — additivity is preserved.

### D6. Source currency is ledger truth; converted display amount is presentation only

The wallet ledger (ADR-012) records `source_cost` in supplier/authored
source currency. This does not change. The converted display amount that
appears in search responses is a presentation transformation; it is not
written to `LedgerEntry`, not written to `recognized_margin` (ADR-014
amendment), and never used in commission/kickback math.

Recognized-margin computation continues to run on source-currency amounts
exactly as today. This is an explicit invariant of the B7→C transition:
**adding FX must not perturb the rewards or kickback math**.

### D7. Audit storage model

Four storage primitives. Each is its own table; conflating them is
forbidden.

```
fx_rate_snapshot (
  id              CHAR(26)     PK
  provider        VARCHAR(16)  NOT NULL  -- 'ECB' | 'OXR' | future
  base_currency   CHAR(3)      NOT NULL  -- e.g. 'EUR' for ECB
  quote_currency  CHAR(3)      NOT NULL
  rate            NUMERIC(18,8) NOT NULL
  observed_at     TIMESTAMPTZ  NOT NULL  -- when provider published
  fetched_at      TIMESTAMPTZ  NOT NULL  -- when we wrote the row
  raw_payload_ref VARCHAR(256)           -- object-storage reference for the raw provider response
  UNIQUE (provider, base_currency, quote_currency, observed_at)
)
```

Used by both ECB daily snapshots and OXR cached quotes. The
`raw_payload_ref` points to an object-storage blob containing the
provider's exact response, so an applied rate can be reconstructed from
provider truth, not from our derivative row.

```
fx_application (
  id                   CHAR(26)     PK
  applied_at           TIMESTAMPTZ  NOT NULL
  provider             VARCHAR(16)  NOT NULL  -- 'OXR' | 'ECB' (fallback)
  source_currency      CHAR(3)      NOT NULL
  display_currency     CHAR(3)      NOT NULL
  rate                 NUMERIC(18,8) NOT NULL
  rate_snapshot_id     CHAR(26)     FK → fx_rate_snapshot
  application_kind     VARCHAR(16)  NOT NULL  -- 'SEARCH' | 'BOOKING_DISPLAY'
  request_correlation_ref VARCHAR(64)         -- searchId or bookingId, opaque
)
```

`fx_application` is append-only. SEARCH applications can be retained on
a sliding TTL (provisional default 30 days; see Open items). BOOKING_DISPLAY
applications are retained for the booking's full retention lifetime.

*Amended 2026-04-28 to reflect shipped C5a schema.*

```
booking_fx_lock (
  id                CHAR(26)      PK
  booking_id        CHAR(26)      NOT NULL  FK → booking_booking
  applied_kind      VARCHAR(16)   NOT NULL  -- 'CONFIRMATION' | 'REFUND' | 'CANCELLATION_FEE'
  lock_kind         VARCHAR(32)   NOT NULL  -- 'STRIPE_FX_QUOTE' | 'SNAPSHOT_REFERENCE'
  source_currency   CHAR(3)       NOT NULL
  charge_currency   CHAR(3)       NOT NULL  CHECK (charge_currency <> source_currency)
  rate              NUMERIC(18,8) NOT NULL  CHECK (rate > 0)   -- 1 source = N charge
  source_minor      BIGINT        NOT NULL  CHECK (>= 0)
  charge_minor      BIGINT        NOT NULL  CHECK (>= 0)
  provider          VARCHAR(16)   NOT NULL  -- 'STRIPE' | 'OXR'  (ECB intentionally absent)
  provider_quote_id VARCHAR(64)             -- NOT NULL when lock_kind='STRIPE_FX_QUOTE', else NULL
  rate_snapshot_id  CHAR(26)      FK → fx_rate_snapshot
                                            -- NOT NULL when lock_kind='SNAPSHOT_REFERENCE', else NULL
  expires_at        TIMESTAMPTZ             -- NOT NULL when lock_kind='STRIPE_FX_QUOTE', else NULL
  applied_at        TIMESTAMPTZ   NOT NULL DEFAULT now()

  -- Single CHECK ties (lock_kind, provider, *_id, expires_at) into
  -- one of two valid shapes. Adding a third lock kind requires
  -- editing this CHECK deliberately — silent drift is impossible.
  CHECK (
    (lock_kind='STRIPE_FX_QUOTE'    AND provider='STRIPE' AND provider_quote_id IS NOT NULL
       AND rate_snapshot_id IS NULL    AND expires_at IS NOT NULL)
    OR
    (lock_kind='SNAPSHOT_REFERENCE' AND provider='OXR'    AND provider_quote_id IS NULL
       AND rate_snapshot_id IS NOT NULL AND expires_at IS NULL)
  )
)

-- Schema-level idempotency for the confirmation transaction.
-- A retry that re-issues the confirm INSERT fails with a
-- unique_violation, which the saga interprets as "already confirmed."
CREATE UNIQUE INDEX booking_fx_lock_confirmation_uq
ON booking_fx_lock (booking_id) WHERE applied_kind='CONFIRMATION';
```

`booking_fx_lock` is **append-only and per-row immutable**. A booking
accumulates one `CONFIRMATION` row at confirm time and zero-or-more
`REFUND` / `CANCELLATION_FEE` rows over its lifetime; rows are never
mutated. There is no `status` field and no `captured_at` field — the
row records what the saga committed to write, not what later happened
on the wire. Capture outcome is observed via `PaymentIntent` + Stripe
webhooks, not by updating this row. No Stripe `raw_payload_ref` is
stored: the Stripe quote id is the canonical reference, and dual-
writing Stripe response bodies per booking would be material storage
cost for low audit value.

The canonical schema definition lives in the migration
`infra/migrations/fx/20260503000001_booking_fx_lock.ts`.

```
fx_provider_credentials (
  id          CHAR(26)     PK
  provider    VARCHAR(16)  NOT NULL UNIQUE
  api_key_ref VARCHAR(256) NOT NULL  -- secret manager reference, NOT the key itself
  is_active   BOOLEAN      NOT NULL
)
```

Centralizes provider credentials so the runtime never reads them from
environment variables directly. `api_key_ref` resolves through the same
secret-manager seam used elsewhere in the project.

### D8. Tenancy: platform-wide provider in v1, no per-tenant override

V1 uses a single platform-wide tier-1 provider (OXR). No `tenant_id`
column is added to `fx_rate_snapshot` or `fx_application` for the
provider-selection axis. Reasons:

- The v1 customer base is single-tenant; per-tenant FX provider selection
  is hypothetical.
- Multiplying provider keys per tenant before there is a real second
  tenant is exactly the premature-abstraction trap CLAUDE.md §7 warns
  against.

When a real second tenant requires its own FX provider, a follow-up ADR
defines the tenant-scoping model. The shape change at that point is
expected to be small (add `tenant_id NULL` to `fx_provider_credentials`
and a resolution rule); the cost of deferring is bounded.

### D9. Where this code lives

A new package `packages/fx` hosts the pure conversion logic (rate lookup,
fallback, application), mirroring the `packages/pricing` layout. The
service-layer wrapper that talks to OXR / ECB / Stripe lives under
`apps/api/src/fx/` (Nest module + repository + clients).

Search service depends on the FX module via DI; the FX module exposes a
narrow `convert({ amount, sourceCurrency, displayCurrency, asOf })`
contract returning both the converted amount and the FX application id
that backs it.

Booking saga depends on a separate `pinFxLock({ bookingId, ... })`
contract on the same module; the FX module owns the Stripe Quote round
trip and the `booking_fx_lock` write.

### D10. Implementation status

This ADR was originally locked at the architecture/data-model level with no
code. As of 2026-04-28, slices C1 through C5d.2 are shipped:

- **C1** (schema migration: `fx_rate_snapshot`, `fx_application`, `booking_fx_lock`) — done
- **C2** (ECB daily snapshot fetcher: `EcbFetcherService`, cron-driven) — done
- **C3** (OXR client + `FxRateService` with ECB fallback, `packages/fx` pure logic) — done
- **C4** (server-side display conversion in search: `displayCurrency`, `displayPrice` per rate, `fxApplication` meta) — done
- **C5a** (`booking_fx_lock` schema with `lock_kind`, `applied_kind`, coherence CHECK, partial unique index) — done
- **C5b** (Stripe FX Quote client, `BookingFxLockRepository.insert`, `BookingFxLockResolver`) — done
- **C5c.1–4** (booking module shell, confirm transaction wiring, internal `POST /internal/bookings/:id/confirm`, structured observability) — done
- **C5d.1** (`BookingFxLockRepository.findConfirmation`) — done
- **C5d.2** (shared rate-math, `deriveRefundLockInput`, `BookingFxLockApplier.applyRefund`) — done

Pending: **C5d.3** (refund saga wiring), **C5d.4** (refund observability),
**C6** (full refund/cancel path), **C7** (recognized-margin currency policy).

D4 and D7 were reconciled with the shipped schema on 2026-04-28 (see
amendment notes inline in those sections, plus D11).

### D11. `applied_kind` history model and copy-forward refund design

*Added 2026-04-28.*

`booking_fx_lock` is the booking's **full FX history**, not just the
confirmation pin. The `applied_kind` column distinguishes
`CONFIRMATION` (one per booking, enforced by partial unique index) from
`REFUND` / `CANCELLATION_FEE` (zero-or-more, unconstrained).

The locked rule for refund and cancellation-fee FX is **copy-forward
from CONFIRMATION, never re-quote**. `BookingFxLockApplier.applyRefund`:

1. Reads the booking's unique `CONFIRMATION` row via
   `BookingFxLockRepository.findConfirmation`.
2. If absent → returns `NO_CONFIRMATION_LOCK` and writes no row. (The
   booking confirmed in source currency or via `NO_LOCK_AVAILABLE`;
   there is no FX context to copy forward. Refunds in that case post
   to the ledger in source currency only.)
3. If present → derives a `BookingFxLockInput` whose `rate`,
   `lock_kind`, `provider`, and provider-specific id (`provider_quote_id`
   or `rate_snapshot_id`) are copied verbatim, and whose `charge_minor`
   is `round(refund_source_minor × confirmation.rate)` using the same
   `applyRateToMinor` half-away-from-zero BigInt rounding as the
   resolver (shared in `apps/api/src/fx/booking-fx-rate-math.ts`).
   Writes via `BookingFxLockRepository.insert`.

The applier depends only on the repository — no Stripe client, no
`FxRateService`, no fresh spot rate. This makes booking economics
reversible at a fixed rate over the booking's lifetime, which is the
whole point of the lock.

**Why one table rather than a separate `booking_fx_refund` table:** the
history of FX events on a booking is naturally one append-only ledger.
Splitting it would force every reconciliation query to UNION two
tables and would lose the schema-level guarantee that REFUND rows
match CONFIRMATION's `lock_kind` / `provider` shape — the same
coherence CHECK applies row-wise regardless of `applied_kind`.

## Consequences

- The pricing engine, wallet ledger, and recognized-margin calculation
  continue to operate purely in source currency. FX is layered on top
  rather than threaded through.
- `SearchResponseMeta.currencies` (B7) remains meaningful in v1 even when
  display conversion is applied: the source-currency set is still
  reported so consumers can audit conversions.
- Booking-time pinned FX is part of the booking-confirmation transaction;
  the saga (ADR-010) gains one more durable write at confirmation. This
  is alongside the booking-time cancellation snapshot deferred from B6
  (CLAUDE.md §11 item 11) — both pinning operations co-exist in the same
  transaction.
- Refund handling (cancellation flows): the locked rate from
  `booking_fx_lock` is the rate at which refunds settle, not a fresh
  rate (see D11). This avoids double-FX exposure. Per-jurisdiction
  legal confirmation of the locked-rate policy remains an open item.
- Operational dependency on three external sources (OXR, ECB, Stripe).
  ECB is free and high-availability; OXR has a paid SLA; Stripe is
  already a dependency. Net new operational risk is small.
- Provider key management: tier 1 and tier 3 require credentials. Both
  flow through `fx_provider_credentials` + the secret-manager seam, not
  environment variables.

## Open items

These remain genuinely open after this ADR; provisional defaults DO NOT
cover them. Each must be answered before its corresponding slice ships.

- **OXR commercial plan selection.** Free / Developer / Enterprise tiers
  differ on freshness, currency coverage, request quota, and SLA. The
  commercial choice is downstream of finance + ops, not of this ADR.
- **OXR cache TTL.** Provisional intuition: 15 minutes for major pairs,
  60 minutes for thin pairs, snap-to-ECB on quota exhaustion. Concrete
  values lock in the slice that implements the wrapper.
- **Display-currency selection rules.** Three plausible sources for the
  display currency: (a) `req.displayCurrency` if present; (b) account
  default if set; (c) tenant default. Resolution order is not yet locked.
- ~~**Failure mode when both OXR and ECB are unusable.**~~ **RESOLVED (C3/C4, 2026-04-28):**
  Option (i) — degrade to B7 mixed-currency response (no conversion,
  source-currency amounts, no `displayPrice` fields). `FxRateService`
  returns a `NOT_CONVERTED` result; search assembler omits `displayPrice`.
  Booking path: `NO_LOCK_AVAILABLE`, booking confirms in source currency
  with no `booking_fx_lock` row written.
- **Currency pairs with no ECB cross-rate.** ECB publishes EUR-base
  rates; deriving e.g. AED→THB via two hops introduces compounded error.
  Whether the project supports such pairs in v1, and via which provider,
  is open.
- **`recognized_margin` under FX.** ADR-014 amendment runs reward and
  kickback math on `recognized_margin`. With FX in play, margin in
  source currency is the only meaningful number; this ADR assumes it
  stays in source currency. Confirmation from rewards/finance owner
  needed before slice C5.
- ~~**Refund / cancellation FX.**~~ **RESOLVED (C5d plan + C5d.1–C5d.2, 2026-04-28):**
  Confirmed: refund/cancellation-fee rows copy forward the CONFIRMATION
  row's locked rate. `BookingFxLockApplier.applyRefund` applies
  `derived_charge_minor = round(refund_source_minor × confirmation.rate)`
  using the same half-away-from-zero rounding as the confirmation path.
  No fresh spot rate is ever fetched for a refund or cancellation fee.
  Legal/finance confirmation of the locked-rate policy per jurisdiction
  (UAE explicit; EU implicit) remains open — the implementation
  enforces the locked-rate default; a jurisdiction override would
  require a follow-up ADR amendment.
- **Stripe Treasury / Connect compatibility.** CLAUDE.md §10 flags
  "Stripe Treasury is not assumed for UAE." Stripe FX Quotes ride on
  Stripe Payments, not Treasury, so this ADR does not assume Treasury.
  Confirmation from the Stripe integration owner needed before slice C5.
- **Audit retention windows.** `fx_application` for SEARCH: 30 days
  provisional; `fx_application` for BOOKING_DISPLAY: full booking
  retention; `fx_rate_snapshot`: indefinite (small row, high audit
  value). All values to be confirmed against legal/regulatory retention
  requirements (which have not yet been gathered).
- **Multi-leg / cart FX.** When a future cart aggregates rates from
  multiple suppliers in different source currencies, does the cart
  total live in display currency, source currency per leg, or both?
  Out of v1 scope but flagged so this ADR is not contradicted later.
- **`booking_fx_lock` capture-outcome correlation.** The shipped table
  records the rate the saga committed to at confirmation time, not the
  capture-time outcome. There is no link from `booking_fx_lock` to the
  PaymentIntent / Stripe webhook that confirms the customer's card
  actually settled at that rate. If a locked Stripe Quote expires or
  settles at a different rate, the discrepancy is not observable from
  this table alone. Resolution options: (a) add a `capture_event_id`
  correlation column joining the future PaymentIntent record;
  (b) leave correlation to the saga + observability layer with
  documented join paths. Decision deferred to the slice that wires
  PaymentIntent capture.

## Implementation order

Slices marked **[done]** are shipped as of 2026-04-28. Slices marked
**[pending]** require explicit authorization before starting.

- **[done] Slice C1 — FX schema migration.** `fx_rate_snapshot`,
  `fx_application`, initial `booking_fx_lock` tables.
- **[done] Slice C2 — ECB daily snapshot fetcher.** `EcbFetcherService`
  cron job writing `fx_rate_snapshot` rows.
- **[done] Slice C3 — OXR client + FxRateService + ECB fallback.**
  `packages/fx` pure logic, `OxrClient`, `FxRateService` with two-tier
  fallback. Includes C3a (hoisted `minorUnitExponent` to `@bb/domain`)
  and C3b (OXR HTTP client + `FxRateService`).
- **[done] Slice C4 — Server-side display conversion in search response.**
  `displayCurrency` request input, `displayPrice` per rate, `fxApplication`
  meta, FX-aware sort, `fx_application` audit rows (DIRECT/INVERSE only;
  CROSS_RATE gap documented).
- **[done] Slice C5 — Booking-time FX lock (decomposed into sub-slices):**
  - **[done] C5a** — `booking_fx_lock` schema: `lock_kind`, `applied_kind`,
    coherence CHECK, partial unique index.
  - **[done] C5b** — Stripe FX Quote client, `BookingFxLockRepository.insert`,
    `BookingFxLockResolver` (Stripe → OXR-only fallback decision tree).
  - **[done] C5c.1** — booking module shell, `Queryable` interface.
  - **[done] C5c.2** — booking confirm transaction wiring
    (`BookingService.confirm`).
  - **[done] C5c.3** — internal `POST /internal/bookings/:id/confirm`
    endpoint + `InternalAuthGuard`.
  - **[done] C5c.4** — structured observability logging on the confirm path.
  - **[done] C5d.1** — `BookingFxLockRepository.findConfirmation`.
  - **[done] C5d.2** — shared `booking-fx-rate-math`, `deriveRefundLockInput`,
    `BookingFxLockApplier.applyRefund`.
  - **[pending] C5d.3** — refund saga wiring (no refund saga exists yet).
  - **[pending] C5d.4** — refund-path observability (mirror C5c.4 pattern).
- **[pending] Slice C6 — Full refund/cancel FX path end-to-end.** Wires
  C5d.3/C5d.4 into the cancellation/refund saga. Depends on Phase 2
  refund saga existing.
- **[pending] Slice C7 — Recognized-margin currency policy under FX.**
  Confirms and locks the recognized-margin currency invariant in the rewards
  module, with explicit tests. Scope: documentation + tests, ideally no
  behavior change.
