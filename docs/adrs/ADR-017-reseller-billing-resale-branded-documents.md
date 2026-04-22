# ADR-017: Reseller accounts, billing, resale controls, and branded guest documents

- **Status:** Accepted
- **Date:** 2026-04-22
- **Supersedes:** nothing
- **Amends:** ADR-006 (tenancy and account model — generalizes
  "agency reselling" into a `ResellerCapability` cutting across
  AGENCY and SUBSCRIBER account types, introduces `BillingProfile`,
  `TaxProfile`, `BrandingProfile`, `ResellerProfile`), ADR-004
  (pricing — `resale_amount` is a reseller display output, never a
  pricing rule), ADR-012 (payments — Beyond Borders tax invoice is
  based on the sell-to-reseller amount; guest-facing resale amount
  is not a ledger fact)
- **Depends on:** ADR-016 (document generation, numbering, storage)

## Context

Previously "agency" meant "a B2B account with credit and markup." We
are now committing to two things that a flat agency model cannot
carry cleanly:

1. **Some accounts resell to their own end customers** and need to
   present the booking to those customers as *their own product*.
   That includes travel agencies, but it also includes subscriber /
   member-group operators who want to appear to their members as the
   provider. Future reseller classes (e.g. resale-enabled corporate
   TMCs, marketplace partners) must slot into the same shape without
   a re-plumb.
2. **Money, tax, and branding are three different concerns that
   currently tangle.** A reseller's "VAT details" are a legal fact
   about their business. Their "invoice email" is an operational
   routing fact. Their "logo on the voucher" is a presentation fact.
   Their "sell rate to the guest" is a commercial output we must
   display but never settle on. A single `Account.settings` blob
   would destroy the audit trail.

The corrective model has to express:

- Reseller capability is a **role a non-B2C account can take on**,
  not a new account type. An agency may or may not resell; a
  subscriber group may or may not resell; corporate accounts
  generally do not but could.
- Billing / tax / branding / resale-control are each their own
  **profile**, each with its own lifecycle and audit trail.
- The **guest-facing resale amount never leaks into the ledger**.
  Our books record what we sold to the reseller. The reseller's
  presentation to the guest is a document property.
- **Beyond Borders issues a tax invoice to the reseller** (legal
  record), and the reseller separately issues their own branded
  confirmation/voucher to the guest. These documents are
  distinct — different numbering, different content, different
  legal weight (ADR-016).

## Decision

### Reseller capability, not reseller account type

```
ResellerProfile {
  reseller_profile_id
  tenant_id
  account_id                    // an AGENCY or SUBSCRIBER (or
                                //   future class) Account
  status                        // ACTIVE | SUSPENDED | RETIRED
  reseller_class                // AGENCY | SUBSCRIBER_GROUP |
                                //   CORPORATE_TMC | OTHER
  onboarded_at
  onboarding_status             // PENDING_KYC | VERIFIED | ...
  billing_profile_id            // → BillingProfile
  tax_profile_id                // → TaxProfile
  branding_profile_id           // → BrandingProfile
  resale_rule_id                // → ResellerResaleRule
  guest_price_display_policy_id // → GuestPriceDisplayPolicy
  document_issue_policy_ref     // which documents we/they issue
                                //   (ADR-016 DocumentIssuePolicy)
  credit_line_id?               // optional; B2B credit (ADR-012)
  notes
}
```

An account without a `ResellerProfile` is not a reseller.
B2C accounts can never hold a `ResellerProfile`. Subscriber groups
that do not resell (closed-group buyers for internal consumption
only) also do not hold one — they simply consume.

A user familiar with earlier drafts should read: the "AGENCY
account_type" remains exactly as ADR-006 defines it. This ADR does
not collapse it. This ADR adds an orthogonal capability that other
account types can also carry.

### BillingProfile

```
BillingProfile {
  billing_profile_id
  tenant_id
  owner_kind                    // ACCOUNT | LEGAL_ENTITY
  owner_id                      // account_id or legal_entity_id
  legal_name                    // may differ from account name
  billing_address {
    line1, line2, city, region, postal_code, country
  }
  billing_contact {
    name, email_primary, email_cc[], phone?
  }
  billing_currency              // preferred invoicing currency
  invoice_delivery {
    channel[]                   // EMAIL | PORTAL | API_WEBHOOK
    email_to                    // may differ from billing_contact
    email_cc[]
    attach_pdf                  // bool
    attach_csv_line_items       // bool
  }
  payment_instrument_ref?       // default settlement reference
                                //   (bank details, card, etc.)
  status                        // ACTIVE | RETIRED
  version, effective_from
}
```

