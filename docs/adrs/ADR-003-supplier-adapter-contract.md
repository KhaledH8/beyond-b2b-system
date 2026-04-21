# ADR-003: Supplier adapter contract

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

The platform must treat every supply source — Hotelbeds, WebBeds, TBO,
Rayna (conditional), later Expedia Rapid, possibly Booking.com Demand, and
our own direct contracts — uniformly downstream. Downstream code must not
branch on "which supplier is this."

The adapter contract is the seam where supplier-specific detail ends and
canonical behavior begins. Getting this shape right is load-bearing.

## Decision

### The contract (conceptual, not language-specific)

Every supplier adapter exposes these capabilities:

```
SupplierAdapter {
  meta:              StaticAdapterMeta  // capabilities, limits, features

  // Content
  listHotels(filter):           AsyncStream<SupplierHotelRef>
  getHotelContent(ref):         SupplierHotelContent
  listHotelImages(ref):         SupplierHotelImage[]

  // Availability + pricing (dynamic)
  searchAvailability(criteria): AsyncStream<SupplierRate>
  quoteRate(rateKey):           ConfirmedSupplierRate

  // Booking
  createBooking(confirmed, guests, paymentRef, idempotencyKey): SupplierBooking
  cancelBooking(supplierBookingId, idempotencyKey):             CancellationResult
  getBookingStatus(supplierBookingId):                          BookingStatus
  getCancellationPolicy(rateKey, dates):                        PolicyTimeline

  // Health
  healthCheck(): AdapterHealth
}
```

### Key shape rules

1. **Every mutating call takes an idempotency key.** Supplier APIs are
   famously unreliable on retries. We generate the key on our side and
   pass it through. Adapters must surface the supplier's own idempotency
   mechanism (if any) and fall back to client-side dedup via the key if
   not.
2. **Every streaming method is async/paginated.** Never load all hotels
   or all rates into memory.
3. **`meta` declares capabilities.** Boolean flags like
   `supports_rate_confirm`, `supports_partial_cancel`, `allows_public_rate_display`,
   `max_rooms_per_booking`. Downstream uses `meta`, not a hardcoded
   switch, to decide feature availability.
4. **Errors are typed.** `SupplierUnavailable`, `RateExpired`,
   `RateChanged` (with a diff), `BookingConflict`,
   `AuthorizationExpired`, `Throttled`, `ContentStale`. Adapters
   translate raw vendor errors into these.
5. **Rate limits and circuit breakers live in the adapter.** The adapter
   honors the vendor's rate limit and exposes a back-pressure signal to
   the caller (the supplier registry). A tripped breaker surfaces as
   `SupplierUnavailable` cleanly.
6. **All times are UTC with explicit property-local timezone fields
   where relevant** (check-in date, cancellation deadlines).
7. **All monetary amounts carry a currency code.** No implicit currency.
8. **Raw payloads are captured.** The adapter emits a `raw_payload`
   sidecar (hashed, stored) on every interaction for audit and
   reconciliation. Never thrown away in production.

### Data shapes

- `SupplierHotelRef { supplier_id, supplier_external_id }`
- `SupplierHotelContent { ref, name, address, geo, amenities[],
   description_blocks[], raw }` — normalized shape, with raw escape hatch
- `SupplierRate { rate_key, supplier_hotel_ref, room, board_code,
   check_in, check_out, cancellation_policy_ref, net_amount (currency,
   value), supplier_flags }`
- `ConfirmedSupplierRate` — a `SupplierRate` that has been re-quoted,
   with a short expiry
- `SupplierBooking { supplier_booking_id, status, created_at, raw }`
- `PolicyTimeline { windows[]: { from, to, fee_type, fee_amount } }`
- `AdapterHealth { status: OK | DEGRADED | DOWN, details }`

### Direct-contract adapter

Implements the same contract. Reads from our own `DirectContract` and
`DirectContractRate` tables. `meta.is_internal = true`. Everything else
looks identical to an external supplier from above.

### Versioning

The contract is versioned with semver. Breaking changes require a new
major version and a migration plan for every adapter. Non-breaking
additions (new optional `meta` flags, new optional fields) are minor.

## Consequences

- Adding a supplier is "implement the adapter, register it, configure
  credentials, run conformance tests." No core change.
- The contract's minimum viable shape is large on day one. Resist the
  urge to stub out `cancelBooking` as "coming later" — it must be
  present from Phase 2 onward for every adapter that supports bookings.
- Feature flags (`meta`) prevent leaky abstractions. If a supplier
  doesn't support partial cancellation, the system gracefully degrades
  instead of throwing at the vendor.

## Open items

- The concrete language/types (ADR-007 sets the stack; this ADR stays
  language-neutral).
- Adapter **conformance test suite** — a shared suite every adapter must
  pass with recorded fixtures. Build in Phase 1 alongside the first
  adapter.

## Amendment 2026-04-21 (see ADR-013) — ingestion-mode capability

The contract is extended to support **push-mode** supply (direct CRS /
channel manager connections) without breaking pull-mode adapters.

`StaticAdapterMeta` gains:

```
ingestion_mode:          PULL | PUSH | HYBRID
supports_ari_push:       bool
supports_content_push:   bool
supports_change_discovery: bool
booking_channel:         SYNC_API | ASYNC_QUEUE
booking_payment_model:   CHANNEL_COLLECTS | HOTEL_COLLECTS | SPLIT
source_channel:          AGGREGATOR_API
                       | DIRECT_PAPER
                       | DIRECT_CRS
                       | DIRECT_CHANNEL_MGR
                       | DIRECT_PMS
```

Behavior:

- PULL adapters continue as before — `searchAvailability` calls the
  upstream.
- PUSH adapters expose an ingestion endpoint (per-adapter) that accepts
  inbound ARI events, normalizes them, and writes to the
  `supply_ingested_rate` store. `searchAvailability` for a PUSH adapter
  reads from this local store. The contract is unchanged from the
  caller's perspective.
- HYBRID adapters mix the two (e.g., pull content, push ARI, sync
  bookings).

Downstream code must still not branch on supplier identity; it may,
however, use `meta` to report operational health differently for PUSH
vs PULL adapters. Full rationale: ADR-013.
