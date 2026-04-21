# Beyond Borders — Travel Distribution Platform

A multi-source, multi-audience travel distribution engine. Aggregates hotel
inventory from wholesale suppliers and direct hotel contracts into a single
canonical model, then distributes it to B2C, agency, member, and corporate
channels with account-aware pricing.

## Status

Early foundation. No application code yet. This repository currently contains
architecture, decisions, and working rules that shape what will be built.

## What makes this different

- **Distribution engine, not a single storefront.** Designed so the same
  platform can later be licensed to other travel agencies.
- **Many sources, one canonical hotel.** Hotelbeds, WebBeds, TBO, optional
  Rayna, later Expedia Rapid and possibly Booking.com, plus direct hotel
  contracts — all mapped to one profile per real hotel.
- **Direct contracts are first-class.** Same adapter contract as any
  wholesaler, not a separate bolt-on.
- **Account-aware pricing.** Markups and visibility rules attach to accounts
  (agency, corporate, subscriber group), not just channel type. Designed to
  grow into market-aware pricing.
- **Merchandising is a layer, not a mutation.** Sponsored and recommended
  placements re-rank results; they never change the priced rate.

## Audiences

1. B2C OTA — retail travelers.
2. B2B travel agencies.
3. B2B subscribers / members — closed user groups with member-only rates.
4. B2B corporate accounts — negotiated rates for employee travel.

## MVP scope

Hotels only. Two aggregator suppliers plus one direct contract, end-to-end:
search → canonical mapping → account-aware pricing → booking → basic ledger.

**Not in MVP:** flights, transfers, activities, loyalty, dynamic packaging,
corporate approval workflows, full finance / accounting integration.

## Repository layout

```
CLAUDE.md                         # Working rules for Claude in this repo
README.md                         # You are here
TASKS.md                          # Running task list
docs/
  architecture/overview.md        # System architecture
  adrs/ADR-001-foundation.md      # Foundational architecture decisions
  prompts/session-start.md        # Prompt to paste at the start of sessions
  data-model/                     # Canonical entities (added over time)
  flows/                          # Search / book / cancel / reconcile flows
  suppliers/                      # Per-supplier quirks and notes
```

## How to work on this repo

Start every session by reading `CLAUDE.md` and
`docs/prompts/session-start.md`. Record material decisions as a new ADR under
`docs/adrs/`. Keep `TASKS.md` current. Do not delete or rename files without
explicit approval.

## License

Proprietary. All rights reserved, Beyond Borders.
