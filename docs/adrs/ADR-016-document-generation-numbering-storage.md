# ADR-016: Document generation, numbering, and storage

- **Status:** Accepted
- **Date:** 2026-04-22
- **Supersedes:** nothing
- **Amends:** ADR-006 (tenancy — numbering sequences are per legal
  entity and per tenant), ADR-010 (booking orchestration — document
  generation is a post-`CONFIRMED` concern, not inside the money-moving
  saga path), ADR-012 (payments — tax invoice is a distinct document
  from the ledger, produced from ledger facts)
- **Related:** ADR-017 (reseller billing, resale controls, branded
  guest documents — consumes this ADR's numbering + template +
  storage primitives)

## Context

Up to this point every document a booking produces — confirmation,
voucher, eventual tax invoice — has been implicit. "Voucher generation
(PDF) + email" appeared in the roadmap as a single bullet and in
ADR-010 as a single step ("Notify"). That is fine for a single-tenant
single-document world. It breaks the moment any of the following
become real:

- Beyond Borders itself must issue **legal tax invoices** (UAE VAT to
  start, extensible to KSA / other jurisdictions). Tax invoices have
  sequential-numbering, immutability, and retention requirements we do
  not get to re-invent per document type.
- Reseller accounts (agencies + reselling subscribers — see ADR-017)
  must produce their own **branded guest-facing** confirmations /
  vouchers. These are *not* tax invoices. They must not share a number
  sequence with, or be confusable with, our legal invoice.
- Cancellations and modifications need **credit notes** and **debit
  notes** that reference the invoice they correct, and those
  corrections are themselves legal documents with their own numbering
  rules.
- A single booking now produces several documents that flow to
  different recipients on different paths:
  - platform booking reference (us, internal)
  - supplier confirmation number (supplier-issued, mirrored)
  - Beyond Borders tax invoice (us → buyer, legal)
  - Beyond Borders voucher (us → buyer, operational)
  - reseller guest confirmation / voucher (reseller → guest, branded)

If we let these drift — shared sequences, ad-hoc templating, email
done inline in the saga — we pay back compound interest: duplicated
numbers, invoices that won't audit, branded PDFs that leak our
internal rate, retry storms that re-send invoices.

This ADR defines the **document, number, template, storage, and
delivery primitives** that every downstream document concern
(including ADR-017) reuses.

## Decision

### Scope

This ADR covers **how documents are produced, numbered, stored, and
delivered** across the platform. It does **not** cover what a
reseller-branded voucher looks like, what a reseller is allowed to
show a guest, or where VAT logic for a given jurisdiction lives —
those belong in ADR-017 (reseller controls) and a future tax-engine
ADR respectively. This ADR is the substrate.

### Separation of concerns — hard rule

Three concerns that are always tangled in ad-hoc implementations are
kept explicitly separate here:

| Concern | Owner | Example |
|---|---|---|
| Money fact | `ledger` (ADR-012) | The `LedgerEntry`s that say "we sold X for Y to buyer Z at tax rate R" |
| Document fact | `documents` (new, this ADR) | The PDF / data blob that *represents* that money fact to a human or an auditor |
| Display / branding fact | `documents` + ADR-017 | How that document is rendered and whom it is addressed to |

The ledger is truth. A document is a **rendering** of a subset of the
ledger (plus booking/account/tax facts) at a point in time. A
document is never the source of truth for a money fact, and a money
fact is never "the invoice" — the invoice is a document derived from
the money fact.

### Document types

```
DocumentType (enum, extensible):
  // platform-issued
  TAX_INVOICE                   // legal, sequentially numbered per
                                //   issuing legal entity + jurisdiction
  CREDIT_NOTE                   // corrects a TAX_INVOICE down
  DEBIT_NOTE                    // corrects a TAX_INVOICE up
  BB_BOOKING_CONFIRMATION       // platform confirmation (commercial,
                                //   not a tax invoice)
  BB_VOUCHER                    // platform-branded voucher for
                                //   hotel check-in
  // reseller-issued (ADR-017)
  RESELLER_GUEST_CONFIRMATION   // reseller-branded confirmation to
                                //   end guest — not a tax invoice
  RESELLER_GUEST_VOUCHER        // reseller-branded voucher for
                                //   hotel check-in
```

