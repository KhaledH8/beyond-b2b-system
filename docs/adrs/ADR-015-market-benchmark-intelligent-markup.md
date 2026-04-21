# ADR-015: Market benchmark and intelligent markup inputs

- **Status:** Accepted
- **Date:** 2026-04-21
- **Amends:** ADR-004 (pricing — new rule type `MARKET_ADJUSTED_MARKUP`
  and benchmark input seam), ADR-011 (monorepo — new
  `packages/rate-intelligence`)

## Context

Pricing starts as account-aware cost-plus (ADR-004). To grow beyond
that into **competitive** pricing, markup decisions need awareness of
what the public market is doing — the "rate shop" concept used widely
in hospitality revenue management.

This is explicitly **not** supply connectivity. Public-rate benchmark
data is:

- Observational — scraped or fetched from public OTA listings /
  rate-shop providers (RateGain DataLabs, OTA Insight, Triptease,
  Lighthouse, custom lightweight scrapers).
- Advisory — used to inform markup rules.
- Never authoritative — never sold as a sellable rate, never
  replaces supplier rates.

Confusing rate intelligence with supply connectivity (ADR-013) would
produce exactly the wrong architecture: coupling our sellable rates
to third-party observations, introducing data-compliance exposure on
public OTAs, and destroying the clean separation between "what we
can actually book" and "what the market is charging."

## Decision

### Separate module

A new `rate-intelligence` module:

```
packages/rate-intelligence/
  sources/                  // benchmark provider adapters
  ingestion/                // schedule, fetch, store snapshots
  query/                    // typed read interface for pricing
  normalization/            // provider → canonical benchmark shape
```

It has **no** dependency on `packages/pricing`. Pricing depends on
`rate-intelligence` through a narrow read-only query interface.

### Canonical benchmark shape

```
BenchmarkSnapshot {
  snapshot_id
  tenant_id
  canonical_hotel_id        // mapped target
  stay_date                 // single night; multi-night snapshots split
  source                    // RATEGAIN_DATALABS | OTA_INSIGHT | SCRAPER | ...
  fetched_at
  sample_count              // how many public quotes observed
  currency
  distribution {
    min, p25, median, p75, max      // minor units
  }
  outlier_flags[]           // high-variance, thin-sample, stale-source
  raw_payload_hash
}
```

Queries:

```
RateIntelligenceQuery {
  getLatestSnapshot(canonical_hotel_id, stay_date, freshness_window): BenchmarkSnapshot?
  getDistributionRange(canonical_hotel_id, date_range, freshness_window): aggregated stats
}
```

- No cross-tenant snapshot sharing without a configuration switch.
  Beyond Borders' scraping contracts do not auto-apply to tenant #2.
- Snapshots are time-series; old snapshots are kept for trend reports
  but query default reads the freshest per (hotel, date).

### New pricing rule type (ADR-004 amendment)

Introduce `MARKET_ADJUSTED_MARKUP`:

```
PricingRule {
  ...existing fields,
  type: MARKUP | DISCOUNT | FLOOR | CEILING | FEE | FX_BUFFER
       | MARKET_ADJUSTED_MARKUP       // new
  formula (when type = MARKET_ADJUSTED_MARKUP):
    {
      kind: PERCENT_OF_MEDIAN | PERCENT_OF_P25 | WITHIN_BAND
      value?                           // e.g., "price at 98% of market median"
      band?: { lo_percent, hi_percent } // allowed markup band bounded by market
      fallback: { kind: PERCENT, value } // when benchmark unavailable
      max_sample_age_hours               // freshness requirement
      min_sample_count                    // ignore thin benchmarks
    }
}
```

Evaluation:

1. The pricing engine calls `rate-intelligence.getLatestSnapshot`.
2. If fresh + sufficient samples: apply the market-adjusted formula,
   which produces a target sellable price.
3. Engine computes the required markup to land on that target given
   net cost.
4. Resulting markup is subject to `FLOOR`/`CEILING` rules as usual.
5. If benchmark is unavailable/stale/thin: fall back to the formula's
   `fallback` shape (a static percent), **and** the trace records
   "benchmark unavailable, fallback used."

The trace (ADR-004 `PricingTrace`) records the snapshot id, the
benchmark stats, and the computed adjustment. This is non-negotiable;
a silent market adjustment is a pricing bug, not a feature.

### Provider adapter shape

Each benchmark source is an adapter:

```
BenchmarkSourceAdapter {
  meta: { source, refresh_interval, supports_historical }
  fetchSnapshot(canonical_hotel_id, stay_date): BenchmarkSnapshot
  bulkFetchWindow(canonical_hotel_id, date_range): AsyncStream<BenchmarkSnapshot>
}
```

- First provider at Phase 4: likely a lightweight scraper for a
  handful of destination hotels, plus one commercial feed if
  contracted (RateGain DataLabs is the early candidate — note this
  is a **different product** from RateGain Channel Manager, which is
  ADR-013 territory).
- Scraper operation respects robots.txt, rate limits hosts, and uses
  residential IP egress only if commercially licensed. This is
  tenant-visible configuration; a tenant that does not license
  scraping data cannot enable scraper sources.

### Hotel mapping for benchmarks

A benchmark source references hotels by its own ids (e.g., OTA
listing id). A mapping step associates those to `canonical_hotel_id`,
reusing the ADR-008 mapping pipeline, but in a separate namespace so
we do not conflate "this is a benchmark source id" with "this is a
supplier source id."

`BenchmarkHotelMapping` is a new entity, shape-identical to
`HotelMapping` but scoped to benchmark sources. Shared infrastructure,
separate table.

### Tenancy and consent

- A tenant must explicitly enable market-intelligence features.
  Default off.
- Jurisdictions with specific scraping/data-broker regulation are
  flagged in `TenantSetting.rate_intelligence_policy`; unsupported
  jurisdictions cannot enable scraper-based sources.

### Governance: the kill switch

A tenant-level setting disables `MARKET_ADJUSTED_MARKUP` rules
globally. This is a regulatory/legal safety valve. When toggled off,
all rules of that type silently fall back to their `fallback` formula
and the trace records the disablement. Booking flows never break.

## Consequences

- Pricing becomes genuinely competitive once benchmarks land, without
  ceding pricing control to a third-party feed.
- Complete separation between supply connectivity (what we sell) and
  market intelligence (what the world charges) — compliance, audit,
  and incident containment all benefit.
- Observability burden grows: every market-adjusted markup must be
  explainable per-offer with snapshot references.
- Rate-intelligence ingestion is a non-trivial data pipeline and will
  be larger than its first version suggests. Budget for Phase 4/5.

## Anti-patterns explicitly forbidden

- Feeding benchmark snapshots into `SupplierRate` rows.
- Scraping without tenant consent and jurisdictional review.
- Silent market-driven price changes with no trace entry.
- Cross-tenant benchmark reuse without explicit configuration.
- Using channel-manager ARI (ADR-013) as a benchmark — that is not
  public-market data; it is our own supply.

## Open items

- Commercial selection of the first benchmark provider — Phase 4
  decision. RateGain DataLabs vs OTA Insight vs Lighthouse.
- Scraper ethics & legal review — gated behind legal sign-off per
  tenant per jurisdiction.
- Snapshot retention policy — likely 13 months by default for
  year-over-year comparison, configurable per tenant.
- Whether benchmark snapshots ever feed a demand-forecasting model
  (Phase 6+; out of scope here).
