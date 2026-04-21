# ADR-002: Canonical hotel data model

- **Status:** Accepted
- **Date:** 2026-04-21
- **Supersedes:** —

## Context

Every downstream subsystem (search, pricing, booking, merchandising,
analytics) needs to answer the question: "is this the same real hotel?"
Supplier feeds disagree on names, addresses, chain affiliations, and
sometimes even geo coordinates. Direct contracts add a fourth or fifth
identity for the same property. Without a canonical model, we duplicate
hotels, confuse users, and poison analytics.

## Decision

### Core entity: `CanonicalHotel`

One row per real hotel. Owns the identity (`canonical_hotel_id`). Holds a
**resolved** view of static content — this is the view the storefront and
admin see. Resolved content is computed from contributing sources via the
content merge rules in ADR-005.

Fields (shape, not final schema):
- `canonical_hotel_id` (opaque, not leaking any supplier id)
- `tenant_id` (see ADR-006)
- `name`, `address`, `city`, `country`, `geo` (lat/lng)
- `chain_id?`, `brand_id?`
- `star_rating?`
- `resolved_content_version` — bumps on every content merge
- `status` — ACTIVE, UNDER_REVIEW, INACTIVE
- `created_at`, `updated_at`

### Satellite: `SupplierHotel`

A supplier's view of a hotel, as received from their feed. One row per
(supplier, supplier's hotel id). Never merged, never deduplicated against
itself — it is the raw source of truth from that supplier.

### Linking: `HotelMapping`

Link table between `SupplierHotel` and `CanonicalHotel`. A `SupplierHotel`
maps to exactly **one** `CanonicalHotel`. A `CanonicalHotel` can have many
`SupplierHotel` mappings.

Fields:
- `mapping_id`
- `supplier_hotel_id`
- `canonical_hotel_id`
- `confidence` (0.0–1.0)
- `method` — DETERMINISTIC_CODE, DETERMINISTIC_GEO_NAME, FUZZY, MANUAL
- `decided_by` — SYSTEM or user_id
- `decided_at`
- `superseded_by?` — allows non-destructive remap
- `notes?`

Mappings are append-only in spirit: a wrong mapping is superseded, not
deleted. Full audit trail.

### Content containers

- `HotelStaticContent` — versioned snapshots per `CanonicalHotel`. The
  resolved view on `CanonicalHotel` is a projection of the latest merge;
  raw contributions live here.
- `HotelImage` — image records with source, hash (for dedup), moderation
  status, display rank.
- `HotelAmenity` — join table to a controlled amenity vocabulary.

### Direct contracts

- `DirectContract` — the contract metadata (hotel we contracted with,
  dates, account scope, allotments).
- `DirectContractRate` — rate rows under a contract. When the direct-contract
  adapter is queried, it returns `SupplierRate` records projected from
  these tables, using the direct contract's own `SupplierHotel` identity.

Direct contracts do **not** get a shortcut. They go through the same
`SupplierHotel` → `HotelMapping` → `CanonicalHotel` pipe. This is what
keeps downstream source-agnostic.

### Rate and inventory (dynamic)

- `SupplierRate` — an ephemeral representation of a quoted rate from a
  supplier, scoped to a search. Not persisted long-term.
- `PricedOffer` — the sellable object returned to the storefront, carrying
  `canonical_hotel_id`, the winning `supplier_rate_ref`, and the full
  pricing trace.

These are in the model but short-lived. Caching is bounded by supplier
terms (see ADR-005).

## Identity rules

- `canonical_hotel_id` is never re-used. A merge of two canonical hotels
  creates a supersede record and an audit entry; the losing id is
  retained (marked INACTIVE with a pointer to the winner) so historical
  bookings still resolve.
- `SupplierHotel` identity is `(supplier_id, supplier_external_id)`. This
  is stable across runs and is what mapping keys off.

## Consequences

- The canonical table is rich but not authoritative on its own — it is a
  **projection** of mapped sources plus curator input. Code must treat it
  as a computed view, not a free-form editable record.
- Merging canonical hotels is a supported operation from day one. The
  admin needs a merge UI eventually; until then, it is a scripted
  operation with a full log.
- Analytics always joins through `canonical_hotel_id`, never through a
  supplier id. Supplier-level metrics use `supplier_hotel_id`.

## Open items

- Controlled amenity vocabulary — build from the intersection of supplier
  vocabularies plus an internal curation list. Decide in Phase 1.
- Image storage (CDN + origin). Decide in ADR-007 (tech stack).

## Status of related ADRs

- ADR-005 covers the static content merge rules that feed `CanonicalHotel`.
- ADR-008 covers the mapping strategy that populates `HotelMapping`.
- ADR-006 covers tenancy on all these tables.
