# SynXis (Sabre Hospitality — Channel Connect / Booking API)

- **Type:** Direct-connect CRS
- **`source_type` / `source_channel`:** `DIRECT` / `DIRECT_CRS`
- **Status:** Planned first direct-connect provider (Phase 3)
- **Commercial state:** Partner certification required; not yet
  started.

## Why SynXis first

- Widely deployed in chain and independent properties globally.
- One stack covers content, rates/availability, reservations, and
  change discovery — minimizes the number of integration projects
  for a single property.
- Documentation is mature relative to many CM providers.

## Integration surface (known at time of writing)

- **Channel Connect** — content sync + ARI (availability/rate/
  inventory) + reservation delivery + cancellation.
- **Booking API** — reservation create/update/cancel.
- **Content API** — hotel, room, rate-plan, policy descriptions and
  media.
- **Change discovery** — event stream or polling endpoint announcing
  rate/inventory changes.

Ingestion mode expected: **HYBRID** — content pulled, ARI changes
discovered via events, bookings via synchronous API.

## Adapter shape (ADR-003 + ADR-013)

```
meta: {
  supplier_id: "synxis",
  source_type: DIRECT,
  source_channel: DIRECT_CRS,
  ingestion_mode: HYBRID,
  supports_ari_push: true,
  supports_content_push: false,     // pulled
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: CHANNEL_COLLECTS,  // we collect, then remit per hotel contract
  ...
}
```

## Known constraints and quirks (to be confirmed during certification)

- Per-property onboarding: each property has a SynXis chain code
  and property id; enablement is property-by-property, not tenant-wide.
- Test/certification environment separate from production; partner
  must complete test cases before live credentials are issued.
- Rate plans and room types are highly property-specific; content
  normalization needs care.
- Cancellation policy structure may require per-property mapping to
  our canonical `PolicyTimeline`.

## Onboarding checklist

- [ ] Partner program application with Sabre Hospitality.
- [ ] Legal/commercial terms signed.
- [ ] Certification environment access.
- [ ] Adapter implementation + conformance test pass.
- [ ] First pilot property signed and enabled (`DirectConnectProperty`
      row with `onboarding_status = PENDING_CERT`).
- [ ] Certification tests passed; property moves to `ACTIVE`.

## References to the codebase (future)

- `packages/adapters/synxis/` — adapter implementation.
- `supply_direct_connect_property` rows scoped to
  `supplier_id = 'synxis'`.

## Open items

- Exact change-discovery mechanism (event feed vs polling endpoint)
  — confirm during certification.
- Payment remittance model — depends on per-property contract
  (hotel-collects vs channel-collects).
