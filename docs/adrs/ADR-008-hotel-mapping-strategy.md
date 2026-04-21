# ADR-008: Hotel mapping strategy

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Mapping is how a `SupplierHotel` finds (or becomes) a `CanonicalHotel`.
Bad mapping duplicates hotels (UX disaster), misattributes bookings
(financial disaster), or blends unrelated properties (legal and review
disaster). Good mapping is the substrate on which every other subsystem
stands.

## Decision

### Pipeline stages

1. **Normalize the candidate `SupplierHotel`.**
   - Canonical-casing, trim, accent-fold the name.
   - Parse the address into components (using a library, not regex).
   - Round geo to a sensible precision for matching (e.g., 5 decimals).
   - Extract chain/brand hints where present.

2. **Attempt deterministic matches (in order).**
   - **Shared code match:** a small number of suppliers provide stable
     external ids (Giata, GDS codes). If two `SupplierHotel`s from
     different suppliers share one, the mapping is deterministic.
   - **Exact geo + exact name:** if geo is within 25 m and normalized
     name is an exact match of an existing `CanonicalHotel`, map.
   - **Near geo + fuzzy name + address match:** geo within 150 m,
     name similarity ≥ 0.92 (Jaro–Winkler or similar), address token
     overlap ≥ 0.8 → map with high confidence.

3. **If no deterministic match: create a new `CanonicalHotel`** with
   the normalized fields and a fresh id. The new canonical is seeded
   by this `SupplierHotel` and awaits other sources to join it.

4. **Fuzzy match only as a last resort**, and only to propose a
   mapping for human review, never to auto-commit:
   - Geo within 300 m, name similarity ≥ 0.75, chain match.
   - Queue a `MappingReviewCase` with candidate canonical(s) ranked by
     combined score.

5. **Human review** resolves ambiguity via an admin UI (build in
   Phase 2). Decisions are recorded with `method = MANUAL`,
   `decided_by = user_id`.

### Non-deterministic is opt-in

Fuzzy matches never auto-commit. An empty mapping is better than a wrong
one. "No match, new canonical" is always safe and reversible.

### Remaps

Wrong mappings happen. The correction path:
- Admin selects a `HotelMapping` to remap.
- A new `HotelMapping` is created linking the `SupplierHotel` to the
  correct `CanonicalHotel`.
- The old mapping is marked `superseded_by` the new one (not deleted).
- If the old canonical is now empty (no remaining mappings), it is
  marked INACTIVE.
- Existing bookings that referenced the old canonical retain a pointer
  to it via their own booking-time snapshot.

### Merges

Two canonicals discovered to be the same real hotel:
- Admin chooses winner and loser.
- All `HotelMapping`s and `HotelStaticContent` repoint to the winner.
- Loser is marked INACTIVE with `merged_into` pointer.
- Merges are logged with `reason`.

### Signals, confidence, and provenance

Each `HotelMapping` records:
- `method` (DETERMINISTIC_CODE, DETERMINISTIC_GEO_NAME, FUZZY, MANUAL)
- `confidence` in [0.0, 1.0]
- `signals_snapshot` — what values were compared (for later audit when
  signals change). JSONB is fine.

### Direct-contract mapping

Direct contracts enter as `SupplierHotel` records under the internal
`direct-contract` supplier. They follow the exact same pipeline:
normalize → deterministic match → review if ambiguous → new canonical
if unique. Curators can pre-map a direct contract to an existing
canonical by supplying a known supplier id to dedupe against.

### Performance

- Mapping runs asynchronously on ingest (worker jobs), not on the hot
  search path.
- Geo queries use PostGIS GIST indexes.
- Name similarity uses `pg_trgm` for a cheap prefilter; precise scoring
  in application code.

## Consequences

- Day-one mapping accuracy depends on deterministic coverage. We
  should license or integrate Giata (or equivalent) early for broad
  supplier id cross-references — it pays for itself.
- Human-review tooling is Phase 2, but the `MappingReviewCase` queue
  is populated from day one so we do not lose candidates.
- The `CanonicalHotel` count grows every time a supplier introduces a
  hotel we have not seen. That is correct; dedup is a background
  process, not a blocker.

## Anti-patterns explicitly forbidden

- Auto-merging canonicals based on fuzzy scores with no human
  review.
- Deleting `HotelMapping` rows when remapping.
- Using the `CanonicalHotel.name` as a stable key (use
  `canonical_hotel_id`).

## Open items

- Giata / external mapping service commercial decision — early
  Phase 1.
- Moderation/review UI — Phase 2.