Versioning is deliberate: an invoice that went out under v1 stays
linked to v1's billing_contact, not the v2 the reseller updated
later. ADR-016 immutability applies — the invoice captures a
snapshot of addresses/contacts at issue.

### TaxProfile

```
TaxProfile {
  tax_profile_id
  tenant_id
  owner_kind                    // ACCOUNT | LEGAL_ENTITY
  owner_id
  registrations[] {
    scheme                      // UAE_VAT | KSA_ZATCA | EU_VAT |
                                //   NONE | ...
    registration_number
    jurisdiction                // country / region code
    effective_from, effective_to?
    evidence_document_id?       // scan of registration cert
  }
  tax_treatment_hint            // STANDARD | REVERSE_CHARGE |
                                //   ZERO_RATED | EXEMPT | UNKNOWN
                                //   — input to the tax engine,
                                //   not a substitute for it
  place_of_business             // country/region — place-of-supply
                                //   input
  is_vat_registered             // derived convenience flag
  status                        // ACTIVE | UNDER_REVIEW | RETIRED
  version, effective_from
}
```

`TaxProfile` feeds the tax engine (separate ADR). Nothing in this
ADR computes VAT; it only captures the inputs the tax engine needs
and binds them to ledger-posting time.

### BrandingProfile

```
BrandingProfile {
  branding_profile_id
  tenant_id
  reseller_account_id?          // null = platform (Beyond Borders
                                //   default)
  brand_display_name            // "Falcon Holidays"
  logo_asset_ref?               // object storage ref; uploaded
                                //   image, validated MIME + size
  logo_alt_text
  primary_color_hex?            // single color; deeper theming
                                //   deferred
  contact_block {
    email?, phone?, website?,
    address_lines[]
  }
  footer_html?                  // sanitized, allowlisted tags only
  legal_disclaimer_text?
  locale_defaults {
    language, currency_for_guest_display
  }
  status                        // ACTIVE | RETIRED
  version, effective_from
}
```

#### Branding fallback chain — hard order

When a reseller-branded document renders, branding resolves in
this strict order; the first hit wins:

1. Reseller `BrandingProfile` with `logo_asset_ref` set and logo
   asset healthy.
2. Reseller `BrandingProfile` with no logo but
   `brand_display_name` set (text-only header).
3. Reseller `BrandingProfile` missing or retired — fall through to
   `brand_display_name` pulled from `Account.name`.
4. All of the above missing — platform default branding (Beyond
   Borders) with a footer note identifying the reseller account by
   name. This is a soft fallback; operations gets an alert because
   a reseller without branding resolution is an onboarding gap.

Logo uploads are validated: MIME allowlist (`image/png`,
`image/jpeg`, `image/svg+xml` with stripping), max dimensions, max
size, virus scan hook. Logo is content-hash addressed; the hash is
recorded on the issued document so re-rendering is deterministic.

### ResellerResaleRule — how the reseller sets the guest-facing amount

```
ResellerResaleRule {
  resale_rule_id
  tenant_id
  reseller_account_id
  mode                          // FIXED_GUEST_AMOUNT |
                                //   FIXED_MARKUP_ABSOLUTE |
                                //   PERCENT_MARKUP |
                                //   HIDE_PRICE
  params {
    // one of:
    fixed_guest_amount_minor?
    fixed_markup_minor?
    percent_markup_basis_points?  // 500 = 5%
    // optional for any of the above:
    round_to_minor?             // e.g. round to nearest 1.00
    floor_minor?                // never below buy amount
    ceiling_minor?
  }
  display_currency              // may differ from ledger currency
                                //   (explicit FX rule selection)
  fx_strategy                   // LIVE_AT_ISSUE | FIXED_RATE |
                                //   RESELLER_CONFIGURED
  status                        // ACTIVE | RETIRED
  version, effective_from
}
```

Modes:

- **`FIXED_GUEST_AMOUNT`** — reseller sets a specific amount to show
  the guest. The delta from their buy amount is their margin; we
  do not track it. Example: reseller buys from us at 420 AED, shows
  guest 475 AED.
- **`FIXED_MARKUP_ABSOLUTE`** — guest amount = buy amount + fixed
  delta (e.g. +50 AED).
