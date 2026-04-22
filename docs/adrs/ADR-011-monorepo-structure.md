# ADR-011: Monorepo structure

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

We chose a modular monolith backend (ADR-001 D-implicit, reinforced by
ADR-007). The repo must hold backend, multiple frontends, shared
domain packages, and infrastructure. We want module boundaries visible
in the repo layout so later extraction is mechanical, not archaeological.

## Decision

### Top-level layout

```
beyond-borders/
├── apps/
│   ├── api/                   # NestJS modular monolith (main backend)
│   ├── worker/                # Background workers (content refresh,
│   │                          #   mapping, saga execution, recon)
│   ├── b2c-web/               # Next.js public OTA storefront
│   ├── b2b-portal/            # Next.js portal (agency/subscriber/
│   │                          #   corporate, role-gated)
│   └── admin/                 # Next.js internal admin console
│
├── packages/
│   ├── domain/                # Entities, value objects, shared types
│   ├── supplier-contract/     # The adapter interface + shared types
│   ├── adapters/
│   │   ├── hotelbeds/
│   │   ├── webbeds/
│   │   ├── tbo/
│   │   ├── rayna/             # conditional — scaffold only when
│   │   │                      #   confirmed
│   │   └── direct-contract/   # reads internal tables via same
│   │                          #   interface
│   ├── pricing/               # Rule model, evaluator, trace
│   ├── mapping/               # Hotel mapping pipeline
│   ├── content/               # Static content merge + moderation
│   ├── merchandising/         # Campaigns, ranking, boosts
│   ├── booking/               # Saga definitions + state machine
│   ├── tenancy/               # Tenant context, auth glue
│   ├── observability/         # OpenTelemetry helpers
│   ├── ui/                    # Shared React components, theming
│   ├── config/                # Runtime config loading
│   └── testing/               # Fixtures, adapter conformance suite
│
├── infra/
│   ├── docker/                # Local dev compose
│   ├── migrations/            # DB migrations (authoritative)
│   └── iac/                   # Terraform or equivalent (later)
│
├── docs/
│   ├── architecture/
│   ├── adrs/
│   ├── data-model/
│   ├── flows/
│   ├── suppliers/
│   └── prompts/
│
├── tools/                     # Dev scripts, codegen, linting
│
├── CLAUDE.md
├── README.md
├── TASKS.md
├── package.json               # pnpm workspaces root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── .gitignore
```

### Package rules

- **`domain`** has zero dependencies on infrastructure. Pure types and
  value objects. Every other package can depend on it.
- **`supplier-contract`** depends only on `domain`. No adapter
  implementations.
- **Adapter packages** each depend on `supplier-contract` + `domain` +
  supplier SDK. No adapter depends on another adapter.
- **`pricing`, `mapping`, `content`, `merchandising`, `booking`** each
  depend on `domain` and the relevant contracts. They do **not** import
  each other except through well-defined seams declared in `domain`.
- **`apps/api`** wires packages together (composition root). Business
  logic does not live here; wiring does.
- **`apps/worker`** shares the composition root but with different
  entry points (queue consumers).
- **Frontends** (`b2c-web`, `b2b-portal`, `admin`) depend on `ui`,
  `domain` types (for API contracts), and their own API client. They
  never import backend-internal packages.

### Dependency direction enforcement

- `import/no-restricted-paths` (ESLint rule) or a dedicated
  dependency-cruiser config enforces allowed directions in CI.
- Violations fail CI. No exceptions without an ADR update.

### Migrations and schema

- Migrations live in `infra/migrations/`, versioned, with both up and
  down where possible.
- Schema per module is enforced by naming conventions — tables owned
  by the `pricing` module prefix `pricing_`, and so on. One Postgres
  database, one schema per logical module (optional Phase 2+).

### Versioning

- Apps are not independently versioned; they ship from the monorepo
  tip.
- Shared packages are internal-only for now (no publish). If a
  package gets external consumers (e.g., a partner adapter SDK), we
  publish with Changesets.

## Consequences

- Module extraction to a separate service is "copy the package +
  composition wiring" rather than a major refactor.
- Onboarding is one `pnpm install` away from a working local stack.
- Dependency direction enforcement in CI prevents the two failure
  modes we actually care about: business logic leaking into apps, and
  modules reaching into each other around the seams.

## Open items

- Whether admin and b2b-portal stay separate apps or merge into one
  role-routed app — revisit end of Phase 2.
- Whether `infra/iac` uses Terraform, Pulumi, or SST — Phase 1 infra
  selection.

## Amendment 2026-04-21 (see ADR-012, ADR-013, ADR-014, ADR-015)

### New packages

