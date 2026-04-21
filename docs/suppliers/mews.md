# Mews

- **Type:** Direct-connect — PMS-native, acts as both PMS and
  distribution hub.
- **`source_type` / `source_channel`:** `DIRECT` /
  `DIRECT_CHANNEL_MGR` (or `DIRECT_PMS` where appropriate)
- **Lives in:** `packages/adapters/mews/` (future)
- **Governed by:** ADR-003, ADR-013
- **Status:** Phase 4–5 candidate.
- **Commercial state:** Marketplace/partner program; not yet started.

## Summary

Mews is a cloud-native PMS with a strong developer platform. Rather
than pure channel-manager semantics, Mews exposes comprehensive APIs
that let us integrate close to the property's source of truth.

## Integration surface

- **Mews Open API** — read/write access to reservations, products,
  rates, availability.
- **Mews Connector API** — the distribution-partner-facing API
  (channel delivery path).
- **Webhooks** — event-based change discovery.

## Ingestion mode

**HYBRID**:

- Pull hotel/room/rate-plan content via Open API.
- Push-style change discovery via webhooks.
- Sync booking creation / cancellation via Open API.

## Adapter shape

```
meta: {
  supplier_id: "mews",
  source_type: DIRECT,
  source_channel: DIRECT_CHANNEL_MGR,  // or DIRECT_PMS depending on program
  ingestion_mode: HYBRID,
  supports_ari_push: true,              // via webhooks
  supports_content_push: false,         // pulled
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: HOTEL_COLLECTS,  // Mews properties typically collect
  ...
}
```

## Known constraints and quirks (to be verified)

- Mews payment model often favors the hotel collecting at property
  or via a Mews-integrated payment flow — confirm per deal.
- Strict OAuth/scope model; each integration requires approved
  scopes.
- Rate-plan concept includes products (upsells) that have no
  direct analogue in our canonical model — map conservatively or
  ignore non-room products in MVP.

## Onboarding checklist

- [ ] Mews Marketplace / developer program application.
- [ ] Legal/commercial terms signed.
- [ ] OAuth credentials + sandbox access.
- [ ] Adapter + conformance test pass.
- [ ] First pilot property connected.

## Open items

- Whether to classify Mews as `DIRECT_CHANNEL_MGR` or `DIRECT_PMS`
  in our taxonomy — leans toward CM since we use the
  distribution-partner API, not internal PMS APIs. Revisit if
  requirements grow.
- Product/upsell handling — out of scope for initial integration.
