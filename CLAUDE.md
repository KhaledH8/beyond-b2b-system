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

### 3b. Direct hotel contracts
- Managed internally in the same canonical sourcing model.
- Direct contracts are a **first-class source**, not a side module, not an
  override layer, not a spreadsheet import. They enter the pipeline through
  the same adapter contract as any aggregator.

All sources — aggregator or direct — implement the **same supplier adapter
contract**. Downstream code must not know or care whether a rate came from
Hotelbeds or from a signed direct contract.

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
2. **Markup rules** — account-aware first, later market-aware:
   - Per-account markup (specific agency, specific corporate, specific
     subscriber group).
   - Per-account-type default markup (B2C, agency, subscriber, corporate).
   - Per-supplier override where allowed.
   - Later: per-market, per-destination, per-season, per-rate-class.
3. **Taxes and fees** handled as line items, not folded into markup.
4. **Promotions / discounts** applied last, on top of displayed price, and
   always traceable (which rule fired, why).

Pricing is **not** fixed markup. "Cost + 10% for everyone" is a temporary
sane default, never the architecture.

**Merchandising (sponsored / recommended / featured) is a separate layer.**
It can reorder or promote results in listings, but it must **never** mutate
the priced rate, the net cost, or the pricing rule chain. Breaking this rule
destroys trust with corporate and agency clients.

---

## 6. Non-goals for MVP

Explicitly **do not overbuild** in MVP:

- Flights (hotels first — flights is a different economic and integration
  shape, likely separate later).
- Transfers, activities, packages.
- Loyalty points, gamification, referral engines.
- Full finance / accounting / GL. Basic bookings ledger only in MVP; proper
  finance integration is a later, deliberate project.
- Approval workflows / travel policies for corporate.
- Dynamic packaging.

MVP is about proving the **sourcing → mapping → pricing → booking** spine on
hotels with at least two aggregator suppliers and one direct contract.

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
   rate, booking, account, markup rule, mapping record.
3. **Supplier adapter contract** — the interface all sources (aggregator and
   direct) implement. Any change to it is load-bearing.
4. **Pricing rule precedence** — the order in section 5 of this file.
5. **Hotel mapping rules** — deterministic-first, auditable, reversible,
   conflict-resolution is human-in-the-loop.
6. **Direct contract rules** — direct contracts are a first-class source
   going through the same adapter contract, not a side module.
7. **List of modified files in the current session.**
8. **Open risks** — anything flagged as uncertain, blocked, or dependent on
   external confirmation (e.g. "Rayna integration unconfirmed",
   "Booking.com Demand API pending commercial approval").
9. **Next tasks** — the current top of `TASKS.md` and any in-flight work not
   yet captured there.

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
- **MVP scope discipline.** Flights, transfers, loyalty, full finance — all
  out. Re-scoping inward is cheaper than re-scoping outward.
- **Tenancy is a day-one concern.** Even if we only serve Beyond Borders on
  day one, data models, config, and auth should not preclude a second tenant.

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
