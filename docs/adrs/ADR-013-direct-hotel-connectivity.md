# ADR-013: Direct hotel connectivity via CRS and channel managers

- **Status:** Accepted
- **Date:** 2026-04-21
- **Amends:** ADR-003 (adapter contract — ingestion-mode capability),
  ADR-005 (static/dynamic split — push-mode dynamic ingestion)

## Context

"Direct contracts" were initially conceived as paper/PDF/spreadsheet
contracts loaded into internal tables (ADR-002, ADR-008). That covers
the smallest hotels, but it does not cover a large class of properties
that are reachable **directly** via technology:

- **Central Reservation Systems (CRS)** such as Sabre Hospitality
  **SynXis Channel Connect** expose hotel inventory, content,
  reservation, and change-discovery APIs. A CRS-connected hotel is a
  direct relationship we can book live through, with the hotel's own
  rates, not a wholesale net rate.
- **Channel managers** such as **RateGain**, **SiteMinder**, **Mews**,
  **Cloudbeds**, and **Channex** push Availability / Rates / Inventory
  (ARI) to connected channels. If we become a connected channel to a
  property, we receive ARI pushes, and we book through the channel
  manager's reservation API or the underlying PMS.

These are **supply-side connectivity channels**, not public-rate
intelligence. They are a different beast from aggregators (Hotelbeds,
WebBeds, TBO) in two ways:

1. **Commercial model** — the hotel pays no wholesaler margin, so the
   net rate is the hotel's own rate minus our commission. Margin
   economics are better; contracting overhead is higher.
2. **Integration shape** — many are **push-based** (the channel manager
   pushes ARI to our endpoint) rather than pull-based (we call an
   availability search API).

## Decision

### Same canonical source model

Direct CRS and direct channel-manager connections are **supply sources**
under the same canonical model as aggregators. They implement the same
`SupplierAdapter` contract (ADR-003) with one capability addition.

### Taxonomy refinement

`SupplierSource` grows from two `source_type`s to a richer two-field
identity:

```
source_type:     AGGREGATOR | DIRECT
source_channel:  AGGREGATOR_API
               | DIRECT_PAPER        // internally-stored contract
               | DIRECT_CRS          // SynXis, Amadeus CRS, etc.
               | DIRECT_CHANNEL_MGR  // SiteMinder, RateGain, Mews, Cloudbeds, Channex
               | DIRECT_PMS          // direct PMS integration (rare; future)
```

- `source_type` drives high-level economics (wholesaler vs direct
  margin) and pricing rule scope (ADR-004 `source_type` scope value
  unchanged).
- `source_channel` drives connectivity mechanism and goes into the
  adapter `meta` block.

### Ingestion mode in adapter `meta` (ADR-003 amendment)

Adapter `meta` gains fields:

```
StaticAdapterMeta {
  ...existing fields,
  ingestion_mode: PULL | PUSH | HYBRID
  supports_ari_push: bool
  supports_content_push: bool
  supports_change_discovery: bool   // webhook/event feed for availability changes
  booking_channel: SYNC_API | ASYNC_QUEUE
}
```

- **PULL adapters** (aggregators, direct-paper): `searchAvailability`
  calls the upstream.
- **PUSH adapters** (most channel managers): `searchAvailability`
  reads from a **local ingestion store** that is updated by inbound
  ARI events. The adapter exposes an ingestion endpoint that accepts
  the channel manager's push payloads, normalizes them into
  `SupplierRate`-shaped rows, and writes them to the store.
- **HYBRID adapters** (some CRS): content is pulled, ARI is pushed,
  bookings are synchronous API.

Downstream code calling `searchAvailability` does not know the mode.
The contract is identical; `meta` describes the mechanism for
operations and observability.

### Ingestion store

A new supply-side table family:

```
supply_ingested_rate {
  tenant_id
  supplier_id
  supplier_hotel_ref     // per ADR-003
  rate_key               // supplier-generated
  check_in, check_out
  occupancy, room_code, board_code
  net_amount, currency
  cancellation_policy_ref
  received_at            // arrival time at our endpoint
  valid_from, valid_to   // supplier-declared freshness window
  raw_payload_hash
  supersedes_rate_key?   // chain for rate updates
}
```

