# ADR-005: Static vs dynamic content split

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Supplier APIs expose two kinds of data with very different lifetimes,
contractual caching rules, and authority-of-record characteristics:

- **Static content** — hotel name, address, geo, amenities, descriptions,
  images, chain/brand, star rating. Changes rarely. Suppliers usually
  allow caching.
- **Dynamic data** — availability, live rates, cancellation policies
  computed from current dates, promotions, stop-sells. Changes
  constantly. Suppliers typically restrict caching heavily or forbid it
  for live rates.

Treating them as one pipeline gets us into both UX problems (stale
prices) and commercial problems (violating supplier terms).

## Decision

### Two pipelines, always

**Static pipeline:**
- Scheduled pulls per supplier (`listHotels` + `getHotelContent`).
- Incremental where the supplier supports "changed since" endpoints;
  full refresh otherwise, on a slower cadence.
- Output is `HotelStaticContent` rows, versioned per contribution.
- A **content merge step** produces/updates the resolved view on
  `CanonicalHotel`.
- Images are fetched lazily per hotel on first mapping or on demand,
  deduplicated by content hash, moderated before B2C display.
- Cache TTL: effectively long (days). Hard bound is whatever the
  supplier contract allows.

**Dynamic pipeline:**
- Called on user search (`searchAvailability`), re-quoted at booking
  intent (`quoteRate`), confirmed at booking (`createBooking`).
- Cache TTL: **zero by default**. Short TTLs (seconds to a few minutes)
  only when the supplier's terms explicitly allow, and only for
  identical search keys.
- Never stored long-term. `SupplierRate` records in flight are ephemeral.

### Content merge rules

Authority-of-record per field on `CanonicalHotel`:

| Field | Authority |
|---|---|
| name, address, geo | majority of high-confidence sources; curator override persists |
| description | curator-first; else best-quality supplier description (length/structure score) |
| amenities | union of sources with confidence per amenity |
| images | curator-first ranked list; else supplier ranked list, deduped by hash |
| star rating | mode of supplier values; curator can pin |
| chain/brand | curator-first; else supplier majority |

Curator values are sticky — they survive the next content refresh.
Every curator change records `curator_user_id`, `reason`, timestamp.

Conflict cases (e.g., two suppliers disagree on geo beyond tolerance,
no curator input) are queued for human review, not silently resolved.

### Images specifically

- Fetch from supplier URL on demand (first mapping, first curator
  action, or first B2C view). Do not mass-mirror every image of every
  hotel proactively — storage cost with low return.
- Compute perceptual hash and exact hash. Dedup across suppliers.
- Store original + generated sizes in object storage.
- Moderation pipeline (flag NSFW, text overlays, watermarks) runs
  before an image is B2C-visible. Admin-only visibility in the
  meantime.
- Honor supplier-specific redistribution rules. Some suppliers
  restrict use of their images; the adapter declares this in `meta`.

### Cache busting

- A content merge bumps `resolved_content_version`. Storefront uses
  the version in its cache key so updates propagate without full
  invalidation.
- A dynamic rate is never cached with a user identity in the key —
  account context is applied on top, not in the cache key.

## Consequences

- Two distinct pipelines means two operational surfaces to monitor
  (content workers and live search).
- We will not accidentally serve a stale price, because we never cache
  prices meaningfully.
- Content merge rules must be explicit and testable. Curator overrides
  are load-bearing and need an audit trail.

## Open items

- Exact cadence per supplier: weekly full + daily incremental as a
  starting template, tuned per supplier after observing change rates.
- Object storage choice: ADR-007.
- Moderation tooling: buy vs build — Phase 2 decision.