New document types are added via ADR amendment. Every type declares
its **legal weight** (`LEGAL_TAX_DOC | COMMERCIAL_DOC |
OPERATIONAL_DOC`) which drives numbering, immutability, and retention
policy.

| DocumentType | Legal weight | Numbering | Immutable after issue | Retention |
|---|---|---|---|---|
| `TAX_INVOICE` | `LEGAL_TAX_DOC` | gapless sequential per (legal entity, jurisdiction, fiscal year) | yes | jurisdiction-governed (UAE: 5y) |
| `CREDIT_NOTE` | `LEGAL_TAX_DOC` | gapless sequential (separate sequence) | yes | same as invoice |
| `DEBIT_NOTE` | `LEGAL_TAX_DOC` | gapless sequential (separate sequence) | yes | same as invoice |
| `BB_BOOKING_CONFIRMATION` | `COMMERCIAL_DOC` | monotonic per tenant | yes | tenant-configured, default 7y |
| `BB_VOUCHER` | `OPERATIONAL_DOC` | monotonic per tenant (separate from confirmation) | yes | tenant-configured, default 2y |
| `RESELLER_GUEST_CONFIRMATION` | `COMMERCIAL_DOC` | monotonic per (tenant, reseller account) | yes | tenant-configured |
| `RESELLER_GUEST_VOUCHER` | `OPERATIONAL_DOC` | monotonic per (tenant, reseller account) | yes | tenant-configured |

"Immutable after issue" means the PDF and its metadata cannot be
edited. Corrections are issued as a new document (credit note, debit
note, or reissued voucher with a clear *replaces* reference and both
kept in the archive).

### Numbering strategy

Numbering is the part that is cheapest to get wrong early and most
expensive to untangle later. It gets its own primitive.

```
DocumentNumberSequence {
  sequence_id
  tenant_id
  legal_entity_id?              // required for LEGAL_TAX_DOC; the
                                //   legal entity whose books this
                                //   number posts to. For reseller
                                //   documents, null (reseller docs
                                //   are not legal tax docs).
  reseller_account_id?          // required for reseller-issued
                                //   document sequences
  document_type                 // one sequence per type per scope
  scope_key                     // e.g. "UAE:2026" for UAE fiscal 2026;
                                //   "GLOBAL" for tenant-wide monotonic
  strategy:                     //
    GAPLESS_SEQUENTIAL          //   1, 2, 3, ... no gaps — legal
                                //     jurisdictions that require it
                                //     (UAE VAT, KSA ZATCA-profile)
    MONOTONIC_SEQUENTIAL        //   strictly increasing, gaps allowed
                                //     (if a draft aborts)
    PREFIXED_SEQUENTIAL         //   "BB-INV-2026-000123" format; the
                                //     prefix and padding are template
  format_template               //   e.g. "{prefix}-{yyyy}-{000000}"
  next_value                    //   monotonic counter
  status                        //   ACTIVE | FROZEN | RETIRED
  created_at, notes
}
```

Rules that hold without exception:

1. **One sequence per (document type, scope).** A tax invoice sequence
   is never reused for a credit note. A reseller voucher sequence is
   never reused for the BB voucher.
2. **Legal tax sequences are per legal entity, per jurisdiction, per
   fiscal year** when that jurisdiction demands it. UAE VAT: yes.
   Tenants cannot share a sequence across their own legal entities.
3. **Gapless sequential is produced by an atomic transactional
   counter** (Postgres sequence or `UPDATE ... RETURNING` under serial
   isolation). No distributed counter hacks that can skip numbers.
4. **A number is allocated only at document issue**, never at draft.
   If a draft invoice is abandoned, no number has been burned. A
   `LEGAL_TAX_DOC` sequence therefore stays gapless.
