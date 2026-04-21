# Channex

- **Type:** Direct-connect channel manager (lightweight, API-first).
- **`source_type` / `source_channel`:** `DIRECT` /
  `DIRECT_CHANNEL_MGR`
- **Lives in:** `packages/adapters/channex/` (future)
- **Governed by:** ADR-003, ADR-013
- **Status:** Phase 5+ candidate.
- **Commercial state:** Partner application process; not yet started.

## Summary

Channex is a developer-friendly, API-first channel manager. Suits
properties that want a modern, thin CM layer without the breadth of
SiteMinder/RateGain. Useful for long-tail independent inventory with
technical property managers.

## Integration surface

- **Channex API** — properties, rate-plans, room-types, inventory,
  ARI updates, booking delivery.
- **Webhooks** — ARI change + reservation events.
- Token-based auth; straightforward developer onboarding relative to
  traditional CM vendors.

## Ingestion mode

**PUSH** for ARI via webhooks; sync booking API.

## Adapter shape

```
meta: {
  supplier_id: "channex",
  source_type: DIRECT,
  source_channel: DIRECT_CHANNEL_MGR,
  ingestion_mode: PUSH,
  supports_ari_push: true,
  supports_content_push: false,
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: CHANNEL_COLLECTS,  // verify per property
  ...
}
```

## Known constraints and quirks (to be verified)

- Smaller operator; ecosystem and tooling are thinner than
  SiteMinder/RateGain.
- Content depth varies; content merge pipeline must fill gaps.
- Rate limit and throughput should be tested early.

## Onboarding checklist

- [ ] Channex partner application.
- [ ] Legal/commercial terms.
- [ ] Sandbox access.
- [ ] Adapter + conformance test pass.
- [ ] First pilot property connected.

## Open items

- Whether Channex integration is worth prioritizing versus a second
  large-CM (RateGain/SiteMinder) — driven by tenant demand and
  property pipeline, revisit at Phase 5.
