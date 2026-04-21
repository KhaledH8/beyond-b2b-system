# RateGain

RateGain produces two distinct products relevant to this platform.
**These live in different architectural modules. Do not conflate them.**

---

## 1. RateGain Channel Manager / Direct Connect — **supply**

- **Type:** Direct-connect channel manager
- **`source_type` / `source_channel`:** `DIRECT` / `DIRECT_CHANNEL_MGR`
- **Lives in:** `packages/adapters/rategain/`
- **Governed by:** ADR-003, ADR-013
- **Status:** Planned Phase 3–4 direct-connect candidate.
- **Commercial state:** Partner onboarding required; not yet started.

### What it does

Delivers hotel ARI from properties connected to RateGain's channel
manager to connected distribution channels. We would be one of those
distribution channels.

### Ingestion mode

**PUSH** for ARI; booking typically via a RateGain reservation
endpoint or delivered to the PMS through RateGain. Expect to operate
an inbound endpoint accepting RateGain's push payloads.

### Adapter shape

```
meta: {
  supplier_id: "rategain",
  source_type: DIRECT,
  source_channel: DIRECT_CHANNEL_MGR,
  ingestion_mode: PUSH,
  supports_ari_push: true,
  supports_content_push: true,
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: CHANNEL_COLLECTS,  // most common; verify per property
  ...
}
```

### Onboarding checklist

- [ ] Partner program application with RateGain.
- [ ] Legal/commercial terms signed.
- [ ] Test environment + push endpoint credentials.
- [ ] Adapter implementation + conformance test pass.
- [ ] First pilot property connected.

---

## 2. RateGain DataLabs (or equivalent rate-shop product) — **rate intelligence**

- **Type:** Public-rate benchmark provider
- **Lives in:** `packages/rate-intelligence/sources/rategain/`
- **Governed by:** ADR-015
- **Status:** Phase 4 candidate.

### What it does

Provides public-rate benchmark data (what other OTAs are charging
for a given hotel on a given stay date). Advisory only; not a
sellable rate.

### Integration shape

`BenchmarkSourceAdapter` (ADR-015). Fetches per-hotel per-date
distributions with sample counts and freshness.

### Constraint

**Never** connect this module to the supply pipeline. It is a read
into `BenchmarkSnapshot`, consumed by `MARKET_ADJUSTED_MARKUP`
pricing rules. Cross-wiring into supply is a blast-radius violation
(ADR-015).

### Alternatives

- OTA Insight
- Lighthouse
- Triptease (rate-shopping features)
- Bespoke scraper (with legal and per-tenant licensing review)

Commercial selection is a Phase 4 decision.

---

## Why both can coexist on the same vendor name

RateGain sells into both the connectivity market (channel manager)
and the intelligence market (rate shop). These are **separate
products with separate contracts**. Our system must model them
separately: different adapters, different tables, different packages,
different operational concerns. The only thing they share is the
vendor name on the invoice.
