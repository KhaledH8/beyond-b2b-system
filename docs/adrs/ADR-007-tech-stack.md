# ADR-007: Tech stack choice

- **Status:** Accepted (provisionally — revisit after first adapter)
- **Date:** 2026-04-21

## Context

We deferred the stack until the domain shape was visible (ADR-001 D9).
With ADRs 002–006 drafted, the shape is clear enough to pick a stack
that fits. Choice criteria, in order: reliability, hireability, fit for
a modular monolith with async workers, fit for multi-supplier
integration, frontend/backend code sharing.

## Decision

### Backend

- **Language:** TypeScript on Node.js (current LTS).
- **Framework:** NestJS.
- **Why:** NestJS gives a clear module boundary system that matches our
  modular-monolith plan, strong typing end-to-end, a large ecosystem
  of supplier SDKs in TS/JS, and the ability to share types with the
  frontend via the monorepo.
- **Alternatives considered:**
  - Python/FastAPI — excellent for data work and future ML mapping, but
    weaker for long-lived supplier SDKs and no native monorepo
    type-sharing with a TS frontend.
  - Go — great operational profile, smaller ecosystem for travel
    SDKs, steeper team ramp.
  - Java/Kotlin — traditional travel-industry choice, heavy for an
    MVP-sized team.

### Datastore (primary)

- **PostgreSQL 16+** with **PostGIS**.
- JSONB for supplier raw payloads and flexible rule scopes.
- PostGIS for geo search and hotel mapping geo signals.
- Logical replication available for later read-replica scaling.

### Cache

- **Redis** — hot lookups, rate-limit counters, short-lived ephemeral
  state.

### Queue / workers

- **BullMQ** (Redis-backed) for MVP.
- Reassess **Temporal** for booking orchestration at Phase 3 if the
  saga complexity justifies the operational weight.

### Search

- **Postgres + PostGIS** for MVP (up to ~1–2M indexed hotels and
  typical OTA search patterns).
- **OpenSearch** migration at Phase 5 when facet/relevance needs
  outgrow Postgres.

### Frontend

- **Next.js** (React, App Router) for all three portals and the B2C
  site. B2C benefits from SSR/SEO; portals benefit from the same
  deployable shape to reduce tooling sprawl.
- **Tailwind CSS + shadcn/ui** (or equivalent headless-UI kit) for
  consistent theming and eventual white-labeling across tenants.

### Monorepo tooling

- **pnpm workspaces + Turborepo**.
- **TypeScript project references** for fast incremental builds.
- **Changesets** for internal package versioning (when relevant).

### Observability

- **OpenTelemetry** from day one (traces, metrics, logs).
- Backend: Pino for logs, OTel for traces/metrics.
- Ship to a vendor-neutral collector; pick a backend (Grafana stack,
  Datadog, Honeycomb) at Phase 2.

### Object storage

- **S3-compatible** (AWS S3 or Cloudflare R2). Decide cloud provider
  at infra-selection time (not part of this ADR).

### Auth

- **OIDC-based** (Auth0, Clerk, WorkOS, or self-hosted Keycloak).
  Decision deferred to Phase 1 infra setup, but the interface inside
  the app is abstracted behind a small auth service.

### Testing

- **Vitest** for unit tests.
- **Playwright** for end-to-end.
- A dedicated **adapter conformance suite** (ADR-003).

### CI / CD

- GitHub Actions (or equivalent). Required checks: typecheck, lint,
  unit tests, adapter conformance (on adapter changes), Playwright
  smoke.

## Consequences

- The team needs TypeScript and Postgres fluency — widely available.
- NestJS adds some ceremony; worth it for module boundaries. If it
  becomes friction at scale we can extract modules into separate
  services without rewriting their internals.
- PostGIS in Postgres keeps the MVP infra small (one database engine).
- BullMQ is simple; we accept that saga-like flows will be explicit
  state machines until we revisit Temporal.

## Revisit triggers

- Search relevance or facet needs clearly exceed Postgres → migrate
  search to OpenSearch (planned at Phase 5).
- Booking saga failure modes become hard to reason about → consider
  Temporal.
- A specific supplier only has a Java/Python SDK with no usable TS
  alternative → write a sidecar, not a rewrite.

## Open items

- Exact cloud/infra provider (AWS vs GCP vs hybrid).
- Auth provider decision.
- Logging/metrics backend.