5. **Reseller voucher sequences are per (tenant, reseller account),**
   not global. Reseller A's vouchers start at 1; reseller B's start
   at 1; Beyond Borders' BB vouchers start at 1.
6. **Platform booking reference and supplier confirmation number are
   not in this table.** Platform booking references are the `Booking`
   primary key (opaque ULID, display form optional). Supplier
   confirmation numbers are supplier-issued and mirrored on the
   booking; they are identifiers, not a document number — they do
   not require sequences.
7. **Credit and debit notes allocate from their own sequences and
   carry a `corrects_document_id` reference** to the invoice they
   adjust. Both the invoice and the correction are retained.

Numbering-related edge cases and how they resolve:

- Retry storm on document issue: idempotency key on the issue
  command. If a number was allocated and persisted but PDF render
  failed, the next retry re-renders against the already-allocated
  number. If a number was allocated and the whole transaction rolled
  back, the sequence rolls back with it (single transaction).
- Backdated corrections: not allowed for `LEGAL_TAX_DOC`. A
  correction always takes the current next number in its own
  sequence and references the original by id.
- Year rollover for fiscal-year-scoped sequences: handled by
  `scope_key = "UAE:2027"` becoming active; the 2026 sequence
  freezes (`FROZEN`) and is never reopened.
- Multi-tenancy: `tenant_id` is part of every sequence scope.
  Tenants cannot read or write each other's sequences.

### Legal entity concept (minimal)

`LegalEntity` is introduced here at the minimum shape needed to
bind tax invoice sequences correctly. Full VAT/tax engine is out of
scope for this ADR but the binding point cannot be.

```
LegalEntity {
  legal_entity_id
  tenant_id
  display_name                  // "Beyond Borders Travel LLC"
  jurisdiction                  // "AE" (ISO country code)
  tax_registration {
    scheme                      // UAE_VAT | KSA_ZATCA | ... |
                                //   NONE
    registration_number         // e.g. TRN for UAE
    effective_from, effective_to?
  }
  default_currency
  address                       // structured; surfaces on tax
                                //   invoice PDFs
  status                        // ACTIVE | RETIRED
}
```

A tenant has one or more legal entities. Beyond Borders issues tax
invoices from whichever legal entity is contractually bound to the
reseller/buyer (Phase 3 concern for resellers; Phase 2 has only a
single Beyond Borders legal entity in UAE).

### DocumentTemplate

```
DocumentTemplate {
  template_id
  tenant_id
  reseller_account_id?          // null = platform template
  document_type
  jurisdiction?                 // for LEGAL_TAX_DOC variants
  locale                        // "en", "ar"
  channel                       // PDF | EMAIL_HTML | PLAIN_TEXT
  engine                        // HANDLEBARS | MJML | ...
  source_ref                    // blob storage ref to the template
                                //   body (versioned)
  branding_profile_ref?         // ADR-017 — applied when rendering
  approved_by, approved_at      // template changes are audited
  status                        // DRAFT | ACTIVE | RETIRED
  version
}
```

Templates are versioned. An issued document records which template
version rendered it so re-rendering on reprint uses the same version
(regulatory reprint must match original).

Default template resolution at issue time:

1. Tenant-and-reseller-scoped template for `(document_type,
   jurisdiction, locale)` — ADR-017 reseller-specific.
2. Tenant-scoped template for `(document_type, jurisdiction,
   locale)` — platform default.
3. Tenant-scoped template for `(document_type, jurisdiction,
   default_locale)`.
4. Platform built-in fallback (ships with the codebase).

Branding is layered separately (ADR-017 `BrandingProfile`); the
template does not hardcode logos or contact blocks.

### BookingDocument

