# ADR-024: FX strategy — search/display conversion, reference rates, and locked checkout FX

- **Status:** Proposed (provisional — decision-pending skeleton; provisional defaults locked, no code yet)
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
posture. **It does NOT introduce code.** Implementation lands in a
subsequent set of slices (see "Implementation order" below). The intent is
to lock the architecture decisions now so that, when implementation begins,
no further architectural debate is required.

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

### D4. Tier 3 — Stripe FX Quotes for locked checkout FX

At booking confirmation, when the booking's settlement currency differs
from the supplier source currency, the booking saga (ADR-010) requests a
Stripe FX Quote bound to the payment intent for that booking. The Quote
is persisted in `booking_fx_lock` (schema below) and is the sole rate the
customer's card is charged at. Tier-1 and tier-2 rates are NOT
authoritative once a Quote has been pinned.

Stripe FX Quote semantics: the Quote is valid for a window (typically
minutes); the booking saga must capture (or void) within that window. If
the Quote expires, the saga refreshes it before capture. The booking
record records which Quote was active at capture-success time.

If Stripe Connect/Treasury constraints later block FX Quotes for a given
jurisdiction (e.g. UAE settlement; CLAUDE.md §10 flags "Stripe Treasury
is not assumed for UAE"), tier 3 is replaced by an alternative
locked-rate path documented in a follow-up ADR. The booking saga keeps a
single contract with the FX layer (`pinFxLock(booking)` returning a
provider-tagged record); the swap is internal to that layer.

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

```
booking_fx_lock (
  id                CHAR(26)     PK
  booking_id        CHAR(26)     NOT NULL  FK → booking
  provider          VARCHAR(16)  NOT NULL  -- 'STRIPE_FX_QUOTE' (today)
  provider_quote_ref VARCHAR(128) NOT NULL  -- e.g. Stripe Quote id
  source_currency   CHAR(3)      NOT NULL
  settlement_currency CHAR(3)    NOT NULL
  rate              NUMERIC(18,8) NOT NULL
  quoted_at         TIMESTAMPTZ  NOT NULL
  expires_at        TIMESTAMPTZ  NOT NULL
  captured_at       TIMESTAMPTZ            -- null until capture-success binds
  status            VARCHAR(16)  NOT NULL  -- 'PENDING' | 'CAPTURED' | 'EXPIRED' | 'VOIDED'
  raw_payload_ref   VARCHAR(256)
)
```

`booking_fx_lock` is part of the booking-confirmation transaction. A
capture-success message updates `captured_at` and `status`; expiry/void
follow the same status field. This row is immutable except for those
status transitions; never amended in place.

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

### D10. No code yet — implementation deferred to subsequent slices

This ADR is locked at the architecture/data-model level. No source files,
migrations, or modules are added by accepting this ADR. The implementation
order is recorded under "Implementation order" below; each slice will
have its own brief and acceptance criteria.

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
  rate. This avoids double-FX exposure but is flagged as an open item
  for legal/finance review.
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
- **Failure mode when both OXR and ECB are unusable.** Two options:
  (i) degrade to B7 mixed-currency response (no conversion, alphabetical
  sort, `meta.fxFallback='NONE'`); (ii) refuse the search with a 503.
  Recommendation is (i) for resilience; needs explicit confirmation.
- **Currency pairs with no ECB cross-rate.** ECB publishes EUR-base
  rates; deriving e.g. AED→THB via two hops introduces compounded error.
  Whether the project supports such pairs in v1, and via which provider,
  is open.
- **`recognized_margin` under FX.** ADR-014 amendment runs reward and
  kickback math on `recognized_margin`. With FX in play, margin in
  source currency is the only meaningful number; this ADR assumes it
  stays in source currency. Confirmation from rewards/finance owner
  needed before slice C5.
- **Refund / cancellation FX.** Provisional default: refund settles at
  the `booking_fx_lock` rate, not at a fresh rate. Legal and finance
  must confirm this matches consumer-protection requirements per
  jurisdiction (UAE explicit; EU implicit).
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

## Implementation order (post-ADR slices)

These are the slices that implement this ADR. Each is its own brief; do
not start any of them without explicit authorization.

- **Slice C1 — FX schema migration only.** Adds the four tables in D7.
  No service code, no clients. Migrations + DB constraints only.
- **Slice C2 — ECB daily snapshot fetcher.** Cron-driven job that pulls
  ECB reference rates and writes `fx_rate_snapshot` rows. Pure write
  path; no consumer yet.
- **Slice C3 — OXR client + cache + ECB fallback.** The `packages/fx`
  module's pure rate-lookup + fallback logic, plus the Nest-side OXR
  client. No search integration yet.
- **Slice C4 — Server-side display conversion in search response.**
  Wires C3 into the search service. Adds `req.displayCurrency`,
  per-rate converted amounts, `meta.fxApplication`. Existing single-
  currency / no-conversion responses unchanged when `displayCurrency`
  is omitted.
- **Slice C5 — Stripe FX Quote pinning at booking confirmation.**
  Adds the booking saga's call to `pinFxLock`, writes `booking_fx_lock`
  in the confirmation transaction. Coordinates with the deferred
  booking-time cancellation snapshot work (CLAUDE.md §11 item 11) —
  both pinning operations land together in one slice if scope allows,
  or as adjacent slices.
- **Slice C6 — Refund/cancel FX behavior.** Implements the chosen
  policy from the open-items list (default: settle at the locked rate).
  Touches the cancellation/refund path only.
- **Slice C7 — Recognized-margin currency policy under FX.** Confirms
  and locks the recognized-margin currency invariant in the rewards
  module, with explicit tests. Scope: documentation + tests, ideally
  no behavior change.
