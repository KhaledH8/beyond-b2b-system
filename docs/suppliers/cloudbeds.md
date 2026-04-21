# Cloudbeds

- **Type:** Direct-connect — PMS + channel manager hybrid.
- **`source_type` / `source_channel`:** `DIRECT` /
  `DIRECT_CHANNEL_MGR`
- **Lives in:** `packages/adapters/cloudbeds/` (future)
- **Governed by:** ADR-003, ADR-013
- **Status:** Phase 5 candidate.
- **Commercial state:** Partner program; not yet started.

## Summary

Cloudbeds targets independent hotels, hostels, and B&Bs. Relevant
for long-tail independent inventory where larger CMs have thinner
coverage.

## Integration surface

- **Cloudbeds API** — properties, rooms, rate-plans, reservations,
  availability.
- **Webhooks** — reservation and availability change events.
- **OAuth 2.0** authorization flow.

## Ingestion mode

**HYBRID** — pull content, webhook-driven ARI change discovery,
sync booking.

## Adapter shape

```
meta: {
  supplier_id: "cloudbeds",
  source_type: DIRECT,
  source_channel: DIRECT_CHANNEL_MGR,
  ingestion_mode: HYBRID,
  supports_ari_push: true,
  supports_content_push: false,
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: SPLIT,  // varies widely across Cloudbeds properties
  ...
}
```

## Known constraints and quirks (to be verified)

- Property size / sophistication varies wildly — do not assume
  clean content or consistent rate-plan structures.
- Payment model varies by property and by market; treat
  `booking_payment_model` as per-property configurable rather than
  adapter-wide.
- Rate limits for smaller properties may be tight — back-pressure
  carefully per-property.

## Onboarding checklist

- [ ] Cloudbeds Marketplace / partner application.
- [ ] Legal/commercial terms.
- [ ] Sandbox access.
- [ ] Adapter + conformance test pass.
- [ ] Pilot property onboarded.

## Open items

- Whether we keep a single `booking_payment_model` in adapter `meta`
  or promote the field to the property level
  (`DirectConnectProperty.booking_payment_model`). Leaning toward
  promotion as direct-connect programs mature.
