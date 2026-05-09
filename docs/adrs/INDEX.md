# ADR Index

Canonical list of every Architecture Decision Record for Beyond Borders.
Updated whenever an ADR is added, accepted, amended, or superseded —
see the working rule in `CLAUDE.md` §11.

Status legend:

- `Accepted` — design decision is locked and authoritative.
- `Accepted (no code yet)` — design locked; implementation pending.
- `Proposed` — drafted but not yet accepted.
- `Superseded by ADR-NNN` — replaced; row kept for history.
- `Missing` — referenced by other ADRs / code but file not on disk;
  doc-debt.

---

## Foundation (ADR-001 → ADR-011)

| ADR | Title | Status | Controls | Depends on |
|---|---|---|---|---|
| ADR-001 | Foundation | Accepted | Project mission, scope, principles. | — |
| ADR-002 | Canonical hotel data model | Accepted (amended by ADR-021) | Single canonical hotel; supplier references; static/dynamic separation. | ADR-001 |
| ADR-003 | Supplier adapter contract | Accepted (amended by ADR-013, ADR-020, ADR-021) | One interface for every supplier (aggregator + direct paper + CRS + channel manager). | ADR-001, ADR-002 |
| ADR-004 | Pricing rule model and precedence | Accepted (amended by ADR-014, ADR-015, ADR-020) | Pricing precedence chain; account-aware markup; pricing trace. | ADR-001, ADR-003 |
| ADR-005 | Static vs dynamic content split | Accepted | What may be cached vs fetched live. | ADR-002 |
| ADR-006 | Tenancy and account model | Accepted (amended by ADR-016, ADR-017) | Multi-tenant data model; account types; LegalEntity. | ADR-001 |
| ADR-007 | Tech stack (provisional) | Accepted | NestJS, Postgres+PostGIS, Redis, MinIO, pnpm + Turbo, Next.js 15. | ADR-001 |
| ADR-008 | Hotel mapping strategy | Accepted (extended by ADR-021) | Deterministic-first mapping; reversible; auditable; conflict resolution human-in-the-loop. | ADR-002 |
| ADR-009 | Merchandising and ranking | Accepted | Sponsored / recommended / featured tags; never mutates priced rate. | ADR-004 |
| ADR-010 | Booking orchestration | Accepted (amended by ADR-016, ADR-020, ADR-021) | Booking saga; document workers outside saga; single-hotel cart only in MVP. | ADR-003, ADR-004, ADR-006 |
| ADR-011 | Monorepo structure | Accepted (amended by ADR-016, ADR-017, ADR-021) | Workspace layout; package boundaries; table-prefix ownership; ESLint dependency-direction. | ADR-007 |

## Wallet, Direct Connectivity, Rewards, Intelligence (ADR-012 → ADR-015)

| ADR | Title | Status | Controls | Depends on |
|---|---|---|---|---|
| ADR-012 | Payments, wallet, credit ledger, payouts | Accepted (amended by ADR-018, ADR-020) | Internal double-entry ledger; Stripe as a rail only; wallet books; tender ≠ pricing. | ADR-006, ADR-010 |
| ADR-013 | Direct hotel connectivity (CRS / channel managers) | Accepted | SynXis + RateGain + SiteMinder + Mews + Cloudbeds + Channex; ARI push capability; same `SupplierAdapter` contract. | ADR-003 |
| ADR-014 | Loyalty, rewards, referral | Accepted (amended 2026-04-22) | Reward maturation lifecycle; default `PERCENT_OF_MARGIN`; funding source taxonomy; B2B kickback; referral anti-fraud. | ADR-004, ADR-012 |
| ADR-015 | Market benchmark / intelligent markup | Accepted | Benchmark inputs are advisory only; never authoritative; never sellable. | ADR-004 |

## Documents, Reseller, Settlement, Money Movement (ADR-016 → ADR-018, ADR-020)

| ADR | Title | Status | Controls | Depends on |
|---|---|---|---|---|
| ADR-016 | Document generation, numbering, storage | Accepted | Document types; gapless tax-doc sequences per (legal entity, jurisdiction, fiscal year); object storage; immutable issued docs; document workers outside saga. | ADR-006, ADR-010, ADR-012 |
| ADR-017 | Reseller billing, resale controls, branded documents | Accepted (amended by ADR-018, ADR-020) | `ResellerProfile` capability on AGENCY/SUBSCRIBER; versioned billing/tax/branding/resale-rule/display profiles; branding fallback chain. | ADR-006, ADR-012, ADR-016 |
| ADR-018 | Reseller collections, balances, reserves, payouts | Accepted | Three settlement modes; two reseller wallet books; earnings state machine; KYC/KYB + sanctions/PEP gating for `PAYOUT_ELIGIBLE`. | ADR-012, ADR-017 |
| ADR-019 | *(unused number — skipped intentionally)* | — | — | — |
| ADR-020 | Collection mode and supplier settlement mode | Accepted | Three orthogonal axes: `CollectionMode`, `SupplierSettlementMode`, `PaymentCostModel`; allowed-combinations matrix; mode-aware `recognized_margin`. | ADR-003, ADR-004, ADR-010, ADR-012, ADR-017, ADR-018 |

