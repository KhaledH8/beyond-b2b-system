# TASKS

Running task list for Beyond Borders. Newest at the top of each section.
Claude must keep this file current at the start and end of every working
session.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

---

## Now (this session)

- [x] Create foundational repo docs: CLAUDE.md, README.md, TASKS.md,
      docs/architecture/overview.md, docs/adrs/ADR-001-foundation.md,
      docs/prompts/session-start.md, .gitignore baseline.
- [x] ADR-002 canonical hotel data model
- [x] ADR-003 supplier adapter contract
- [x] ADR-004 pricing rule model and precedence
- [x] ADR-005 static vs dynamic content split
- [x] ADR-006 tenancy and account model
- [x] ADR-007 tech stack (provisional)
- [x] ADR-008 hotel mapping strategy
- [x] ADR-009 merchandising and ranking
- [x] ADR-010 booking orchestration
- [x] ADR-011 monorepo structure
- [x] Update architecture overview to reflect ADRs 002–011
- [x] Domain entities cross-cutting index (`docs/data-model/entities.md`)
- [x] Phased roadmap (`docs/roadmap.md`)
- [x] ADR-012 payments, wallet, credit ledger, payouts
- [x] ADR-013 direct hotel connectivity (CRS / channel managers)
- [x] ADR-014 loyalty, rewards, referral
- [x] ADR-015 market benchmark / intelligent markup
- [x] Amend ADR-003 / ADR-004 / ADR-006 / ADR-010 / ADR-011 for the
      scope expansion (additive sections)
- [x] Update CLAUDE.md §3 / §5 / §6 / §9 / §10 for scope expansion
- [x] Update README.md (sources, wallet, rewards, phased scope)
- [x] Update `docs/architecture/overview.md` (invariants + module map)
- [x] Update `docs/data-model/entities.md` (ledger, rewards,
      rate-intelligence, direct-connect entities + table prefixes)
- [x] Update `docs/roadmap.md` for Phase 2–6 revisions
- [x] Connectivity notes: `docs/suppliers/synxis.md`, `rategain.md`,
      `siteminder.md`, `mews.md`, `cloudbeds.md`, `channex.md`
- [x] Design note: `docs/design/payments.md`
- [x] Design note: `docs/design/rewards-referral.md`

## Next (Phase 0 — finishing the foundation)

- [ ] Repo scaffolding: pnpm workspaces + Turborepo + `tsconfig.base.json`
      + ESLint with `import/no-restricted-paths` for dependency direction.
- [ ] Empty `apps/api` (NestJS) with a health endpoint.
- [ ] Empty `apps/worker` sharing the composition root.
- [ ] Empty `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` (Next.js).
- [ ] `packages/domain` with zero-dependency core types scaffold.
- [ ] `packages/supplier-contract` with the interface from ADR-003
      (including the ADR-013 ingestion-mode amendment).
- [ ] `packages/ledger` skeleton — `LedgerEntry`, `WalletAccount`,
      balance view ports (no implementation yet).
- [ ] `packages/payments` skeleton — Stripe port interface only.
- [ ] `packages/rewards` skeleton — earn-rule and referral-invite
      types, maturation-worker entry point.
- [ ] `packages/rate-intelligence` skeleton — `BenchmarkSnapshot`
      type + read-only query port.
- [ ] Local dev Docker Compose: Postgres+PostGIS, Redis, object storage
      emulator. (Optional: add Stripe CLI service for webhook testing.)
- [ ] CI baseline: typecheck, lint, unit tests, dependency-direction
      lint (including pricing → rate-intelligence allowed but not
      reverse).
- [ ] OpenTelemetry wiring (backend + workers).
- [ ] Aggregator stubs: `docs/suppliers/hotelbeds.md`, `webbeds.md`,
      `tbo.md` capturing known API shape, auth, quirks.
- [ ] `docs/flows/search.md`, `docs/flows/booking.md`,
      `docs/flows/tender-resolution.md`, `docs/flows/reward-lifecycle.md`
      (first drafts).

## Later (beyond Phase 0)

See `docs/roadmap.md`. Phase 1 onward.

## Open risks / uncertainties

- [!] **Rayna** integration — technical availability and data shape
      unconfirmed. Adapter is conditional.
- [!] **Booking.com Demand API** — commercial eligibility unknown; do
      not build toward it yet.
- [!] **Direct contract intake heterogeneity** — PDFs, spreadsheets,
      emails. Intake tooling budget must not be underestimated.
- [!] **Direct-connect certification tax** — SynXis, RateGain,
      SiteMinder, Mews, Cloudbeds, Channex each carry commercial /
      onboarding / certification overhead beyond adapter code. Plan a
      quarter of calendar time per provider to first-live with one
      hotel (ADR-013).
- [!] **Mapping at scale** — fuzzy matching and human review UI are
      Phase 2+ work; coverage depends on a cross-reference like Giata,
      which is a commercial decision.
- [!] **Supplier rate-limit and sandbox quality** — varies widely; plan
      for per-adapter back-pressure and recorded fixtures for CI.
- [!] **Multi-hotel carts** — deliberately out of MVP (ADR-010). Adding
      later is non-trivial.
- [!] **Payment provider choice** — Stripe confirmed by ADR-012 as the
      rail (via Stripe Connect). Stripe Customer Balance and Stripe
      Treasury explicitly rejected as the wallet.
- [!] **UAE stored-value wallet legal review** — `CASH_WALLET`
      (ADR-012) is paused pending jurisdictional legal clearance.
      `PROMO_CREDIT`, `LOYALTY_REWARD`, `REFERRAL_REWARD` are
      non-stored-value and lower-risk to launch first.
- [!] **Referral fraud** — anti-fraud is non-optional before launch
      (ADR-014). Budget real operational tooling, not just signals.
- [!] **Rate-intelligence legal/ethics** — public-rate benchmark
      ingestion (scraping or commercial feeds) requires per-tenant,
      per-jurisdiction legal review before enablement (ADR-015).
- [!] **Benchmark source commercial selection** — RateGain DataLabs
      vs OTA Insight vs Lighthouse vs bespoke scraper; Phase 4 decision.
- [!] **Auth provider** — decision deferred to Phase 1 infra selection.