- **`PERCENT_MARKUP`** — guest amount = buy amount × (1 + pct).
- **`HIDE_PRICE`** — no amount displayed on the guest document.
  Used by B2B agents who present a separately priced quote offline.
  The document still exists, with no price line.

Invariants enforceable at document-render time:

- `floor_minor` if set ≥ reseller buy amount. Resale must never
  display below the reseller's buy amount (we do not underwrite
  reseller loss on their own books).
- `FIXED_GUEST_AMOUNT` must be ≥ reseller buy amount, or the
  document render refuses and the reseller gets a configuration
  error.
- `HIDE_PRICE` still requires reseller-buy-amount in the
  reseller's own admin view; it is only the *guest*-facing render
  that hides the price.

### GuestPriceDisplayPolicy

A thin layer on top of `ResellerResaleRule` that captures
*presentation* preferences independent of the amount calculation,
so reseller admins can configure both together:

```
GuestPriceDisplayPolicy {
  policy_id
  tenant_id
  reseller_account_id
  show_tax_lines                // bool — show or roll up
  show_currency_prominent       // bool
  show_cancellation_policy_snippet
  show_room_and_guest_details   // default true
  show_payment_terms_if_any
  show_buy_price                // MUST be false for guest-facing
                                //   docs; present for internal
                                //   agent preview only
  status, version, effective_from
}
```

`show_buy_price = true` on a guest-facing document is rejected at
render time. It is an invariant, not a field the reseller can
toggle on.

### Amount separation — hard rule

Three amounts are tracked distinctly and never co-mingled:

| Amount | Source | Where it lives | Who sees it |
|---|---|---|---|
| `source_cost` | supplier quote (ADR-003) | `PricingTrace`, `Booking` | internal, ops |
| `bb_sell_to_reseller_amount` | our pricing output (ADR-004) | `PricedOffer.total`, `Booking`, `PricingTrace`, ledger `SPEND` | us (always), reseller (on our tax invoice) |
| `reseller_resale_amount` | `ResellerResaleRule` evaluated at document issue | `BookingDocument.amounts` on `RESELLER_GUEST_*` docs only | guest (on reseller-branded docs) |

The ledger **never** records `reseller_resale_amount`. The
reseller's own books, outside Beyond Borders, record their margin.
We are not their accounting system.

The pricing trace (ADR-004) continues to trace only `source_cost`
→ `bb_sell_to_reseller_amount`. It does not attempt to trace the
reseller's markup. A separate `ResellerResalePreview` structure is
attached to the booking for display purposes only and references
the `ResellerResaleRule` version used.

### Document responsibilities

Mapping the earlier tangled bullet list onto ADR-016 document types:

| Document | Who issues | Numbering scope | Based on |
|---|---|---|---|
| `TAX_INVOICE` | Beyond Borders legal entity | gapless, per legal entity + jurisdiction + fiscal year | `bb_sell_to_reseller_amount` + tax engine |
| `CREDIT_NOTE` / `DEBIT_NOTE` | Beyond Borders legal entity | gapless, per legal entity + jurisdiction | references a `TAX_INVOICE` |
| `BB_BOOKING_CONFIRMATION` | Beyond Borders (tenant #1) | monotonic per tenant | booking + our amount |
| `BB_VOUCHER` | Beyond Borders (tenant #1) | monotonic per tenant, separate sequence | booking |
| `RESELLER_GUEST_CONFIRMATION` | Reseller account (via us) | monotonic per (tenant, reseller account) | booking + `reseller_resale_amount` |
| `RESELLER_GUEST_VOUCHER` | Reseller account (via us) | monotonic per (tenant, reseller account) | booking + `reseller_resale_amount` |

For a single booking sold through a reseller, the default document
set is:

- `TAX_INVOICE` (BB → reseller legal entity), emailed to
  reseller's `BillingProfile.invoice_delivery.email_to`.
- `BB_BOOKING_CONFIRMATION` (internal / reseller-facing commercial
  confirmation).
- `RESELLER_GUEST_CONFIRMATION` (reseller → guest, branded).
- `RESELLER_GUEST_VOUCHER` (reseller → guest, branded, with hotel
  check-in details).

The BB voucher is *not* issued on reseller-channel bookings by
default, because the guest is expected to present the reseller's
voucher at the hotel. The hotel's direct-connect / aggregator
booking record is the ground truth for supplier recognition; the
voucher is a guest-facing operational document, not a supplier
handshake.

For direct-to-consumer Beyond Borders bookings (no reseller): the
default set is `TAX_INVOICE` + `BB_BOOKING_CONFIRMATION` +
`BB_VOUCHER`, as declared in ADR-016.

### Tax invoice to the reseller — legal record

The `TAX_INVOICE` is issued from the Beyond Borders `LegalEntity`
to the reseller's `BillingProfile` + `TaxProfile`. Its `amounts`:

- Line items derived from the `Booking` + `PricingTrace`.
- Tax lines computed by the tax engine using:
  - BB legal entity's `tax_registration` (seller side)
  - Reseller's `TaxProfile.registrations` + `place_of_business`
    (buyer side)
  - `bb_sell_to_reseller_amount` as the taxable base
- Place of supply, reverse charge, zero-rate decisions are tax
  engine outputs, not fields we fill freehand.

This invoice is the legal record of the sale between Beyond Borders
and the reseller. It is emailed per `BillingProfile.invoice_delivery`
and also available for download from the reseller portal (Phase 4).

### Reseller-branded guest documents — operational output

These documents are:

- Rendered using the reseller's `BrandingProfile` (logo fallback
  chain) and `DocumentTemplate` (ADR-016) resolved for the
  `reseller_account_id`.
- Showing amounts per `ResellerResaleRule` and
  `GuestPriceDisplayPolicy`.
- Numbered from a reseller-scoped `DocumentNumberSequence`
  (distinct from BB voucher sequence).
- **Never labelled or formatted as a tax invoice.** Footer must
  include a clarifying line: "This is a booking confirmation /
  voucher, not a tax invoice." Template-level constraint.
- Emailed to the guest on behalf of the reseller. The `from`
  address uses the reseller's configured sending domain if
  DKIM-verified, otherwise falls back to a platform-sent-on-behalf
  from-address with `Reply-To` pointing at the reseller's
  `BrandingProfile.contact_block.email`.

### Configuration UX expectation (for later reseller admin work)

A reseller admin in the B2B portal (Phase 4) configures in this
order:

1. BillingProfile — legal name, billing address, contact emails.
2. TaxProfile — registration details + evidence.
3. BrandingProfile — logo, display name, contact block.
4. ResellerResaleRule — mode + params, with a live preview showing
   guest-facing amount for a sample booking.
5. GuestPriceDisplayPolicy — display toggles.

Each step is independently saveable. A reseller who has not
completed steps 3–5 can still receive bookings, but reseller-branded
guest documents will fall back through the branding chain and use
conservative defaults (no markup display, `HIDE_PRICE`), and an
onboarding alert is raised.

### Credit / debit notes

Credit notes fire on cancellation or price reduction against an
issued `TAX_INVOICE`. Debit notes fire on upward correction (rare;
usually a post-booking amendment with higher rate). Both are ADR-016
`LEGAL_TAX_DOC` documents with their own numbering sequences. The
booking saga's cancellation / amendment flows trigger a document
event; the document-issue-worker produces the credit/debit note
asynchronously.

The branded reseller guest document for a cancelled booking is
handled by issuing a `RESELLER_GUEST_CONFIRMATION` with `VOIDED`
status and a superseding cancellation-notice template — not a
legal credit note. Reseller-to-guest corrections are commercial,
not tax-legal (the reseller is not selling a taxable supply to the
guest on our books; the reseller's own tax treatment of the
reseller-to-guest leg is *their* accounting, not ours).

### Observability

Metrics and logs exposed:

- Reseller onboarding completion rate per profile (billing, tax,
  branding, resale, display).
- Document-issue latency and failure rate per document type and
  per reseller.
- Branding fallback trigger rate per reseller (a reseller whose
  docs repeatedly fall back to text-only or platform default is an
  onboarding gap).
- Tax invoice issuance vs ledger `SPEND`: for every reseller-
  channel booking with a taxable supply, a `TAX_INVOICE` must
  exist within SLA (configurable, default 24h from `CONFIRMED`).
  An unmatched booking is an ops alert.

## Consequences

- Reseller work is structurally separated from B2C / corporate
  customer flows. Adding a new reseller class (e.g. corporate TMC
  reselling internally) is `ResellerProfile.reseller_class` + a
  policy default, not a schema change.
- The ledger stays clean. Resale markup is a document property,
  never a ledger fact. Pricing stays clean too — `resale_amount`
  is not a pricing rule.
- Tax invoicing is fully specified at the binding layer (legal
  entity + tax profile + ADR-016 numbering). The tax computation
  engine can evolve without touching documents or billing.
- Reseller branding has a defined fallback chain, so an
  incompletely onboarded reseller still produces usable documents.
- The price the guest sees is the reseller's decision, bounded by
  invariants (never below buy), and decoupled from our ledger.

## Anti-patterns explicitly forbidden

- **Writing `reseller_resale_amount` into `LedgerEntry`.**
  Ledger is what we sold to the reseller, not what the reseller
  sold to their guest.
- **Labelling a `RESELLER_GUEST_CONFIRMATION` as an invoice, tax
  invoice, or receipt.** It is not. Template renders that include
  "Tax Invoice" in the title for a reseller guest doc are a
  template bug; linting rule at template review time.
- **Pulling reseller branding at issue time without falling back.**
  Issue must deterministically resolve branding via the fallback
  chain; partial branding must not produce a bad-looking document.
- **Using the reseller's own TRN/VAT number on the BB tax invoice
  as the issuer registration.** The issuer on the BB tax invoice
  is Beyond Borders' `LegalEntity`; the reseller's registration
  appears as *buyer* info only.
- **Treating a subscriber-group reseller as "just another
  subscriber."** Subscribers consuming internally are fine under
  ADR-006 as-is. Subscribers reselling carry the same
  `ResellerProfile` machinery as agencies; the reseller_class
  differs, the contracts differ.
- **Storing logo bytes in Postgres.** Object storage only, hashed,
  validated. Same rule as ADR-016 for PDFs.
- **Embedding tax logic in `ResellerResaleRule`.** The resale rule
  produces a guest-facing amount; it does not decide tax
  treatment on the reseller-to-guest leg. That is the reseller's
  problem on their own books.
- **Issuing a guest-branded voucher showing the buy price.**
  `show_buy_price = true` is rejected at render.

## Open items

- **Tax engine ADR** (shared open item with ADR-016). UAE VAT
  defaults + reverse charge handling for cross-border B2B must be
  implemented before reseller onboarding opens in Phase 3.
- **DKIM / custom sending domain per reseller** — operationally
  fiddly. Phase 4. MVP sends guest-facing emails from a platform
  address with `Reply-To` to reseller contact.
- **Reseller self-serve branding upload limits and moderation** —
  Phase 3 admin tooling.
- **Multi-legal-entity resellers** — a reseller operating across
  jurisdictions with multiple legal entities of their own. Data
  model supports multiple `BillingProfile`/`TaxProfile` rows; the
  resolution rule (which to use for a given booking) is Phase 4.
- **Reseller portal UI surfaces** for the configuration UX above —
  Phase 4 B2B portal scope.
- **Per-reseller FX rate sourcing** for `display_currency` — MVP
  uses platform FX; Phase 4 allows reseller-configured rates with
  validation bands.
- **Subscriber-group reselling commercial model** — whether
  reselling subscriber groups get the same `SupplierConnection`
  access as agencies or a curated subset. Commercial + legal
  decision, not technical.
- **Reseller-of-reseller chains** — explicitly out of scope. A
  reseller cannot resell through another reseller on our platform.
  Revisit only with a specific commercial driver.

## Amendment 2026-04-21 (see ADR-018)

### ResellerSettlementMode on the ResellerProfile

The `ResellerProfile` shape gains a versioned `settlement_mode`
property. It is a first-class enum, not a derived flag:

```
ResellerProfile.settlement_mode ∈ {
  RESELLER_COLLECTS     // default; this ADR's original flow
  CREDIT_ONLY           // BB collects guest payment; reseller
                        //   earnings accrue as non-withdrawable
                        //   platform credit
  PAYOUT_ELIGIBLE       // BB collects guest payment; reseller
                        //   earnings accrue as withdrawable cash,
                        //   gated by KYC/KYB + verified PayoutAccount
                        //   + signed payout terms
}
```

Versioning follows the same pattern as `BillingProfile` — a booking
confirmed under `settlement_mode` v1 stays linked to v1 for the
entire earnings lifecycle of that booking, even if the reseller
upgrades to a different mode later.

The default on `ResellerProfile` creation is `RESELLER_COLLECTS`.
The flows documented throughout this ADR (reseller bills guest
directly; BB issues `TAX_INVOICE` to reseller; reseller issues
branded `RESELLER_GUEST_*` docs to guest) are unchanged under that
default. `CREDIT_ONLY` and `PAYOUT_ELIGIBLE` are additive:

- The branded guest document set is **identical** across all three
  modes. `reseller_resale_amount` remains the amount the guest sees
  on the `RESELLER_GUEST_CONFIRMATION` and `RESELLER_GUEST_VOUCHER`;
  `ResellerResaleRule` is still the authority.
- The BB `TAX_INVOICE` to the reseller continues to exist at
  `bb_sell_to_reseller_amount` in all three modes. Settlement mode
  changes *how that invoice is paid*, not whether it exists.
  - `RESELLER_COLLECTS`: settled via `BillingProfile` + `CreditLine`
    as today.
  - `CREDIT_ONLY` / `PAYOUT_ELIGIBLE`: settled by BB netting the
    reseller's earning at collection time, via the
    `reseller_collections_suspense` book (ADR-012 amendment 2026-04-21
    / ADR-018).

### Split onboarding — payout readiness is its own concern

The reseller onboarding UX order from earlier in this ADR (billing →
tax → branding → resale rule → display policy) is **unchanged** for
`RESELLER_COLLECTS`. Two additional onboarding steps gate progression
to `CREDIT_ONLY` and `PAYOUT_ELIGIBLE`:

6. `ResellerKycProfile` — legal-entity KYB, beneficial owners, AML /
   sanctions / PEP screening (ADR-018). Required for `CREDIT_ONLY`
   and `PAYOUT_ELIGIBLE`.
7. `PayoutAccount` — verified bank / Stripe Connect account whose
   holder name matches the KYC legal entity name (ADR-018). Required
   for `PAYOUT_ELIGIBLE` only.

Natural persons with no business legal entity
(`ResellerKycProfile.legal_entity_kind = INDIVIDUAL_NOT_BUSINESS`)
are **never eligible** for `PAYOUT_ELIGIBLE` in MVP. They remain
eligible for `RESELLER_COLLECTS` and, contract-permitting,
`CREDIT_ONLY`.

### Anti-patterns added

- **Assuming a `ResellerProfile` is payout-eligible by default.** It
  is not. `RESELLER_COLLECTS` is the default; `PAYOUT_ELIGIBLE`
  requires ADR-018's full gate set.
- **Upgrading `CREDIT_ONLY` → `PAYOUT_ELIGIBLE` by rewriting the
  reseller's historical platform-credit balances into cash earnings.**
  Old credit stays credit; only new accruals post to the cash book.
- **Routing a reseller-channel guest payment to the reseller's
  `CASH_WALLET`.** The reseller is not a B2C customer. Guest
  collections for `CREDIT_ONLY` / `PAYOUT_ELIGIBLE` land in the
  `reseller_collections_suspense` book and split per ADR-018, never
  into a `CASH_WALLET`.

## Amendment 2026-04-21 (see ADR-020) — collection mode alignment

`ResellerSettlementMode` (ADR-018) on the reseller axis and
`CollectionMode` (ADR-020) on the booking axis are orthogonal but
constrained. To avoid confusion from the shared name
`RESELLER_COLLECTS`:

- `RESELLER_COLLECTS` on `ResellerProfile.settlement_mode` (ADR-018
  default) is the **reseller-side** policy: the reseller bills their
  guest directly and settles with us via their `BillingProfile` /
  `CreditLine`.
- `RESELLER_COLLECTS` on a rate's `CollectionMode` (ADR-020) is the
  **booking-side** fact: the reseller is the collector of the
  guest's money for this specific booking.

They express the same reality from two sides. Enforcement
(per ADR-020 §Interactions):

- `ResellerProfile.settlement_mode = RESELLER_COLLECTS` forces
  `CollectionMode = RESELLER_COLLECTS` on every bookable rate for
  that reseller. Rates whose only `CollectionMode` is
  `BB_COLLECTS` are not sellable through such a reseller.
- `ResellerProfile.settlement_mode ∈ { CREDIT_ONLY,
  PAYOUT_ELIGIBLE }` forces `CollectionMode = BB_COLLECTS`.
- `PROPERTY_COLLECT` and `UPSTREAM_PLATFORM_COLLECT` rates are
  **not sellable** through `CREDIT_ONLY` or `PAYOUT_ELIGIBLE`
  resellers — there is nothing for us to collect and therefore
  nothing to accrue to the reseller's earnings book.

These constraints are enforced at source-selection / search time,
never at checkout.
