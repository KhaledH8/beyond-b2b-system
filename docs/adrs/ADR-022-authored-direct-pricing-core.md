# ADR-022: Authored direct pricing — core schema and module

- **Status:** Accepted
- **Date:** 2026-04-26
- **Supersedes:** nothing
- **Amends:** ADR-021 (rate, offer, restriction, and occupancy model — adds
  implementation detail for the authored-primitive path; supersedes ADR-021's
  `rate_contract_*` naming with `rate_auth_*`; narrows the Phase A scope to
  six tables and defers restrictions and cancellation policies to ADR-023)
- **Depends on:** ADR-021, ADR-003, ADR-008, ADR-011

## Context

ADR-021 and its 2026-04-23 amendment defined the conceptual two-shape model
(`SOURCED_COMPOSED` / `AUTHORED_PRIMITIVES`) and the `SEASONAL_CONTRACT`
authoring mode. The amendment described a `rate_contract_*` table family for
the seasonal-contract path and a set of extended `rate_auth_*` tables for
shared primitives (supplements, restrictions, etc.).

Phase A (Slice 1 migration + Slice 2 DirectContracts module) translated that
conceptual model into concrete code and schema. Several implementation-level
decisions were made that are not captured in ADR-021 and need to be recorded
here before they become invisible tribal knowledge.

## Decision

### D1. Table prefix: `rate_auth_*` for all Phase A tables

ADR-021's amendment used a split naming convention: `rate_contract_*` for
the commercial-agreement spine (contract, season, date band, price) and
`rate_auth_*` for the shared authored primitives (extra-person rules, meal
supplements, etc.). In practice, everything in the authored path is
"authored rate data", so the split prefix is confusing with no query-pattern
benefit.

Phase A uses `rate_auth_*` for **all** authored tables:

- `rate_auth_contract`
- `rate_auth_season`
- `rate_auth_child_age_band`
- `rate_auth_base_rate`
- `rate_auth_occupancy_supplement`
- `rate_auth_meal_supplement`

ADR-021's `rate_contract_*` naming is superseded by this ADR for
implementation purposes. Any future additions to the authored path use
`rate_auth_*`.

### D2. Phase A scope: six tables only

Phase A lands the minimum schema needed to author and price a complete static
seasonal hotel contract:

1. `rate_auth_contract` — the commercial agreement
2. `rate_auth_season` — named date ranges within a contract
3. `rate_auth_child_age_band` — per-contract child age classifications
4. `rate_auth_base_rate` — base room price per (contract, season, room type,
   rate plan, occupancy template, included meal plan)
5. `rate_auth_occupancy_supplement` — extra-adult and extra-child
   per-night charges
6. `rate_auth_meal_supplement` — upgrade charges for a non-included
   meal plan

`rate_auth_restriction` and `rate_auth_cancellation_policy` are deferred to
Phase B. See ADR-023.

### D3. Composite FK targets enforce same-contract membership at the DB layer

`rate_auth_season` and `rate_auth_child_age_band` each carry a
`UNIQUE(id, contract_id)` constraint in addition to their primary key. This
makes the pair `(id, contract_id)` a valid composite FK target.

Every table that references a season or an age band does so via a **composite
FK**:

- `(season_id, contract_id)` → `rate_auth_season(id, contract_id)`
- `(child_age_band_id, contract_id)` → `rate_auth_child_age_band(id, contract_id)`

Because `contract_id` is NOT NULL in the child tables, the DB rejects any
insert that references a season or band from a different contract without any
application-layer guard. This is the cheapest cross-contract integrity check
available in standard PostgreSQL.

### D4. MATCH SIMPLE semantics for nullable child_age_band_id

`rate_auth_occupancy_supplement` and `rate_auth_meal_supplement` have a
nullable `child_age_band_id`. A NULL means "applies to adults" or "no age
band restriction". PostgreSQL's default FK mode (MATCH SIMPLE) skips the FK
check when any column in the composite is NULL.

For `child_age_band_id IS NULL`, MATCH SIMPLE is the correct behavior: the
FK is not checked. For non-null values, the full composite
`(child_age_band_id, contract_id)` is validated against
`rate_auth_child_age_band(id, contract_id)`, enforcing same-contract
membership.

No explicit `MATCH SIMPLE` clause is needed — it is the default and is
documented here for future maintainers.

### D5. Season non-overlap is enforced at the service layer, not the DB layer

A non-overlap constraint on arbitrary DATE ranges cannot be expressed as a
standard UNIQUE index. A DB-side solution requires an EXCLUDE constraint with
`tsrange` and the `btree_gist` extension, which adds operational complexity
and limits portability.

