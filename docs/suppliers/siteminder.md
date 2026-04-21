# SiteMinder

- **Type:** Direct-connect channel manager
- **`source_type` / `source_channel`:** `DIRECT` / `DIRECT_CHANNEL_MGR`
- **Lives in:** `packages/adapters/siteminder/` (future)
- **Governed by:** ADR-003, ADR-013
- **Status:** Phase 4 candidate.
- **Commercial state:** Partner onboarding required; not yet started.

## Summary

SiteMinder connects a large base of independent and small-chain
hotels to distribution channels. Strong presence in APAC and EMEA.
Suitable second direct-connect after SynXis if commercial traction
lines up.

## Integration surface (known at time of writing)

- **SiteMinder Exchange** — API for distribution partners to receive
  hotel content and ARI and deliver reservations.
- **Booking API** — create / cancel reservations; idempotency
  support via partner reservation id.
- **ARI feed** — push or webhook-based rate/availability change
  delivery.

## Ingestion mode

**PUSH** — we receive rate/inventory updates via a webhook endpoint
we expose to SiteMinder. Search reads from our
`supply_ingested_rate` store.

## Adapter shape

```
meta: {
  supplier_id: "siteminder",
  source_type: DIRECT,
  source_channel: DIRECT_CHANNEL_MGR,
  ingestion_mode: PUSH,
  supports_ari_push: true,
  supports_content_push: true,
  supports_change_discovery: true,
  booking_channel: SYNC_API,
  booking_payment_model: CHANNEL_COLLECTS,  // verify per-property
  ...
}
```

## Known constraints and quirks (to be verified during certification)

- Per-property enablement; each hotel issues their own connection
  approval to SiteMinder-side.
- Rate plan and room type codes are property-specific — mapping to
  canonical shapes is non-trivial.
- Content depth varies — do not assume images/descriptions are
  complete; fall back to our content merge pipeline (ADR-005).

## Onboarding checklist

- [ ] Partner program application with SiteMinder.
- [ ] Legal/commercial terms signed.
- [ ] Test environment credentials + push endpoint registered.
- [ ] Adapter + conformance test pass.
- [ ] First pilot property connected.

## Open items

- Which specific SiteMinder API tier fits a platform-scale distributor
  vs a single-agency integration.
- How SiteMinder handles simultaneous connections from aggregators
  that also list the same hotel (inventory parity).