## Rate / Offer / Restriction Model (ADR-021 → ADR-023)

| ADR | Title | Status | Controls | Depends on |
|---|---|---|---|---|
| ADR-021 | Rate, offer, restriction, occupancy model | Accepted (amended 2026-04-23 with seasonal contract + promotion overlay) | Sourced-vs-authored shape separation; canonical product dimensions; booking-time snapshots; `OfferShape`, `RateBreakdownGranularity`, `AuthoringMode`. | ADR-002, ADR-003, ADR-004, ADR-008, ADR-010, ADR-011, ADR-013 |
| ADR-022 | Authored direct pricing — core | Accepted | Phase A authored primitives: contracts, seasons, child age bands, base rates, occupancy + meal supplements; composite-FK same-contract enforcement. | ADR-021 |
| ADR-023 | Authored direct pricing — restrictions and cancellation | Accepted | Phase B authored shape: restrictions and cancellation policies for authored offers; gating in search. | ADR-022 |

## FX, Identity, Impersonation, Audit (ADR-024 → ADR-028)

| ADR | Title | Status | Controls | Depends on |
|---|---|---|---|---|
| ADR-024 | FX strategy — search display + checkout lock | Accepted | Three-tier FX: OXR live · ECB fallback/reference · Stripe FX Quotes for locked checkout. | ADR-004, ADR-010, ADR-012 |
| ADR-025 | *(unused number — reserved during planning; no decision behind it)* | Retired (unused) | — | — |
| ADR-026 | Identity, role, and permission model | Accepted (back-written 2026-05-09; implemented across slices E1, E2-A, E2-B, E3-A, E4-A, E4-B) | `JwtAuthGuard`, `RolesGuard`, `PermissionResolverService`, `AuthContext` shape, `PERMISSIONS` catalogue + role-permission matrix, default deny, AGENCY/OPERATOR user classes, `core_user` mirror, `user_role` + `user_account_membership` schema, admin provisioning, webhook ingestion, bootstrap CLI, identity-baseline exception (`GET /me`), endpoint retrofit pattern, body-vs-AuthContext reconciliation. | ADR-006, ADR-007 |
| ADR-027 | Operator impersonation | Accepted (V1.0 implemented 2026-05-09) | DB-bound impersonation grants; AGENCY-target only in V1; `ticket_ref` required; read-only V1; `IMPERSONATION_DENY_INITIAL` deny-list overlay; audit Layers 1/2/3. | ADR-026, ADR-028 |
| ADR-028 | Audit log infrastructure — append-only events, schema, access | Accepted (V1.0 steps 1–5 implemented 2026-05-09) | DB-role-enforced append-only; composite category × month partitioning; `AuditService` with category-aware emission (AUTH/IMPERSONATION transactional, APP/SECURITY background); self-audited reads; partition-drop retention with `audit_pruning_log`. | ADR-026, ADR-027 |

---

## Doc-debt

None outstanding. ADR-025 was a reserved-but-unused number (retired
above). ADR-026 was back-written on 2026-05-09.

---

## Dependency graph (high-level)

```
ADR-001 (foundation)
   ↓
ADR-002, ADR-005, ADR-006, ADR-007 (core models + tech)
   ↓
ADR-003 (supplier contract)  →  ADR-013 (direct connectivity)
   ↓                            →  ADR-020 (money movement axes)
ADR-004 (pricing)            →  ADR-014 (rewards)  →  ADR-014 amendment (margin)
   ↓                            →  ADR-015 (rate intelligence)
ADR-008 (mapping)
ADR-009 (merchandising)
ADR-010 (booking)            →  ADR-016 (documents)  →  ADR-017 (reseller)  →  ADR-018 (reseller payouts)
ADR-011 (monorepo)
ADR-012 (wallet/ledger)
ADR-021 (rate/offer)         →  ADR-022 (authored core)  →  ADR-023 (authored restrictions/cancellation)
ADR-024 (FX)
ADR-026 (identity)           →  ADR-027 (impersonation)  →  ADR-028 (audit infrastructure)
```

ADR-027 and ADR-028 are mutually entangled: ADR-027 *requires* ADR-028's
append-only invariant in production before its V1.0 ships, and ADR-028's
IMPERSONATION-category schema is shaped to satisfy ADR-027.

---

## How to add a new ADR

1. Pick the next available number (currently ADR-029).
2. Use existing ADRs as the template (e.g. ADR-027, ADR-028 for the
   current style with locked-rule sections).
3. Add a row to the appropriate section above with title, status,
   controls, depends-on.
4. If the new ADR amends or supersedes an existing one, update the
   prior row's `Status` column and add the cross-link.
5. Update `docs/product/capability-catalog.md` for any new or
   reclassified capabilities the ADR introduces.
6. Update `docs/PROJECT-STATE.md` if the ADR shifts what is
   "design-locked but not implemented yet."