Non-overlap is enforced in `DirectContractsService.createSeason` via a
**serializable transaction**:

1. `SELECT status FROM rate_auth_contract WHERE id = $1 AND tenant_id = $2 FOR UPDATE`
   — locks the contract row.
2. Overlap check: `SELECT 1 FROM rate_auth_season WHERE contract_id = $1 AND date_from <= $3 AND date_to >= $2`.
3. `INSERT INTO rate_auth_season` — proceeds only if no overlap.

The `FOR UPDATE` lock prevents a concurrent `createSeason` call on the same
contract from passing the overlap check and inserting a conflicting row
before the first transaction commits. Both will attempt to lock the contract
row; the second waits, then fails its own overlap check.

**Date ordering** (`date_to >= date_from`) is enforced at the DB layer via
`rate_auth_season_dates_chk`, because it is a single-row predicate that
requires no cross-row comparison.

`patchSeason` calls `seasonRepo.assertNoOverlap(contractId, nextFrom, nextTo,
excludeId)` with the existing season excluded, and does not use a
transaction because the patch targets a single row with no concurrent-write
risk beyond the unique update path itself.

### D6. Child age bands are contract-scoped, not hotel-scoped

ADR-021 defined `hotel_child_age_band` as a platform-wide table for the
canonical-product-dimension mapping surface (used by sourced-offer adapters
to record how a supplier's age labels map to canonical age bands). That table
is hotel-scoped, not tenant-scoped, and exists for content mapping.

`rate_auth_child_age_band` is a separate, **contract-scoped** table. Age
rules in a paper contract are a per-contract commercial term: the age that
counts as "infant free" or "child" can differ between two contracts signed
with the same hotel. Scoping per contract rather than per hotel avoids
ambiguity when a tenant has multiple active contracts on the same hotel (e.g.
one for agency rates, one for corporate net rates).

### D7. Contract status machine: DRAFT → ACTIVE → INACTIVE

| Transition | Condition | Method |
|---|---|---|
| Created in `DRAFT` | always | `createContract` |
| `DRAFT` → `ACTIVE` | ≥1 season exists | `PATCH { status: 'ACTIVE' }` |
| `DRAFT` → `INACTIVE` | no condition | `softDeleteContract` / `PATCH { status: 'INACTIVE' }` |
| `ACTIVE` → `INACTIVE` | no condition | `softDeleteContract` |
| `ACTIVE` → `DRAFT` | **not allowed** | — |
| `INACTIVE` → any | **not allowed** | `INACTIVE` is terminal |

The `DRAFT → ACTIVE` gate enforces that a contract with zero seasons cannot
be activated. A zero-season contract produces a pricing dead-end: the
evaluator would find no season for any stay date and fail with a confusing
error at search time rather than at authoring time.

`ACTIVE → DRAFT` is disallowed because a contract that has been seen by the
pricing evaluator (live search) may have been priced into sessions. Allowing
demotion to DRAFT would retroactively change the expected behavior of those
sessions. Deactivation to INACTIVE (and optionally superseding with a new
DRAFT contract) is the supported correction path.

`INACTIVE` contracts are immutable: no field changes, no new seasons, no new
child age bands are permitted. The service checks `status === 'INACTIVE'`
before any write on the contract or any of its children.

### D8. DIRECT supplier type requirement

`DirectContractsService.requireDirectSupplier` validates that the given
`supplierId` exists in `supply_supplier` with `source_type = 'DIRECT'`. The
check runs before `ContractRepository.insert`. If the supplier does not exist
or has a different source type, the service throws `BadRequestException`.

This prevents an aggregator supplier row (Hotelbeds, WebBeds) from being
referenced in a direct contract, which would corrupt the pricing evaluator's
route-selection logic. The constraint is enforced in application code rather
than at the DB layer because it requires a cross-table read rather than a
simple FK.

### D9. Hard delete for seasons and child age bands

Seasons and child age bands are **hard-deleted**. They have no `status`,
`deleted_at`, or `archived` column.

A season cannot be deleted while any `rate_auth_base_rate`,
`rate_auth_occupancy_supplement`, or `rate_auth_meal_supplement` rows
reference it — the DB returns error 23503 (foreign key violation), which
the repository maps to `ConflictException (409)`.

A child age band cannot be deleted while any supplement row references it —
same 23503 guard.

Soft delete was rejected for child entities because:
- Contract-level `INACTIVE` status provides durable preservation at the
  agreement level.
- The `admin_audit_log` records every `DELETE` operation with its payload,
  providing the audit trail without needing a tombstone row.
- Filtering soft-deleted rows in composition queries (e.g. "fetch all active
  seasons for this contract") adds WHERE clauses that would need to be
  maintained across future queries.

### D10. `requireDateOrder` must run before the transaction, not inside it

`DirectContractsService.createSeason` calls `requireDateOrder(input.dateFrom,
input.dateTo)` as the **first line** of the method, before any `pool.connect()`
or `BEGIN`.

If the same guard is called inside the serializable transaction, an invalid
date range reaches the DB CHECK constraint (`rate_auth_season_dates_chk`),
which fires error 23514. The catch block executes `ROLLBACK` and re-throws
the raw PostgreSQL error. NestJS's global exception filter does not recognize
a raw `pg` error as an `HttpException` and returns 500.

Calling `requireDateOrder` before the transaction lets it throw
`BadRequestException` (400) cleanly, because no database state has been
touched yet.

### D11. Tenant scoping through contract ownership

`rate_auth_contract` carries `tenant_id`. Child tables — seasons, child age
bands, base rates, supplements — do **not** carry `tenant_id` directly.

Tenant isolation is enforced by the service, not the DB, on child writes:
every service method that operates on a child entity first calls
`ContractRepository.findById(contractId, tenantId)`. If the contract is not
found (wrong tenant or wrong id), the call returns null and the service
throws `NotFoundException`. The child operation then never executes.

This approach keeps child table rows narrow (no repeated `tenant_id` column
across every table) and makes tenant enforcement a single, auditable
entry-point per service method rather than a distributed WHERE clause that
must be maintained across repositories.

### D12. Audit log extension for DELETE operation

The `admin_audit_log` table's CHECK constraint originally permitted only
`('CREATE', 'PATCH', 'SOFT_DELETE')`. Hard-deleting seasons and child age
bands requires a `'DELETE'` operation value.

Migration `20260430000001_admin_audit_log_add_delete_op.ts` drops and
re-creates `admin_audit_log_op_chk` in a single `ALTER TABLE` statement to
include `'DELETE'`. The TypeScript `AuditOperation` type in
`audit-log.repository.ts` was updated in the same change.

The `admin_audit_log` row for a DELETE carries the deleted entity's
`resourceType`, `resourceId`, and a `payload` with enough context to
reconstruct what was deleted (e.g. `{ contractId }` for a deleted season).

### D13. pg DATE type parser must return raw strings

`pg` v8.x maps PostgreSQL DATE columns (OID 1082) to JavaScript `Date`
objects by default. Serializing a `Date` to JSON calls `toJSON()` which
produces an ISO UTC timestamp (`2026-06-30T20:00:00.000Z`). In a non-UTC
system timezone (e.g. UTC+4), this shifts the date backward by the offset
relative to UTC midnight.

`packages/db/src/pool.ts` registers a global type parser:

```typescript
types.setTypeParser(1082, (val: string) => val);
```

This returns DATE columns as raw `YYYY-MM-DD` strings. All code that reads
`date_from`, `date_to`, `valid_from`, `valid_to` from the DB receives a
plain string that serializes to JSON without drift. This parser is registered
once on the `pg` module singleton and applies to all connections in the
process.

## Consequences

- The `rate_auth_*` prefix is the canonical prefix for all authored-rate
  tables. Code and future migrations must follow this convention.
- The composite FK pattern (`UNIQUE(id, contract_id)` + composite FK on
  child tables) must be followed for any new child table added under a
  contract or season. This is the cross-contract integrity mechanism.
- The service-layer overlap check in `createSeason` relies on the
  serializable transaction holding a row lock on the contract. If a future
  path bypasses this (e.g. bulk import) it must implement an equivalent lock.
- INACTIVE contracts cannot be reopened. Any corrective action on an
  INACTIVE contract requires creating a new contract (optionally with
  `parent_contract_id` pointing to the old one).
- The global DATE type parser affects all queries in the process that return
  DATE columns — both authored tables and any other table (e.g. `valid_from`
  on `rate_auth_contract`). Test assertions on date fields must use
  `YYYY-MM-DD` string expectations, not `Date` object comparisons.

## Deferred

- `rate_auth_restriction` and `rate_auth_cancellation_policy` — Phase B.
  See ADR-023.
- Base rate CRUD service methods — not implemented in Phase A. The tables
  exist and are guarded by FK constraints; write paths land in the next
  slice.
- Allotment (`rate_auth_allotment` from ADR-021) — deferred until a
  real-world paper contract requires quantity limits.
- Copy-season workflow — the `copied_from_season_id` audit fields are not
  included in Phase A; copy-season is a Phase B operation.
- `version` on `rate_auth_contract` — stored but not incremented by the
  current `patch` implementation. Version bump belongs to an optimistic-lock
  strategy that is deferred until concurrent-edit scenarios arise in the
  admin UI.