- Append-mostly, with supersede chains rather than in-place updates,
  for auditability.
- Freshness windows govern visibility — stale rows are filtered out of
  `searchAvailability` reads.
- A compaction job collapses superseded chains weekly.

### Booking through CRS / channel manager

- Adapter implements `createBooking` / `cancelBooking` exactly as
  aggregator adapters do, calling the provider's reservation endpoint.
- Idempotency keys remain mandatory. Many CRS/CM providers have their
  own idempotency support — adapter maps our key into theirs.
- Payment model varies: CRS/CMs typically expect the channel (us) to
  collect payment from the guest and either hold on behalf of the
  hotel or remit via a payment rail the hotel specifies. This is
  handled per-adapter in the `meta.booking_payment_model` field:
  `CHANNEL_COLLECTS | HOTEL_COLLECTS | SPLIT`.

### Content

CRS and channel managers often provide content (images, descriptions,
amenities) alongside ARI. Content flows into the **static pipeline**
(ADR-005), merges into `CanonicalHotel` via the mapping pipeline
(ADR-008). Curator overrides remain supreme.

### Certification and commercial overhead

Direct-connect integrations generally require certification / approval:

- SynXis Channel Connect — Sabre partner program, certification
  required.
- RateGain Channel Manager / Direct Connect — partner onboarding.
- SiteMinder, Mews, Cloudbeds, Channex — each has its own partner /
  developer program.

Budget assumption: each new direct-connect provider is roughly a
quarter of calendar time to reach first-live with one hotel, even
though the adapter itself is small code. The long tail is commercial
paperwork, certification tests, and hotel onboarding.

### Hotel-level configuration

A direct-connect adapter is typically configured per property, not
once globally. `SupplierConnection` (ADR-006) remains
per-(tenant, supplier), but a new entity covers property-level
enablement:

```
DirectConnectProperty {
  tenant_id
  supplier_id           // the CRS/CM adapter
  supplier_hotel_ref    // hotel code in the provider's namespace
  canonical_hotel_id?   // populated after mapping
  status:               // PENDING_CERT | ACTIVE | SUSPENDED | OFFBOARDED
  onboarding_notes
}
```

### Roadmap placement

- **Phase 3** — first direct-connect adapter (SynXis CRS is the
  prime candidate: widely deployed, documented, supports content +
  ARI + reservation + change discovery in one stack).
- **Phase 4** — RateGain Channel Manager and one more CM (SiteMinder
  or Mews depending on commercial traction).
- **Phase 5+** — Cloudbeds, Channex, PMS-direct as demand arises.

## Consequences

- Direct-connect hotels appear in search results with the same
  canonical hotel id as the same property on aggregators.
- Source selection in pricing (ADR-004) naturally picks the direct
  connection when its sellable price wins after rules.
- Push-mode adapters introduce an ingestion concern not present for
  pull-only adapters — we now operate inbound endpoints, authenticate
  pushes, and keep an ingestion store fresh.
- Operational surface grows: each CM push endpoint is an incident
  vector we monitor independently.

## Anti-patterns explicitly forbidden

- Treating CRS/channel-manager output as "just another aggregator"
  without modelling push ingestion.
- Using channel-manager ARI data as **public-rate intelligence** for
  competitive pricing — this is a supply connection, not a rate shop.
  Rate intelligence is ADR-015.
- Bypassing the adapter contract with "we'll integrate SynXis directly
  into search for speed." No. Same contract, every time.
- Storing pushed rates as authoritative without a freshness window.

## Open items

- Exact signature of the ingestion endpoint — per-provider shape vs
  unified normalized shape. Lean toward a thin per-provider ingest
  handler that translates into the normalized `supply_ingested_rate`
  shape.
- Whether to persist raw push payloads to object storage for replay
  (yes, default on, with retention per tenant setting).
- Content deduplication across CM and aggregator (same hotel on both)
  — handled via existing content-merge rules in ADR-005.
