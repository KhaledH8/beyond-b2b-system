# Beyond Borders — Travel Distribution Platform

This file is the source of truth for Claude when working in this repository.
Read it before responding. Prefer what is written here over assumptions from
prior general projects.

---

## 1. What this project actually is

Beyond Borders is **not** a generic travel portal, and it is **not** a single
OTA website. It is a **travel distribution engine** that:

- Aggregates inventory from multiple wholesale suppliers and from direct hotel
  contracts into **one canonical sourcing model**.
- Sells that inventory to multiple audience types through different channels.
- Is designed from day one so the same engine can later be **resold or
  licensed to other travel agencies** as a platform, not just used in-house.

Because of the last point, every architectural decision must assume a future
second, third, or tenth tenant on the same codebase. Tenancy and
configurability are not afterthoughts.

---

## 2. Audiences (all first-class, none bolted on)

1. **B2C OTA** — retail public website, end travelers.
2. **B2B travel agencies** — other agencies booking on behalf of their
   clients, with their own markups and credit/terms.
3. **B2B subscribers / members** — closed user groups (associations, clubs,
   employer-affiliated groups, loyalty tiers) with members-only rates.
4. **B2B corporate accounts** — companies booking for their employees, with
   negotiated rates, policies, approval flows (policies/approval come later,
   not MVP).

Pricing, visibility rules, and merchandising must be **account-aware**, not
channel-type-aware alone. A single corporate account may later have custom
rules that differ from other corporate accounts.

---

## 3. Supply sources (planned)

Two categories, treated uniformly downstream:

### 3a. Aggregator / wholesaler feeds
- Hotelbeds
- WebBeds
- TBO
- Rayna — only if integration is technically confirmed
- Expedia Rapid — later phase
- Booking.com Demand API — only if commercially available and contractually
  permitted. Do **not** scaffold this until legal/commercial confirm.

### 3b. Direct hotel contracts and direct-connect
- Paper/PDF/spreadsheet contracts managed internally in the same canonical
  sourcing model.
- **Direct-connect via CRS** (Sabre SynXis Channel Connect, etc.) — treated
  as the same first-class direct source. Live content, ARI, and reservation
  via the CRS API.
- **Direct-connect via channel managers** (RateGain, SiteMinder, Mews,
  Cloudbeds, Channex) — push-mode ingestion of ARI, reservation via the
  channel manager's booking API. See ADR-013.
- Direct contracts (of any flavor) are a **first-class source**, not a side
  module, not an override layer. They enter the pipeline through the same
  adapter contract as any aggregator.

All sources — aggregator or direct (paper, CRS, channel manager) —
implement the **same supplier adapter contract**. Downstream code must not
know or care whether a rate came from Hotelbeds, from a signed direct
contract, from SynXis, or from a channel manager ARI push.

---

## 4. Canonical hotel model

- **One canonical hotel profile per real hotel.** If the same hotel appears in
  Hotelbeds, WebBeds, TBO, and a direct contract, it is still one profile
  internally with four linked supplier references.
- Hotel profiles are **sourced from supplier content and mapped**, not typed
  in by humans one at a time. Human input is reserved for resolving mapping
  conflicts, enriching, and flagging.
- **Static content** (name, address, geo, images, amenities, descriptions,
  star rating, chain) and **dynamic rate/availability** are handled
  separately. Static is cached and versioned; dynamic is fetched live (with
  short TTL caching only where the supplier allows).
- Mapping uses deterministic signals first (name + geo + address + known
  supplier codes) before any fuzzy/ML signal. Every mapping decision is
  auditable and reversible.

---

## 5. Pricing engine

Pricing precedence (highest wins is applied **after** cost is established):

1. **Net cost** from the winning source for that search (aggregator or
   direct), in source currency, converted to a chosen pricing currency.
2. **Markup rules** — account-aware first, market-aware via benchmarks:
   - Per-account markup (specific agency, specific corporate, specific
     subscriber group).
   - Per-account-type default markup (B2C, agency, subscriber, corporate).
   - Per-supplier override where allowed.
   - Per-market, per-destination, per-season, per-rate-class.
   - **Market-adjusted markup** using public-rate benchmark inputs from a
     separate `rate-intelligence` module (ADR-015). Benchmark data is
     advisory, never authoritative, never a sellable rate.
