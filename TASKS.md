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

## Next (immediate build queue)

- [ ] Draft ADR-002: Canonical hotel data model (entities, identifiers,
      relationships to supplier references). Do not implement schema yet.
- [ ] Draft ADR-003: Supplier adapter contract (the interface every source —
      aggregator or direct — must implement).
- [ ] Draft ADR-004: Pricing rule model and precedence (account-aware
      markup, taxes/fees as line items, promotions layer, merchandising
      separation).
- [ ] Draft ADR-005: Static vs dynamic content split (what is cached, where,
      TTLs, authority of record).
- [ ] Draft ADR-006: Tenancy and account model (Beyond Borders as first
      tenant, design so a second tenant is not a rewrite).
- [ ] Draft ADR-007: Tech stack choice (language, framework, datastore,
      queue, cache). Deliberately deferred until entity and contract ADRs
      are done, so tech follows shape, not the reverse.
- [ ] Write `docs/suppliers/hotelbeds.md`, `webbeds.md`, `tbo.md` stubs
      capturing what we know about auth, content API, rate API, booking API,
      cancellation policy handling, and unique quirks.
- [ ] Write `docs/flows/search.md` — end-to-end search flow from user query
      to ranked, priced results, across multiple sources, with
      merchandising as a final re-rank pass.
- [ ] Write `docs/flows/booking.md` — booking, confirmation, voucher,
      cancellation, and supplier reconciliation expectations.
- [ ] Decide mapping strategy v1 (deterministic signals, conflict queue,
      human review UI sketch) and record as ADR-008.

## Later (explicitly deferred)

- [ ] Flights, transfers, activities, dynamic packaging.
- [ ] Loyalty / rewards.
- [ ] Full finance / accounting integration (beyond a basic bookings
      ledger).
- [ ] Corporate approval workflows and travel policies.
- [ ] Rayna integration (pending technical confirmation).
- [ ] Expedia Rapid (later phase).
- [ ] Booking.com Demand API (pending commercial + legal approval).

## Open risks / uncertainties

- [!] Rayna feed technical availability and data shape — unconfirmed.
- [!] Booking.com Demand API — commercial eligibility unknown, do not build
      toward it yet.
- [!] Direct contract data format — expect heterogeneity (PDFs,
      spreadsheets, emails). Intake tooling will be non-trivial; flagged
      early so it does not surprise MVP.
- [!] Mapping accuracy at scale — deterministic-first is cheap; fuzzy and ML
      layers are not. Out of MVP unless needed.
