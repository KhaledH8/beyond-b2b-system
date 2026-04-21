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
  contracts (paper, CRS like SynXis, channel managers like RateGain,
  SiteMinder, Mews, Cloudbeds, Channex) — all mapped to one profile per
  real hotel.
- **Direct contracts and direct-connect are first-class.** Paper contracts,
  CRS connections, and channel-manager integrations all implement the same
  adapter contract as any wholesaler. No side modules.
- **Account-aware pricing, growing market-aware.** Markups and visibility
  attach to accounts (agency, corporate, subscriber group), not just
  channel type. Public-rate benchmarks feed a separate rate-intelligence
  module that advises — never dictates — pricing.
- **Merchandising is a layer, not a mutation.** Sponsored and recommended
  placements re-rank results; they never change the priced rate.
- **Wallet is a ledger, not a number.** Internal double-entry ledger holds
  cash, promo credit, loyalty reward, referral reward, and B2B credit line
  balances. Stripe is a payment rail that ingests into the ledger, not the
  wallet itself.
- **Loyalty and referral are first-class.** Every booking accrues rewards;
  B2C referral rewards both parties; all accruals mature after a clawback
  window; referral requires anti-fraud clearance.

## Audiences

1. B2C OTA — retail travelers.
2. B2B travel agencies.
3. B2B subscribers / members — closed user groups with member-only rates.
4. B2B corporate accounts — negotiated rates for employee travel.

## Scope by phase

Hotels only. The spine is proven in phases (see `docs/roadmap.md`):

- **Phase 0 — foundation.** Decisions, ADRs, scaffolding.
- **Phase 1 — read-only core spine.** One aggregator (Hotelbeds), canonical
  mapping, content merge, basic pricing, search API.
- **Phase 2 — bookable spine.** Saga-based booking, Stripe integration,
  internal wallet ledger (cash + promo credit), basic loyalty accrual,
  cancellation, reconciliation.
- **Phase 3 — multi-supplier, direct-connect, referral.** Second and third
  aggregators, first direct-connect (SynXis CRS likely), B2C referral with
  anti-fraud, B2B credit lines and invoicing, merchandising campaigns.
- **Phase 4 — B2B channels and market intelligence.** Agency / subscriber
  / corporate portals, SSO, benchmark-driven `MARKET_ADJUSTED_MARKUP`
  rules, more channel-manager adapters.
- **Phase 5 — scale.**
- **Phase 6 — platform productization** (tenant #2).

**Not in roadmap:** flights, transfers, activities, dynamic packaging,
corporate approval workflows, full finance / accounting / GL integration,
multi-level referral chains.

## Repository layout

```
CLAUDE.md                         # Working rules for Claude in this repo
README.md                         # You are here
TASKS.md                          # Running task list
docs/
  architecture/overview.md        # System architecture
  adrs/                           # Architecture Decision Records
  data-model/entities.md          # Canonical domain entities index
  design/                         # Cross-cutting design notes
                                  #   payments.md, rewards-referral.md
  flows/                          # Search / book / cancel / reconcile flows
  prompts/session-start.md        # Prompt to paste at the start of sessions
  roadmap.md                      # Phased delivery plan
  suppliers/                      # Per-supplier and per-connector notes
```

## How to work on this repo

Start every session by reading `CLAUDE.md` and
`docs/prompts/session-start.md`. Record material decisions as a new ADR under
`docs/adrs/`. Keep `TASKS.md` current. Do not delete or rename files without
explicit approval.

## License

Proprietary. All rights reserved, Beyond Borders.