```
packages/
  ledger/              # double-entry ledger primitives
                       #   (LedgerEntry, WalletAccount, balance view)
  payments/            # Stripe integration (PaymentIntent,
                       #   webhooks, Connect transfers)
                       # depends on: ledger, domain
  rewards/             # loyalty + referral engines,
                       #   maturation worker, fraud submodule
                       # depends on: ledger, domain, booking
  rate-intelligence/   # benchmark ingestion + query API
                       # depends on: domain (mapping shape only)
                       # DOES NOT depend on pricing; pricing reads it
  adapters/
    synxis/            # SynXis Channel Connect (CRS)
    rategain/          # RateGain Channel Manager (supply)
    siteminder/        # SiteMinder (supply)
    mews/              # Mews (PMS/CM)
    cloudbeds/         # Cloudbeds
    channex/           # Channex
                       # all follow ADR-003 contract with ADR-013
                       # ingestion-mode extension
```

### Dependency direction additions

- `ledger` has zero infrastructure dependencies beyond Postgres
  access via an injected port. Every other ledger consumer
  (`payments`, `rewards`, `booking`) depends on it.
- `rate-intelligence` must **not** import from `pricing`. `pricing`
  imports from `rate-intelligence` via a narrow typed read interface
  (ADR-015). The ESLint `import/no-restricted-paths` rule enforces
  this direction.
- `rewards` imports from `booking` only for booking-state event
  shapes. `booking` never imports from `rewards`; it emits events.
- Direct-connect adapters (`synxis`, `rategain`, etc.) follow the
  same rule as existing adapters: `supplier-contract` + `domain` +
  provider SDK. No cross-adapter imports.

### Infra additions

```
infra/
  migrations/
    ledger/            # ledger tables
    payments/          # payment intent / stripe event mirror tables
    rewards/           # loyalty, referral, fraud decision tables
    rate-intelligence/ # benchmark snapshot tables
    direct-connect/    # supply_ingested_rate, direct_connect_property
```

### Table prefixes

| Prefix | Owner module | Examples |
|---|---|---|
| `ledger_` | ledger | `ledger_entry`, `ledger_wallet_account` |
| `pay_` | payments | `pay_intent`, `pay_stripe_event`, `pay_credit_line` |
| `reward_` | rewards | `reward_earn_rule`, `reward_referral_invite`, `reward_fraud_decision` |
| `benchmark_` | rate-intelligence | `benchmark_snapshot`, `benchmark_hotel_mapping` |
| `supply_` | supplier (existing, extended) | `supply_ingested_rate`, `supply_direct_connect_property` |

The existing prefix ownership rules (`core_`, `hotel_`, `supply_`,
`pricing_`, `merch_`, `booking_`) are unchanged. A module never
writes to another module's tables.

## Amendment 2026-04-22 (see ADR-016, ADR-017)

### Additional packages

```
packages/
  documents/           # document issue + numbering + storage
                       #   (ADR-016). DocumentType, DocumentTemplate,
                       #   DocumentNumberSequence, BookingDocument,
                       #   DeliveryAttempt, issue/delivery workers.
                       # depends on: domain, ledger (read only),
                       #   object-storage port
  reseller/            # reseller capability (ADR-017):
                       #   ResellerProfile, BillingProfile,
                       #   TaxProfile, BrandingProfile,
                       #   ResellerResaleRule,
                       #   GuestPriceDisplayPolicy
                       # depends on: domain
  tax/                 # tax engine (future ADR); for now a
                       #   narrow port consumed by documents.
                       # depends on: domain
```

### Dependency direction additions

- `documents` imports from `reseller` for branding/policy
  resolution and from `ledger` (read only) for amounts. `reseller`
  does not import from `documents`.
- `booking` does not import from `documents`; it emits events
  that the document-issue-worker consumes (ADR-010 amendment).
- `documents` and `reseller` do not import from each other's
  persistence internals. Interaction is through typed ports
  defined in `domain`.

### Additional table prefixes

| Prefix | Owner module | Examples |
|---|---|---|
| `doc_` | documents | `doc_legal_entity`, `doc_number_sequence`, `doc_template`, `doc_booking_document`, `doc_delivery_attempt`, `doc_issue_policy` |
| `reseller_` | reseller | `reseller_profile`, `reseller_billing_profile`, `reseller_tax_profile`, `reseller_branding_profile`, `reseller_resale_rule`, `reseller_guest_price_display_policy` |

### Infra additions

```
infra/
  migrations/
    documents/         # legal_entity, number sequences, templates,
                       #   booking_document, delivery_attempt
    reseller/          # reseller profile + billing/tax/branding/
                       #   resale/display profile tables
```

### Object storage

`documents` and `reseller` (logo uploads) introduce the first
object-storage dependency. Local dev uses a MinIO-compatible
emulator (already planned in Phase 0). A single bucket per concern
(`documents`, `branding-assets`), with a write-once bucket policy
for legal-tax-doc PDFs.