```
BookingDocument {
  booking_document_id
  tenant_id
  booking_id                    // scope: every document we issue
                                //   today is booking-anchored; future
                                //   tenant-level docs (monthly
                                //   statements etc.) get their own
                                //   aggregate root, not booking
  document_type
  issuing_legal_entity_id?      // for LEGAL_TAX_DOC
  issuing_reseller_account_id?  // for RESELLER_* types
  recipient {
    kind                        // RESELLER | GUEST | SUPPLIER |
                                //   INTERNAL
    account_id?, email?, name?
  }
  number                        // the rendered number (formatted per
                                //   sequence format_template)
  number_sequence_id            // source sequence
  template_id, template_version
  language
  currency                      // document-display currency; may
                                //   differ from ledger currency
                                //   (reseller sell-to-guest case)
  amounts {
    subtotal, tax_lines[], total,
    // for LEGAL_TAX_DOC only:
    tax_registration_number,
    place_of_supply,
    fiscal_year
  }
  corrects_document_id?         // for CREDIT_NOTE / DEBIT_NOTE
  replaces_document_id?         // for a reissued voucher
  storage_ref                   // blob storage key for the PDF
  content_hash                  // SHA-256 of the PDF, immutable
  issued_at
  delivery[]                    // array of DeliveryAttempt rows
  status                        // DRAFT | ISSUED | SUPERSEDED |
                                //   VOIDED
  audit_refs[]                  // links to AuditLog rows
}
```

The `BookingDocument` row is immutable for `ISSUED` status except
for appending `DeliveryAttempt` rows and transitioning to
`SUPERSEDED` / `VOIDED` with a linked successor.

### Storage

- **PDFs live in object storage**, not in Postgres. The
  `storage_ref` is provider-agnostic — MVP: MinIO-compatible object
  store locally, S3-compatible in deployment.
- **Storage is versioned and write-once** for `LEGAL_TAX_DOC`. The
  bucket policy prevents overwrite at the object key used for legal
  docs. Reissue generates a new key; supersession happens at the
  `BookingDocument` row level.
- **Content hash is recorded on issue** and validated on any reprint
  or audit request. If the hash mismatches the stored blob, we fail
  loud — a legal-weight document is corrupt.
- **Retention is driven by `DocumentType.legal_weight`** plus
  tenant policy. A retention worker does not delete `LEGAL_TAX_DOC`
  before the jurisdiction's minimum retention.

### Delivery

```
DeliveryAttempt {
  attempt_id
  booking_document_id
  channel                       // EMAIL | WEBHOOK | PORTAL_DOWNLOAD |
                                //   API_RESPONSE
  recipient_address             // email, URL, etc.
  provider                      // transactional email provider id
  provider_message_id?
  status                        // QUEUED | SENT | DELIVERED | BOUNCED |
                                //   COMPLAINED | FAILED
  status_detail?
  attempted_at, completed_at
}
```

Delivery is decoupled from document issue. Issue persists
`BookingDocument{status: ISSUED}` and enqueues delivery; delivery
workers run independently. Delivery failures never void the
document — they are their own problem.

### Where document generation sits in the booking flow

ADR-010 booking orchestration step 8 ("Notify") becomes **document
issue and delivery orchestration**, but remains outside the
money-moving saga core. A document-issue failure is never a reason
to compensate a successful booking. The sequence is:

1. Booking reaches `CONFIRMED`.
2. `document-issue-worker` picks up the confirmation event,
   materializes `BookingDocument` rows for each applicable
   `DocumentType` (see below), allocates numbers atomically, renders
   templates, stores blobs, then transitions each to `ISSUED`.
3. `document-delivery-worker` picks up each `ISSUED` row and fires
   its configured delivery channels.

Which document types issue for which booking is driven by a
`DocumentIssuePolicy` per tenant (and per reseller, see ADR-017).
Phase 2 default for the Beyond Borders B2C flow:
`TAX_INVOICE` (if the booking is on a taxable supply),
`BB_BOOKING_CONFIRMATION`, `BB_VOUCHER`.

Cancellations emit `CREDIT_NOTE` for the covered portion.
Modifications that increase consideration emit `DEBIT_NOTE`.

### Audit