3. **Taxes and fees** handled as line items, not folded into markup.
4. **Promotions / discounts** applied last, on top of displayed price, and
   always traceable (which rule fired, why).

Pricing is **not** fixed markup. "Cost + 10% for everyone" is a temporary
sane default, never the architecture.

**Merchandising (sponsored / recommended / featured) is a separate layer.**
It can reorder or promote results in listings, but it must **never** mutate
the priced rate, the net cost, or the pricing rule chain. Breaking this rule
destroys trust with corporate and agency clients.

**Tender (wallet, loyalty, referral reward, agency credit, card payment) is
not a pricing concern.** Pricing produces the sellable amount; tender
composition pays it. Neither mutates the other. See ADR-012 and ADR-014.

**Supply connectivity (ADR-013) and market intelligence (ADR-015) are
separate modules.** Channel-manager ARI is supply we sell; benchmark data
is advisory pricing input. Do not conflate them.

---

## 6. Non-goals for MVP and phasing

Scope is **architecture-first-class, phased-in-delivery** for the following.
They are designed for now, built later:

- **Wallet, payments, credit ledger** (ADR-012) — Stripe rail + internal
  ledger. Phase 2 for basic cash and card + B2B credit line scaffolding.
- **Loyalty and referral** (ADR-014) — earn + maturation + clawback + B2C
  referral with anti-fraud. Phase 2 for loyalty scaffolding, Phase 3 for
  referral with anti-fraud.
- **Direct CRS / channel-manager connectivity** (ADR-013) — Phase 3 first
  adapter (SynXis likely), more in Phase 4.
- **Market-aware pricing with benchmark inputs** (ADR-015) — Phase 4.

Explicitly **do not build** in MVP, and do not architect toward them:

- Flights (hotels first — flights is a different economic and integration
  shape, likely separate later).
- Transfers, activities, packages, dynamic packaging.
- Gamification and multi-level referral chains.
- Full finance / accounting / GL. Basic bookings ledger only in MVP; proper
  finance integration is a later, deliberate project.
- Approval workflows / travel policies for corporate.

MVP is about proving the **sourcing → mapping → pricing → booking → tender
→ reward accrual** spine on hotels with at least two aggregator suppliers
and one direct contract.

---

## 7. Engineering principles

- **Prefer boring, reliable patterns over clever ones.** This system will
  outlive any one developer's tenure.
- **Additive and reversible changes.** New files and clear docs over silent
  restructuring.
- **Explicit contracts at seams.** Supplier adapters, pricing rule inputs,
  mapping outputs — all typed, documented, and versioned.
- **Static/dynamic split is sacred.** Do not cache dynamic rates beyond what
  each supplier's terms allow, and do not treat supplier content as
  authoritative without a mapping step.
- **State uncertainty clearly.** If a design choice is a guess, say so in the
  ADR, do not hide it in code.
- **No premature abstraction.** Three similar lines beat the wrong base
  class. Abstract only when the third real supplier demands it.

---

## 8. Safety and change control

- **Never delete files unless the user explicitly approves.**
- **Never rename or move files without explaining why first and getting
  approval.**
- Before any risky refactor, create or reference a **checkpoint plan** (what
  is the rollback, what tests cover the blast radius).
- Keep changes additive where possible.
- If something is uncertain, say so plainly in the response. Do not paper
  over it.
- Do not run destructive git operations (force push, hard reset, branch
  delete) without explicit approval.

---

## 9. Compact Instructions

When this conversation is summarized or compacted, the summary **must
preserve** the following, verbatim or near-verbatim:

1. **Architecture decisions** — anything recorded in `docs/adrs/` and any
   decision taken in-session that has not yet been written into an ADR.
2. **Domain entities** — the canonical hotel model, supplier references,
   rate, booking, account, markup rule, mapping record, **wallet accounts
   and ledger entries, credit lines, loyalty earn rules, referral invites
   and fraud decisions, benchmark snapshots, direct-connect properties**.
3. **Supplier adapter contract** — the interface all sources (aggregator,
   direct paper, direct CRS, direct channel manager) implement, including
   the ingestion-mode (PULL/PUSH/HYBRID) capability. Any change to it is
   load-bearing.
4. **Pricing rule precedence** — the order in section 5 of this file,
   including `MARKET_ADJUSTED_MARKUP` and the tender/pricing separation.
5. **Hotel mapping rules** — deterministic-first, auditable, reversible,
   conflict-resolution is human-in-the-loop.
