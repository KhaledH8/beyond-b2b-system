# Beyond Borders — Travel Distribution Platform

A multi-source, multi-audience travel distribution engine. Aggregates hotel
inventory from wholesale suppliers and direct hotel contracts into a single
canonical model, then distributes it to B2C, agency, member, and corporate
channels with account-aware pricing.

## Status

Phase 0 scaffolding complete. The monorepo shell, package boundaries,
dependency-direction enforcement, and local dev infra are in place. A GitHub
Actions CI workflow (`.github/workflows/ci.yml`) runs build → typecheck →
lint → test on every push to `main` and on pull requests. No business logic
yet — the next step is Phase 1 implementation (first supplier adapter +
canonical mapping pipeline).

## Getting started

**Prerequisites:** Node.js ≥ 20, pnpm ≥ 9, Docker Desktop.

```bash
# 1. Install all dependencies
pnpm install

# 2. Start local infrastructure (Postgres+PostGIS, Redis, MinIO)
pnpm db:up

# 3. Copy the example env file and fill in the blanks
cp .env.example .env

# 4. Boot all apps in dev mode (Turborepo runs them in parallel)
pnpm dev

# Or boot a single app:
cd apps/api && pnpm dev        # NestJS API — http://localhost:3000
cd apps/b2c-web && pnpm dev    # B2C storefront  — http://localhost:3010
cd apps/b2b-portal && pnpm dev # B2B portal      — http://localhost:3011
cd apps/admin && pnpm dev      # Admin console   — http://localhost:3012
```

**Health check (once API is running):**
```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.0.0","timestamp":"..."}
```

**Useful commands:**
```bash
pnpm build       # Build all packages and apps (Turborepo, respects dep order)
pnpm typecheck   # TypeScript check across the whole monorepo
pnpm lint        # ESLint including dependency-direction enforcement
pnpm test        # Vitest across all packages
pnpm db:down     # Stop local Docker containers
pnpm db:logs     # Tail container logs
```

**Infrastructure URLs (local):**

| Service  | URL                          | Notes                  |
|----------|------------------------------|------------------------|
| Postgres | `localhost:5432`             | db=beyond_borders, user=bb, pw=bb_local |
| Redis    | `localhost:6379`             |                        |
| MinIO    | `http://localhost:9000`      | S3-compatible          |
| MinIO UI | `http://localhost:9001`      | user=bb_local pw=bb_local_secret |

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
package.json                      # pnpm workspace root
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
eslint.config.mjs                 # Dependency-direction enforcement
apps/
  api/                            # NestJS modular monolith
  worker/                         # Background workers (BullMQ)
  b2c-web/                        # Next.js — B2C OTA storefront
  b2b-portal/                     # Next.js — agency / subscriber / corporate
  admin/                          # Next.js — internal operations console
packages/
  domain/                         # Zero-dep core types and value objects
  supplier-contract/              # SupplierAdapter interface (ADR-003)
  ledger/                         # LedgerEntry, WalletAccount, LedgerPort
  payments/                       # PaymentPort (Stripe rail interface)
  rewards/                        # Loyalty, referral, fraud types
  documents/                      # Document types and delivery (ADR-016)
  reseller/                       # Reseller profiles (ADR-017/018)
  rate-intelligence/              # BenchmarkReadPort (advisory only, ADR-015)
  ui/                             # Shared React components (placeholder)
  config/                         # AppConfig + loadConfig()
  testing/                        # Test fixtures, adapter conformance suite
infra/
  docker/docker-compose.yml       # Postgres+PostGIS, Redis, MinIO
  migrations/                     # DB migrations per module (Phase 1+)
docs/
  architecture/overview.md        # System architecture
  adrs/                           # Architecture Decision Records (ADR-001–020)
  data-model/entities.md          # Canonical domain entities index
  design/                         # payments.md, rewards-referral.md
  flows/                          # Search / book / cancel / reconcile flows
  prompts/session-start.md        # Prompt for new sessions
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