Every `BookingDocument` write and every `DocumentNumberSequence`
allocation is audited to `AuditLog`:

- sequence allocation: sequence_id, allocated number, allocated_at,
  allocated_by (system actor), booking_id
- document issue: booking_document_id, template version used, hash
- document supersession / voiding: actor, reason code, linked
  successor

### Error handling and invariants

- A `LEGAL_TAX_DOC` is never issued without a linked
  `issuing_legal_entity_id` carrying an active `tax_registration`
  appropriate for the jurisdiction at `issued_at`. Ledger-write
  level invariant, same pattern as ADR-014 `HOTEL_FUNDED` reward
  legs.
- A `RESELLER_GUEST_*` document is never issued without a linked
  `issuing_reseller_account_id` with an active `BrandingProfile`
  fallback chain resolvable (ADR-017).
- Sequence allocation and `BookingDocument` row insert happen in
  the same database transaction. No orphan numbers, no orphan rows.

### Reprint and regulatory retrieval

- Any issued document can be re-rendered from stored inputs
  (template version + amounts + branding at time of issue). Re-render
  must hash-match the stored blob. Hash mismatch is an operational
  alarm.
- A tenant admin can retrieve any historical document via admin UI
  or API; access is audited.

## Consequences

- Document work is separated cleanly from booking work.
  A broken email provider never fails a booking; a failed render
  never loses a number.
- Adding a new document type (e.g. corporate statement, agency
  commission statement) is "new enum value + new template + new
  sequence scope," not a re-plumb.
- Tax invoicing is legally defensible from day one:
  gapless numbering, immutable PDFs, audit trail, retention policy.
- Reseller branded documents (ADR-017) slot in as sequence scopes
  + templates + branding profiles, without inventing a parallel
  document pipeline.
- Operational cost: three workers are introduced (issue, delivery,
  retention). Postgres sequence contention is the main hot spot
  (legal tax sequences must serialize); Phase 2 scale handles this
  trivially, Phase 5+ revisit if contention bites.

## Anti-patterns explicitly forbidden

- **Generating document numbers from `Booking.id` or timestamps.**
  Legal tax numbering must be a dedicated sequence, not a derived
  value.
- **Sharing one sequence across document types.** Invoice and
  voucher share no counter. Ever.
- **Embedding branding in templates.** Branding is a separate
  profile (ADR-017) layered at render time.
- **Mutating an issued document.** Issued documents are immutable;
  corrections are issued as credit / debit notes or as superseding
  documents with explicit `replaces_document_id`.
- **Storing PDFs in Postgres.** Object storage only. Postgres holds
  metadata and hash.
- **Treating reseller-branded guest documents as tax invoices.**
  They are commercial / operational documents. Our tax invoice is
  the legal record, issued by the legal entity that sold the
  supply to the reseller.
- **Issuing a `LEGAL_TAX_DOC` inside the booking saga's hot path.**
  Issue runs after `CONFIRMED` in a separate worker.
- **Silently skipping a document on email failure.** Delivery
  failure is tracked and retried; the document still exists.

## Open items

- **Tax engine ADR.** This ADR pins the binding point
  (`LegalEntity.tax_registration`, `BookingDocument.amounts.tax_lines`)
  but a separate ADR is needed for jurisdiction-specific VAT
  calculation (place of supply, reverse charge, B2B vs B2C rules),
  starting UAE and extensible to KSA (ZATCA). Phase 3 decision.
- **Long-term archive tiering.** After the retention minimum, do we
  move legal docs to cold storage? Phase 5+ revisit.
- **KSA ZATCA e-invoicing (Phase 2 profile in KSA) integration.**
  If KSA launches, ZATCA's Fatoora integration is required
  (XML + QR). This ADR's data model supports it; the integration
  adapter is a future ADR.
- **Platform-admin reprint workflow** — who can reissue, under what
  controls — Phase 3 alongside admin console work.
- **Template authoring UX** — for Phase 3 admin; MVP ships with
  built-in defaults editable only via deploy.