6. **Direct contract / direct-connect rules** — all direct sources (paper,
   CRS, channel manager) are first-class and go through the same adapter
   contract, not side modules.
7. **Wallet model** — internal double-entry ledger; Stripe is a rail only;
   cash/promo/loyalty/referral/agency-credit are separate books; tender is
   not a pricing rule.
8. **Rewards lifecycle** — accrue PENDING, mature POSTED after clawback
   window, clawback on cancellation; referral requires anti-fraud
   clearance before posting.
9. **Rate intelligence separation** — public-rate benchmarks are advisory
   pricing input, never supply, never authoritative, never cross-tenant
   without explicit configuration.
10. **List of modified files in the current session.**
11. **Open risks** — anything flagged as uncertain, blocked, or dependent
    on external confirmation (e.g. "Rayna unconfirmed", "Booking.com
    Demand API pending commercial", "UAE stored-value wallet legal review
    pending", "SynXis partner certification required", "scraper data
    legal review per jurisdiction").
12. **Next tasks** — the current top of `TASKS.md` and any in-flight work
    not yet captured there.

If any of the above is at risk of being lost in a compact, **stop and write
it to a file first** (ADR, `TASKS.md`, or a dated note in `docs/`) before
compacting.

---

## 10. Do Not Forget

Highest-risk business truths. Violating any of these has asymmetric downside.

- **This is a platform, not a website.** It will be sold to other agencies.
  Do not hardcode Beyond Borders branding, currency, tax rules, or business
  logic where it could be configuration.
- **Direct contracts are first-class.** They are the margin business. If the
  system treats them as a bolt-on, the whole commercial case weakens.
- **One canonical hotel per real hotel.** Duplicate hotels destroy search
  UX, inflate costs, and poison analytics. Mapping is not optional.
- **Static content and dynamic rates are different animals.** Caching
  dynamic rates like static content will get us into contractual and
  commercial trouble with suppliers.
- **Pricing is account-aware, not channel-aware.** Two corporate accounts
  can have completely different markups, visibility, and negotiated rates.
- **Merchandising must not mutate priced rates.** Sponsored placement is a
  display concern only.
- **Booking.com Demand API is not a given.** Assume it is unavailable until
  commercial and legal say otherwise. Do not build toward it prematurely.
- **Rayna is unconfirmed.** Treat it as a conditional adapter.
- **MVP scope discipline.** Flights, transfers, dynamic packaging, full
  finance / GL — all out. Re-scoping inward is cheaper than outward.
  (Loyalty and referral moved to architecture-first-class, phased — see §6
  and ADR-014.)
- **Tenancy is a day-one concern.** Even if we only serve Beyond Borders on
  day one, data models, config, and auth should not preclude a second tenant.
- **Wallet is our ledger, not Stripe.** Stripe is a payment rail. Stripe
  Customer Balance is not the wallet. Stripe Treasury is not assumed for
  UAE. Internal double-entry ledger is truth; Stripe events are ingested
  into it.
- **Tender is not pricing.** Wallet, loyalty, referral, credit, card are
  tenders paying a sellable amount. Pricing produces the amount; tenders
  never mutate it.
- **Rewards mature; they don't pay out instantly.** Accrue PENDING,
  mature POSTED after clawback window + supplier stay confirmation.
  Referral additionally requires anti-fraud clearance.
- **Supply connectivity ≠ market intelligence.** Channel-manager ARI is
  supply we sell. Benchmark/rate-shop data is advisory pricing input.
  Different modules, different tables, different audit trails.
- **Direct-connect carries a certification tax.** CRS and channel-manager
  integrations have meaningful commercial / onboarding overhead beyond
  the adapter code. Plan for this in the roadmap.

---

## 11. How Claude should work in this repo

- Always read this file and `docs/prompts/session-start.md` at the start of a
  new session.
- Always update `TASKS.md` when taking or finishing a task.
- Always record material architecture decisions as a new ADR in
  `docs/adrs/`.
- When a supplier-specific rule, quirk, or limitation is discovered, write
  it to `docs/suppliers/<supplier>.md` (create the file if missing).
- When a data-model decision is made, update `docs/data-model/`.
- When a flow (search, book, cancel, reconcile) is designed, document it in
  `docs/flows/`.
- Prefer editing existing docs over creating parallel ones.
