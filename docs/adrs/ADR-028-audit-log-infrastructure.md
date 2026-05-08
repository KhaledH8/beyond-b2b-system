# ADR-028: Audit log infrastructure — append-only events, schema, and access

- **Status:** Accepted (design locked 2026-05-08; amendment pass incorporated)
- **Date:** 2026-05-08
- **Supersedes:** nothing
- **Amends:** nothing (additive infrastructure layer)
- **Depends on:** ADR-026 (identity / role model — AuthContext shape,
  default deny, role catalogue), ADR-027 (operator impersonation —
  preconditions on audit-log invariants)
- **Required by:** ADR-027 V1.0 (impersonation V1.0 must not ship until
  this ADR's append-only invariant is enforced in production)

## Context

Several ADRs already in flight assume a working audit log:

- ADR-027 (impersonation) names three audit layers — lifecycle on
  `impersonation_grant`, per-request annotation, and a future
  sensitive-access secondary table — and explicitly preconditions
  V1.0 on **the audit table being INSERT-only at the database role
  level — even `platform_admin`'s connection cannot UPDATE or
  DELETE.**
- ADR-014 amendment (2026-04-22) requires every reward posting to
  carry funding source attribution. The provenance trail requires
  durable, untamperable record of who approved which posting.
- ADR-016 (document generation) requires an "audit row" alongside
  every gapless tax-document number allocation.
- ADR-024 (FX strategy) writes `fx_application` rows for every
  conversion and locks the chain `OXR/ECB/Stripe → applied amount`.
- ADR-026 D9 mentions audit emission obligations on role-grant /
  user-provisioning paths.

None of these have a canonical audit substrate to write into. Each
has so far either created its own append-only-ish table
(`booking_audit`, `pricing_trace`, etc.) or deferred the audit
question to "the audit log when it lands." This ADR is the one that
lands it.

The substrate must satisfy three load-bearing properties:

1. **Append-only at the database level.** Application code, including
   any code path that holds the `platform_admin` permission, cannot
   modify or delete audit rows. Enforcement is by DB role
   permissions, defended by triggers — not by repository
   discipline alone.
2. **Forensically usable.** A support engineer investigating an
   incident must be able to pivot quickly between actor, target,
   request, and impersonation grant. The schema must be
   self-contained enough that a row makes sense without joins to
   tables whose state has since changed.
3. **Operationally cheap.** Writing an audit event is on the hot
   path of nearly every authenticated request. The cost must be a
   single indexed insert; no synchronous fan-out; no cross-service
   call.

The substrate must NOT attempt:

- Tamper-evident hash chaining. That's a V2 cryptographic hardening
  (see locked non-features). Append-only DB enforcement is strong
  enough for V1; full cryptographic non-repudiation is not the same
  problem and shouldn't be conflated with it.
- SIEM / external log shipping. That's a deployment-time
  integration concern, not an ADR concern.
- A read UI. That's UI work in a later slice. The CLI / admin
  endpoints surfaced by this ADR are sufficient for V1.0.
- Anomaly detection / automated alerting. Separate slice.

## Decision

### D1. Append-only is the load-bearing invariant

The audit log's most important property is that **once an event row
is written, it cannot be modified or deleted by any code path the
application is privileged to execute.** No retroactive corrections.
No "fix the typo." No deletion on user request. No
TRUNCATE-during-truncating-tests.

Stated three ways for emphasis:

- The database role(s) used by the application have `INSERT,
  SELECT` only on audit tables. `UPDATE, DELETE, TRUNCATE` are
  not granted, period.
- Even a code path executed by a user holding every permission in
  the catalogue (e.g. `platform_admin`) cannot bypass the DB-level
  restriction. The permission system is application-layer; this
  is database-layer. They are not the same defense.
- "Corrections" are themselves new events. If audit row R was
  emitted with a wrong field, the response is to emit a corrective
  event referencing R, not to mutate R. The uncorrected row stays.

This invariant is the precondition ADR-027 V1.0 cites. It also
underwrites the audit obligations in ADR-014, ADR-016, ADR-024, and
ADR-026.

### D2. DB-level enforcement — roles + triggers

Two mechanisms, defense in depth.

**D2.a — Role-based grants (primary).**

Three Postgres roles separate the audit substrate's access:

- `bb_app` — the role the API uses for all requests. Granted
  `INSERT, SELECT` on every audit table. Not granted `UPDATE,
  DELETE, TRUNCATE`.
- `bb_audit_retention` — a separate role used only by the retention
  job. Granted `DELETE` on audit tables, scoped by retention policy
  (D8). Used via a dedicated credential rotation cycle. Never used
  by the API.
- `bb_admin` — the migration / DDL role. Used only by deployment
  pipelines. Owns the audit tables.

The grant set is enforced by migration. A migration that grants
`UPDATE` to `bb_app` on any audit table is a contract violation
detectable in code review.

**D2.b — Triggers (defense in depth).**

Every audit table has BEFORE UPDATE and BEFORE DELETE triggers that
raise immediately:

```sql
CREATE OR REPLACE FUNCTION audit_event_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only; %.% is forbidden',
    TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutation();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutation();
```

The trigger fires for ALL roles, including `bb_admin`. The
retention job cannot work via UPDATE/DELETE on `audit_event` leaf
rows — retention is implemented via partition-drop (D8).

The triggers are paranoid coverage. If `bb_app`'s grants are ever
mis-migrated to include UPDATE, the trigger still raises. The
trigger is also the canonical error message a developer sees if
they attempt to mutate an audit row in code.

**D2.c — `TRUNCATE` is also forbidden.**

Triggers do not fire on TRUNCATE; explicit `REVOKE TRUNCATE` from
all roles other than `bb_admin` is required. `bb_admin`'s
deployment pipeline is permitted to drop partitions (which is
TRUNCATE-like) only on partitioned audit tables per D8 retention.

**D2.d — `audit_pruning_log` — the audit of pruning. [Amendment]**

Partition-drop is the only deletion path for audit events. The
retention job (running as `bb_audit_retention`) DROPs leaf
partition tables directly via DDL. This creates a circular
evidence problem: if a dropped partition contained a
`SECURITY.AUDIT_PARTITION_DROPPED` event recording a prior drop,
that evidence is gone.

Resolution: a small, standalone, never-partitioned,
**never-pruned** table records every partition drop:

```sql
CREATE TABLE audit_pruning_log (
  id               CHAR(26)      NOT NULL PRIMARY KEY,
  pruned_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  partition_name   TEXT          NOT NULL,
  category         VARCHAR(24)   NOT NULL,
  partition_month  DATE          NOT NULL,   -- first day of the month
  row_count_est    BIGINT,                   -- pg_class.reltuples at DROP time
  retention_rule   TEXT          NOT NULL,   -- e.g. 'AUTH_7Y', 'APP_NON_FINANCIAL_2Y'
  dropped_by_role  TEXT          NOT NULL DEFAULT current_role
);
```

Grants:
- `bb_audit_retention` — `INSERT, SELECT` only. No DELETE.
- `bb_app` — `SELECT` only (so the read API can include pruning
  history in audit investigations).
- `bb_admin` — owner, but dropping this table requires a manual
  DBA action that is separate from the retention job's DDL and
  would appear in the deployment pipeline audit trail.

The retention job MUST write a row to `audit_pruning_log`
**before** issuing `DROP TABLE`. If the INSERT fails, the
partition is not dropped — the job aborts and alerts. A missing
`audit_pruning_log` row for a dropped partition is evidence of
either an untested code path or a manual intervention.

This table is never pruned. Its maximum size over 7 years at one
row per monthly partition per category is bounded:
`5 categories × 12 months × 7 years = 420 rows`. Negligible.

### D3. Schema — single canonical table plus specialized context tables

The audit substrate is one canonical table for the primary record,
plus a short list of specialized context tables for shapes that
don't fit.

**`audit_event` — the canonical table, composite-partitioned.**

The table uses **composite partitioning** (LIST by category, then
RANGE by `occurred_at` within each category). This ensures that
categories with different retention windows are never co-mingled
in a single drop unit. [Amendment — D8.]

```sql
-- Parent table: list-partitioned by category.
CREATE TABLE audit_event (
  id                     CHAR(26) NOT NULL,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version         SMALLINT NOT NULL,

  -- Categorization
  category               VARCHAR(24) NOT NULL,
  kind                   VARCHAR(64) NOT NULL,

  -- Tenancy. Always populated; default tenant for system events.
  tenant_id              CHAR(26) NOT NULL,

  -- Actor (who initiated the action).
  actor_kind             VARCHAR(16) NOT NULL,
  actor_user_id          CHAR(26),
  actor_api_key_id       CHAR(26),
  actor_label            VARCHAR(120),

  -- Target (what the action touched). Both nullable; many events
  -- have an actor but no clear single target.
  target_kind            VARCHAR(32),
  target_id              VARCHAR(64),

  -- Request correlation.
  request_id             CHAR(26),
  impersonation_grant_id CHAR(26),
  ip_address             INET,
  user_agent             TEXT,

  -- Structured event-specific payload. Bounded.
  payload                JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT audit_event_pk
    PRIMARY KEY (id, category, occurred_at),

  CONSTRAINT audit_event_category_chk CHECK (category IN
    ('APP', 'AUTH', 'IMPERSONATION', 'SENSITIVE_ACCESS', 'SECURITY')),

  CONSTRAINT audit_event_actor_kind_chk CHECK (actor_kind IN
    ('USER', 'API_CONSUMER', 'INTERNAL', 'ANONYMOUS')),

  CONSTRAINT audit_event_actor_user_chk CHECK (
    (actor_kind = 'USER' AND actor_user_id IS NOT NULL)
    OR (actor_kind <> 'USER' AND actor_user_id IS NULL)
  ),

  CONSTRAINT audit_event_actor_api_key_chk CHECK (
    (actor_kind = 'API_CONSUMER' AND actor_api_key_id IS NOT NULL)
    OR (actor_kind <> 'API_CONSUMER' AND actor_api_key_id IS NULL)
  ),

  CONSTRAINT audit_event_payload_size_chk
    CHECK (octet_length(payload::text) <= 65536),

  CONSTRAINT audit_event_schema_version_chk
    CHECK (schema_version >= 1)

) PARTITION BY LIST (category);


-- Intermediate partitions: one per category, sub-partitioned by month.
CREATE TABLE audit_event_app PARTITION OF audit_event
  FOR VALUES IN ('APP')
  PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_event_auth PARTITION OF audit_event
  FOR VALUES IN ('AUTH')
  PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_event_impersonation PARTITION OF audit_event
  FOR VALUES IN ('IMPERSONATION')
  PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_event_sensitive_access PARTITION OF audit_event
  FOR VALUES IN ('SENSITIVE_ACCESS')
  PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_event_security PARTITION OF audit_event
  FOR VALUES IN ('SECURITY')
  PARTITION BY RANGE (occurred_at);


-- Leaf partitions: named <category_snake>_<YYYY>_<MM>.
-- Created by a cron job a month ahead of write demand.
-- Example for May 2026:
CREATE TABLE audit_event_app_2026_05
  PARTITION OF audit_event_app
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_event_auth_2026_05
  PARTITION OF audit_event_auth
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_event_impersonation_2026_05
  PARTITION OF audit_event_impersonation
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_event_sensitive_access_2026_05
  PARTITION OF audit_event_sensitive_access
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_event_security_2026_05
  PARTITION OF audit_event_security
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

The composite partition scheme means the retention job drops, for
example, `audit_event_security_2024_03` (2-year-old SECURITY)
without touching `audit_event_auth_2024_03` (which stays until
the 7-year window). No cross-category co-mingling in a drop unit.

**Indexes (declared on the parent; Postgres propagates to each leaf
partition automatically):**

```sql
-- Hot pivot 1: by actor user, recent first.
CREATE INDEX audit_event_actor_user_idx
  ON audit_event (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Hot pivot 2: by target.
CREATE INDEX audit_event_target_idx
  ON audit_event (target_kind, target_id, occurred_at DESC)
  WHERE target_id IS NOT NULL;

-- Hot pivot 3: by request id (single-request investigation).
CREATE INDEX audit_event_request_idx
  ON audit_event (request_id)
  WHERE request_id IS NOT NULL;

-- Hot pivot 4: by impersonation grant.
CREATE INDEX audit_event_impersonation_idx
  ON audit_event (impersonation_grant_id, occurred_at DESC)
  WHERE impersonation_grant_id IS NOT NULL;

-- Hot pivot 5: by kind for ops queries within a category's tree.
CREATE INDEX audit_event_kind_idx
  ON audit_event (kind, occurred_at DESC);
```

Hot pivot 5 replaces the prior `(category, kind, occurred_at)`
compound index. Because queries are now routed into the appropriate
category subtree by the partition constraint, `category` in the
index is redundant — Postgres's partition pruning eliminates all
but the matching category intermediate partition before evaluating
the index.

**Specialized context tables.**

Most events fit the canonical row. Two shapes that don't:

- `impersonation_sensitive_access` (named in ADR-027 D9 Layer 3,
  deferred to V1.1). Per-request granular tracking when the
  impersonation session reads a sensitive surface. Linked to the
  impersonation grant. Schema deferred to its own migration.
- `audit_event_payload_overflow` (forward-loaded). When a payload
  legitimately exceeds the 64KB cap (rare, e.g. large diff blobs),
  the payload pointer goes here keyed to `audit_event.id`. V1.0
  does not need it; emitters that hit the cap should redesign the
  event rather than overflow.

Both specialized tables are append-only under the same regime as
`audit_event` (D2). Both are NOT partitioned; they are
standalone tables subject to explicit retention decisions in a
separate future ADR.

### D4. Event categories

Five top-level categories. Each event has exactly one category; the
category drives both retention (D8) and access (D9).

| Category | Meaning | Examples |
|---|---|---|
| `APP` | Business-domain actions on the platform's data. | `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `LEDGER_ENTRY_POSTED`, `DOCUMENT_ISSUED`, `MAPPING_DECISION_RECORDED`, `MARKUP_RULE_EDITED` |
| `AUTH` | Identity / role / membership lifecycle events. Distinct from external Auth0 webhook events, which live in `auth0_event_ingestion`. | `USER_PROVISIONED`, `USER_DEACTIVATED`, `ROLE_GRANTED`, `ROLE_REVOKED`, `MEMBERSHIP_CHANGED`, `API_KEY_ISSUED`, `API_KEY_REVOKED` |
| `IMPERSONATION` | ADR-027 lifecycle events. | `IMPERSONATION_STARTED`, `IMPERSONATION_ENDED`, `IMPERSONATION_START_REJECTED` |
| `SENSITIVE_ACCESS` | Per-request annotations when a flagged surface is read. ADR-027 D9 Layer 3. V1.1+. | `BOOKING_DETAIL_VIEWED_SENSITIVE`, `LEDGER_VIEW_ACCESSED_SENSITIVE`, `DOCUMENT_DOWNLOADED_SENSITIVE` |
| `SECURITY` | Security-relevant events that aren't auth lifecycle. | `RATE_LIMIT_TRIGGERED`, `SUSPICIOUS_LOGIN_PATTERN`, `WEBHOOK_SIGNATURE_FAILED`, `INTERNAL_KEY_REJECTED`, `AUDIT_QUERY_EXECUTED`, `AUDIT_QUERY_EXECUTED_SENSITIVE`, `AUDIT_PARTITION_DROPPED` |

The `kind` column is fine-grained; the `category` column is the
coarse pivot retention and access policies key on. `kind` values are
defined in code as a closed enum next to the audit emission API
(D7). Adding a new `kind` requires a code change; it does not
require a migration. Adding a new `category` requires both a code
change and a CHECK-constraint migration.

External webhook events from Auth0 (login successes, password
changes, account lockouts) continue to live in
`auth0_event_ingestion` — that's an idempotency ledger for events
we did not emit, not the audit log. When we ACT on a webhook event
(e.g. flip `core_user.status` to DEACTIVATED on receipt of an
Auth0 user-deleted event), we ALSO emit an `AUTH` event recording
our action. The two stores serve different purposes.

### D5. Event schema principles

Locked rules for any event written to `audit_event`:

**P1. Immutable.** Per D1. Field updates after-the-fact are
forbidden. A correction is itself a new event referencing the
original via `payload.corrects_event_id`.

**P2. Self-contained for its category's retention window.** A
support engineer reading an event 18 months after it was written
must not need to join to operational tables to make sense of it.
This means denormalizing the small fields that matter (e.g. for an
`IMPERSONATION_STARTED` event, copy the target account's `name` and
`account_type` into the payload at write time, not just the
`account_id`). The operational tables may have changed between
write and read.

**P3. Versioned.** Every row carries `schema_version`. Bumps to a
category's payload shape must be coordinated: emit a new
`schema_version`, document the diff next to the kind enum. Old
rows are not migrated. Readers handle multiple versions.

**P4. No PII free-text where avoidable.** Audit rows store IDs and
small structured metadata. They do not store free-form fields
holding passenger names, email addresses, document scans, etc.
Two acknowledged exceptions:

- Free-text reason fields entered by operators (e.g.
  `IMPERSONATION_STARTED.payload.reason_text`,
  `BOOKING_CANCELLED.payload.cancellation_note`). These may
  contain PII because they are operator narrative. The product
  cost of forbidding free-text reasons is too high; the audit
  cost is accepted.
- IP and user-agent already capture device-identifying
  information that is PII under GDPR. Retained per the policy
  (D8); subject to deletion only when the audit retention window
  itself expires.

PII-bearing payload fields, when present, must be flagged in the
`kind` enum's documentation so the retention job can apply the
right policy.

**P5. Bounded.** Payload `octet_length(payload::text) <= 65536`,
enforced by CHECK. An emitter that wants to record a larger
artifact should record an object-store URI, a hash, and a small
summary.

**P6. Time has two timestamps.** `occurred_at` is the wall-clock
time of the event in the actor's request flow.
`recorded_at` is the database write time. They differ when an
emitter records an event after retry / queue replay. Both are
NOT NULL.

**P7. Tenant-scoped, always.** `tenant_id` is NOT NULL on every
row. System / cross-tenant events use a designated system
tenant ULID (out-of-band convention; not a special-cased NULL).

**P8. Idempotent at the emitter, not the schema.** The emitter is
responsible for not double-emitting the same logical event; the
schema does not enforce uniqueness on payload content. Where
idempotency matters (e.g. webhook-driven events), the emitter
checks an idempotency ledger before writing.

### D6. Correlation and traceability

Every authenticated request gets a `request_id` (a ULID) at the
HTTP entry layer. The ID is propagated through:

- The structured logger MDC for the request lifetime.
- Every audit event emitted during the request, in the
  `request_id` column.
- The HTTP access log line.
- Outgoing internal HTTP calls (header `X-Request-Id`).

A second propagated ID is `impersonation_grant_id` (per ADR-027
D9 Layer 2), set on every audit event emitted during an active
grant.

These two IDs are the primary investigation pivots:

- "Show everything that happened on request X." →
  `WHERE request_id = $1`.
- "Show everything that happened during impersonation grant Y." →
  `WHERE impersonation_grant_id = $1`.
- "Show everything actor U did this morning." →
  `WHERE actor_user_id = $1 AND occurred_at >= $2`.
- "Show everything done to target booking B." →
  `WHERE target_kind = 'BOOKING' AND target_id = $1`.

A third forward-loaded ID, `correlation_id`, is held back for V1.1.
It would group related events across multiple requests (e.g. a
booking saga that spans confirm + payment-capture + document
issue). For V1.0, `request_id` plus `target_id` are sufficient
to reconstruct sagas after-the-fact.

### D7. `AuditService` — the only path to writing an event

A single application-level service is the only callable that
writes to audit tables. Repositories must not write directly. This
serves two purposes:

- Schema discipline. The service builds typed event objects from
  a fixed enum of kinds; emitters cannot accidentally drift
  payload shape.
- Correlation propagation. The service reads `request_id` and
  `impersonation_grant_id` from request-scoped context (Nest
  request scope or `AsyncLocalStorage`) and stamps them on every
  row. Emitters do not pass them explicitly.

Sketch of the API:

```ts
interface AuditService {
  /**
   * Best-effort background emission. APP and SECURITY categories only.
   * AUTH and IMPERSONATION calls here are a compile-time error via the
   * overloaded type — see below.
   */
  emit(event: AuditEventInputBackground): Promise<void>;

  /** Batch variant of emit. Same category restriction applies. */
  emitMany(events: readonly AuditEventInputBackground[]): Promise<void>;

  /**
   * Synchronous emission in the caller's DB transaction.
   * REQUIRED for AUTH and IMPERSONATION categories. [Amendment]
   * The audit INSERT is part of the same atomic unit as the business write;
   * if the transaction rolls back, the audit row rolls back too.
   */
  emitInTransaction(client: PoolClient, event: AuditEventInput): Promise<void>;
}

// Background-permissible events: APP and SECURITY only.
type AuditEventInputBackground = Extract<AuditEventInput,
  { category: 'APP' | 'SECURITY' }>;

type AuditEventInput =
  // APP category — background queue permissible
  | { category: 'APP'; kind: 'BOOKING_CONFIRMED'; tenantId: string;
      targetId: string; payload: BookingConfirmedPayload; }
  | { category: 'APP'; kind: 'BOOKING_CANCELLED'; tenantId: string;
      targetId: string; payload: BookingCancelledPayload; }
  | { category: 'APP'; kind: 'LEDGER_ENTRY_POSTED'; tenantId: string;
      targetId: string; payload: LedgerEntryPostedPayload; }
  // ... other APP kinds

  // AUTH category — emitInTransaction REQUIRED [Amendment]
  | { category: 'AUTH'; kind: 'USER_PROVISIONED'; tenantId: string;
      targetId: string; payload: UserProvisionedPayload; }
  | { category: 'AUTH'; kind: 'ROLE_GRANTED'; tenantId: string;
      targetId: string; payload: RoleGrantedPayload; }
  | { category: 'AUTH'; kind: 'ROLE_REVOKED'; tenantId: string;
      targetId: string; payload: RoleRevokedPayload; }
  // ... other AUTH kinds

  // IMPERSONATION category — emitInTransaction REQUIRED [Amendment]
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_STARTED';
      tenantId: string; targetId: string;
      payload: ImpersonationStartedPayload; }
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_ENDED';
      tenantId: string; targetId: string;
      payload: ImpersonationEndedPayload; }
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_START_REJECTED';
      tenantId: string; targetId: string;
      payload: ImpersonationStartRejectedPayload; }

  // SECURITY category — background queue permissible
  | { category: 'SECURITY'; kind: 'WEBHOOK_SIGNATURE_FAILED';
      tenantId: string; payload: WebhookSignatureFailedPayload; }
  | { category: 'SECURITY'; kind: 'AUDIT_QUERY_EXECUTED';
      tenantId: string; payload: AuditQueryExecutedPayload; }   // [Amendment]
  | { category: 'SECURITY'; kind: 'AUDIT_QUERY_EXECUTED_SENSITIVE';
      tenantId: string; payload: AuditQueryExecutedPayload; }   // [Amendment]
  | { category: 'SECURITY'; kind: 'AUDIT_PARTITION_DROPPED';
      tenantId: string; payload: AuditPartitionDroppedPayload; }
  // ... other SECURITY kinds
```

**Emission rules by category — locked. [Amendment]**

| Category | Emission path | Rationale |
|---|---|---|
| `AUTH` | `emitInTransaction` **only** | Identity and role changes are legally significant. If the business write commits but the audit write loses on queue drain, we have no record of who was granted what. Rolling back together is the only acceptable failure mode. |
| `IMPERSONATION` | `emitInTransaction` **only** | Same rationale. ADR-027's audit precondition is meaningless if the audit write can be lost on node restart. |
| `SENSITIVE_ACCESS` | `emitInTransaction` **only** | Access to PII is subject to the same legal traceability obligation. (V1.1; locked here for consistency.) |
| `APP` | `emit` (background queue permissible) | High volume; losing an individual `BOOKING_CONFIRMED` audit event is operationally bad but not legally catastrophic — the booking itself is the source of truth. |
| `SECURITY` | `emit` (background queue permissible) | Operational forensics value; not on the critical write path. |

The TypeScript overload on `emit` enforces this at compile time:
calling `emit` with an `AUTH` or `IMPERSONATION` event is a type
error. The guard also exists at runtime in the service body for
defense in depth.

The service is responsible for:

- Filling `id`, `recorded_at`, `actor_*`, `request_id`,
  `impersonation_grant_id`, `ip_address`, `user_agent` from
  request context.
- Setting `category` from the kind's declared category in the
  discriminated union.
- Setting `schema_version` from the kind's current registered
  version.
- Routing the INSERT to the correct category partition tree.

**Failure mode of `AuditService.emit` (background path):** an
audit write failure is **logged at ERROR but does not fail the
originating request.** The business action must complete. A
best-effort retry queue lives behind the service; persistent
failure raises an alert.

The retry queue is itself bounded (e.g. ring buffer + drop-oldest
under saturation). On node restart, in-flight events in the queue
are lost. This is acknowledged residual risk for `APP` and
`SECURITY` events; AUTH and IMPERSONATION events do not pass
through this queue (they are transactional) and therefore cannot
be lost this way.

**Failure mode of `AuditService.emitInTransaction`:** the INSERT
runs in the caller's transaction. If the INSERT fails (e.g. DB
constraint), the transaction rolls back and the caller receives an
exception. The business write does not commit without its audit
write. This is by design.

### D8. Retention

Retention is per-category, implemented via monthly leaf-partition
drop within each category's partition tree. [Amendment]

| Category | Retention | Rationale |
|---|---|---|
| `APP` (financial-relevant: BOOKING, LEDGER, DOCUMENT kinds) | 7 years | Aligned with financial-record audit obligations. |
| `APP` (non-financial: MAPPING, MARKUP_RULE_EDITED, and similar operational kinds) | 2 years | Operational forensics window; further retention not legally required. |
| `AUTH` | 7 years | Identity-event audit obligation aligned with financial windows. |
| `IMPERSONATION` | 7 years | Closes ADR-027's audit story for the financial window. |
| `SENSITIVE_ACCESS` | 7 years | Same window as the IMPERSONATION events they annotate. |
| `SECURITY` | 2 years | Operational forensics; legal review may extend specific kinds. |

**Mechanism — category-segregated partition drop. [Amendment]**

Because retention windows differ between categories, it is
critical that no single drop unit contains events from more than
one category. The composite partitioning in D3 guarantees this:
each leaf partition (e.g. `audit_event_auth_2026_05`) belongs to
exactly one category's tree. The retention job can drop
`audit_event_security_2024_03` (SECURITY, 2-year window) without
touching `audit_event_auth_2024_03` (AUTH, 7-year window), even
though both cover the same calendar month.

Retention job steps for each leaf partition being dropped:

1. Record an INSERT into `audit_pruning_log` (D2.d) with the
   partition name, category, month, estimated row count, and
   applicable retention rule.
2. Only on successful INSERT: execute `DROP TABLE <partition_name>`.
3. If step 1 fails: log at ERROR, send alert, skip this partition.
   Do not drop without a pruning log record.

Within `APP`, two retention windows apply to different `kind`
values. Because a single leaf partition (e.g.
`audit_event_app_2024_03`) may contain both financial and
non-financial APP kinds, the partition is held to the **longer**
window (7 years). If a specific non-financial APP kind grows to
a volume where separate shorter-retention storage is warranted,
that kind is split into its own category-like separate table via
a future ADR. V1 does not need this.

Partitions are NEVER selectively pruned by row. There is no path
to "delete user X's audit events" via the application. GDPR
right-to-erasure interacts with this: see Open items.

The partition creation cron creates leaf partitions for each of
the five category trees one month ahead of write demand.

### D9. Operational access and review

**Read access is permission-gated.**

A new permission `AUDIT_READ` already exists in the catalogue
(ADR-026 D8). Held by `read_only_auditor`, `ops_support`,
`finance_ops`, `integrations_ops`, `platform_admin`. This
permission gates the future read API.

A second permission, `AUDIT_READ_SENSITIVE`, is introduced by this
ADR. It is required to read events in the `SENSITIVE_ACCESS`
category and events whose `kind` is flagged as PII-bearing in the
kind enum. Held only by `platform_admin` and a future
`security_ops` role. This separates "I want to know who did
what" (broad) from "I want to know who saw what passenger PII"
(narrower).

**Read API surface (V1.0):**

- `GET /admin/audit/events` — paginated query with filters:
  `actorUserId`, `targetKind+targetId`, `requestId`,
  `impersonationGrantId`, `category`, `kind`, time range. Default
  sort `occurred_at DESC`. Permission: `AUDIT_READ` plus
  `AUDIT_READ_SENSITIVE` if the query selects sensitive
  categories or kinds.
- `GET /admin/audit/events/:id` — single event detail.
- A CLI `bb-audit query …` against the same DB, for ops use during
  incidents when the API is degraded.

**Audit reads are themselves audited. [Amendment]**

Every call to `GET /admin/audit/events` emits a
`SECURITY.AUDIT_QUERY_EXECUTED` event recording who queried, when,
and which filters were applied (but NOT the result rows
themselves — only the filter shape and result count). This prevents
an operator from silently mining the audit log without leaving a
trace.

Every call to `GET /admin/audit/events/:id` where the fetched
event belongs to the `SENSITIVE_ACCESS` category or is flagged
PII-bearing emits `SECURITY.AUDIT_QUERY_EXECUTED_SENSITIVE`
instead. Non-sensitive single-event fetches emit
`SECURITY.AUDIT_QUERY_EXECUTED`.

Payload for both kinds:

```ts
interface AuditQueryExecutedPayload {
  endpoint: 'LIST' | 'DETAIL';
  filters?: {                 // present on LIST
    actorUserId?: string;
    targetKind?: string;
    targetId?: string;
    requestId?: string;
    impersonationGrantId?: string;
    category?: string;
    kind?: string;
    from?: string;
    to?: string;
  };
  fetchedEventId?: string;   // present on DETAIL
  resultCount?: number;      // present on LIST
  requiredPermission: 'AUDIT_READ' | 'AUDIT_READ_SENSITIVE';
}
```

These events use the background queue (`emit`, not
`emitInTransaction`). Rationale: they are operational observability
events, not identity-change or impersonation lifecycle events. The
read request succeeds and returns its results immediately; the audit
write is best-effort. If the audit write of the read event fails,
the read result is still correct — we accept the rare loss of a
read-audit event over blocking the read itself.

The CLI `bb-audit query` path also emits `AUDIT_QUERY_EXECUTED`
via the same `AuditService`. The CLI does not skip the audit step.

**Review obligations.**

- `IMPERSONATION_*` events: monthly review by an operator holding
  `AUDIT_READ` (separate human from the actor where possible).
  Review confirms ticket refs match real support tickets.
- `AUTH.ROLE_GRANTED` events: quarterly review.
- `SECURITY` events: weekly summary, alerted if volume spikes.
  `AUDIT_QUERY_EXECUTED` events are included in the weekly review
  if volume is anomalous.

Review tooling lives in operational dashboards downstream of this
ADR. V1.0 ships with the read API; the dashboards follow.

**Append-only-test-mode.** Test environments use the same role
restrictions as production. Tests that need to "clean up" audit
rows between runs run in their own test DB instance which is
truncated as a whole, never via the application role.

### D10. What ADR-027 V1.0 requires from this ADR

ADR-027 V1.0 (impersonation V1.0) preconditions:

1. **Append-only enforcement live in production.** D2.a + D2.b
   shipped: `bb_app` lacks UPDATE/DELETE/TRUNCATE on `audit_event`;
   triggers raise on attempted mutation.
2. **`audit_event` table migrated** with the IMPERSONATION-category
   partition tree and indexes (D3).
3. **`AuditService` API in place** (D7) with at minimum the
   `IMPERSONATION_STARTED`, `IMPERSONATION_ENDED`,
   `IMPERSONATION_START_REJECTED` event variants typed and
   emitting via `emitInTransaction`.
4. **Request-id propagation live** (D6). `AuthContext` already
   carries impersonation; this ADR adds the `request_id`
   propagation layer.
5. **A read path exists** — `GET /admin/audit/events` with the
   `impersonationGrantId` filter, OR a CLI equivalent. Without
   it, the audit log is write-only-from-app-perspective and the
   ADR-027 review obligation cannot be discharged.

Items 1–4 are blocking. Item 5 may be deferred up to ~2 weeks
after impersonation V1.0 ships if the CLI path is sufficient for
the on-call rotation in the interim — but no longer.

The `SENSITIVE_ACCESS` table from ADR-027 D9 Layer 3 is NOT in
ADR-027 V1.0's preconditions; it ships in V1.1.

### D11. Locked non-features

Out of scope for V1.0; out of scope for V2 unless a specific
follow-up ADR amends:

- **Cryptographic hash chain / tamper-evident log.** A future ADR
  may add hash chaining over `audit_event` rows for legal
  non-repudiation. V1's append-only DB enforcement is strong
  enough for operational needs and is not the same problem.
- **External SIEM shipping (Splunk, Elastic, Datadog Audit
  Trail).** Deployment-time integration; if needed, ships as a
  read-side projection consuming logical replication, not as a
  primary write target. This ADR does not block it; it does not
  require it.
- **Cross-region replication of audit events.** Whatever the
  primary region's HA story is, audit follows it. Multi-region
  writes are a different problem.
- **Synchronous fan-out at write time** (e.g. write to DB and
  Kafka in the same emit call). The DB write is the source of
  truth. Downstream projections subscribe asynchronously.
- **Per-row redaction / right-to-erasure on individual rows.** D5
  P4 keeps PII out of payloads where avoidable; partition-drop
  retention is the only deletion path. If GDPR reviews require
  per-row redaction, a separate ADR addresses it.
- **Anomaly detection / automated alerting.** Future slice.
  Volume-based alerting (e.g. spike in `SECURITY` events) is
  cheap and probably the first one to add; behavioural anomaly
  detection is a different program of work.
- **Mutation API even with strong permissions.** No human role,
  no operator action, no admin API can edit an audit row. Period.

## Consequences

- **One additional partition tree on the hot path.** Every
  authenticated request that does any business action emits at
  least one `audit_event` row. Insert cost is an indexed write
  into the current month's leaf partition within the appropriate
  category tree. Acceptable.
- **`AuditService` becomes a load-bearing primitive.** Adding new
  business actions almost always involves declaring a new audit
  kind. Code review for any new endpoint should ask "what audit
  events does this emit?"
- **AUTH and IMPERSONATION writes extend the DB transaction.** The
  `emitInTransaction` contract means every `USER_PROVISIONED`,
  `ROLE_GRANTED`, `IMPERSONATION_STARTED`, etc. event adds one
  INSERT to the enclosing DB transaction. For the events in
  question, the latency cost is acceptable and the correctness
  guarantee is required.
- **Three Postgres roles required.** Deployment / DB provisioning
  must create `bb_app`, `bb_audit_retention`, `bb_admin` with the
  grants in D2.a. Existing single-role deployments need migration;
  this is a one-time operational task before D10 preconditions
  are met.
- **`audit_pruning_log` is a permanent table.** It is never pruned,
  never partitioned, and bounded in size (see D2.d). Ops must
  account for it in backup policy and not assume it is prunable.
- **Test-environment hygiene changes.** Tests cannot DELETE from
  audit tables via the app role. Test isolation moves to
  per-test-suite DB instances or per-test transaction rollback
  (which already discards the audit insert at rollback).
- **Retention job must write `audit_pruning_log` before dropping
  each partition.** A retention job that silently skips the
  pruning log write will fail loudly (it is required to succeed
  before the DROP). Ops must monitor retention job alerting.
- **Composite partitioning adds intermediate partition tables.**
  Five intermediate tables (`audit_event_app`, etc.) plus monthly
  leaf tables. The operational tooling (monitoring queries,
  pg_partman if adopted, VACUUM tuning) must be aware of the
  three-level hierarchy: parent → category intermediate → monthly
  leaf.
- **Audit read endpoints are audited.** Callers to
  `GET /admin/audit/events` will see their queries recorded in
  the audit log. This is expected and correct behavior; it is not
  a bug when a SECURITY category `AUDIT_QUERY_EXECUTED` event
  appears.
- **Dependency on `request_id` propagation infrastructure.** The
  HTTP entry layer must mint a request id and stash it where
  `AuditService` can read it. Implementation cost: small
  middleware + AsyncLocalStorage / Nest request scope.
- **Read replica becomes part of the audit read path's spec.**
  Not strictly required for V1.0, but the read API should be
  designed to accept lag. If no read replica is provisioned,
  audit reads land on the primary; that's fine for V1 volume.
- **No chain-of-custody guarantee in V1.0.** A determined attacker
  with `bb_admin` credentials could in theory drop audit
  partitions. The trigger and the role-separation defend against
  the application; they do not defend against a compromised
  credential. Mitigations live in deployment hygiene
  (`bb_admin` rotated, used only via pipeline, MFA on the
  pipeline) and in V2 hash-chaining if the threat model demands
  it. `audit_pruning_log` makes such an attack at least visible
  in the absence of the dropped partition.

## Open items

The following items are explicitly NOT blockers for locking this
ADR. They are tracked here for resolution at implementation time.

- **Legal sign-off on retention windows.** The 7-year / 2-year
  split is calibrated to typical financial-record obligations. A
  jurisdiction-specific review (UAE, EU) may adjust specific
  windows. A future ADR amendment adjusts the retention table in
  D8 and the relevant partition drop schedule.
- **GDPR right-to-erasure interaction.** Audit rows are not
  individually erasable. The product / legal path on a GDPR
  erasure request is: scrub PII from operational tables, leave
  audit IDs as opaque references whose human meaning is gone with
  the operational delete. This needs legal sign-off before V1.0
  ships. If legal requires per-row erasure, the ADR's
  partition-only-deletion model needs revisiting.
- **`AUDIT_READ_SENSITIVE` permission rollout.** The permission
  is introduced by D9 but is not yet in ADR-026's catalogue. The
  role assignments (`platform_admin` only initially) are
  specified here; the catalogue add lands as a small migration in
  the implementation slice.
- **Read replica.** Whether one exists at impersonation V1.0 time.
  D9 says reads land on the primary if no replica is provisioned;
  this is acceptable but should be confirmed.
- **Default tenant ULID for system events.** D5 P7 references a
  designated system tenant ULID. Value is generated at deploy
  time and stored in env / config; not a hardcoded constant in
  this ADR. Resolved at first deployment.
- **Audit emission for Auth0 webhook reactions.** When the
  `auth0_event_ingestion` handler flips `core_user.status`, it
  should emit an `AUTH.USER_DEACTIVATED` event via
  `emitInTransaction`. This is not yet wired (E2-B did not depend
  on this ADR). Backfill question: do we replay historic webhook
  ingestion to emit the missing audit events, or do we accept the
  gap? "Accept the gap and document it" is probably right; a one
  paragraph follow-up note in the implementation slice's
  postmortem is enough.
- **Log-shipping / SIEM integration timing.** Locked as out of
  scope here, but enterprise customers sometimes require it.
  When the first such customer surfaces, that's a fresh ADR.
- **Volume estimation.** The `audit_event` row size is bounded
  but the row count is not. At 7-year retention on an active
  platform, the table will be large. Partitioning by category and
  month bounds the per-partition size; total storage cost is
  something to budget. Not blocking V1.0; revisit at the first
  capacity-planning review.
- **`RATE_LIMIT_TRIGGERED` and similar high-volume `SECURITY`
  events.** A bot scanning the API can flood `SECURITY` events.
  Rate-limit the audit emission of rate-limit events (sample,
  with counts in the payload) to avoid audit-table-DoS. This is
  an emit-side concern; the service contract needs to include a
  back-pressure mechanism.
- **`AUDIT_QUERY_EXECUTED` volume from the CLI path.** If the
  `bb-audit query` CLI is used in a tight loop (scripted incident
  investigation), it will produce a high volume of
  `AUDIT_QUERY_EXECUTED` events. Rate-limiting or sampling on
  the CLI path is acceptable; it should be wired consistently
  with the API path's approach.

## Implementation order

1. **DB roles and ownership.** Create `bb_app`, `bb_audit_retention`,
   `bb_admin`. Document the credential management. Existing
   environments rotate `bb_app` after the role split.
2. **`audit_event` migration.** Parent table (LIST-partitioned by
   category), five intermediate partitions (RANGE by `occurred_at`
   each), monthly leaf creation cron, indexes, triggers, role
   grants. Initial leaf partitions for current and next month
   across all five category trees.
3. **`audit_pruning_log` migration.** Standalone table, grants
   per D2.d. Created in the same migration batch as step 2.
4. **`AuditService` skeleton.** TypeScript service in
   `apps/api/src/audit/`, with the discriminated union over
   `kind` and the `emit` / `emitInTransaction` split. Compile-time
   enforcement that `AUTH` and `IMPERSONATION` cannot call `emit`.
   AsyncLocalStorage / Nest request scope hookup for `request_id`
   and `impersonation_grant_id` propagation.
5. **Request-id middleware.** HTTP entry layer mints `request_id`
   (ULID) per request and stashes it in request scope.
6. **First emitters.** ADR-027 IMPERSONATION events go through
   `AuditService.emitInTransaction` from day one. The
   implementation order for ADR-027 V1.0 (its slice 8) becomes a
   downstream consumer of this ADR's slices 1-4.
7. **Read API.** `GET /admin/audit/events` with filter shape from
   D9, gated by `AUDIT_READ` and `AUDIT_READ_SENSITIVE`.
   Emits `AUDIT_QUERY_EXECUTED` / `AUDIT_QUERY_EXECUTED_SENSITIVE`
   via `emit` (background). `AUDIT_READ_SENSITIVE` permission
   added to the catalogue (small ADR-026 amendment).
8. **CLI `bb-audit query`.** Same query surface, runs against the
   DB directly. Emits `AUDIT_QUERY_EXECUTED` via `AuditService`.
9. **Retention cron.** Run by `bb_audit_retention`. For each
   leaf partition past its window: INSERT into `audit_pruning_log`
   then DROP TABLE. Logs job-level summary as
   `SECURITY.AUDIT_PARTITION_DROPPED` via `emit`.
10. **Backfill hooks for prior emitters.** ADR-014, ADR-016,
    ADR-024's existing audit-shaped tables migrate to emit through
    `AuditService` over time. Not part of V1.0; flagged for a
    follow-up consolidation slice.
11. **V1.1 — `impersonation_sensitive_access`** (the table named
    in ADR-027 D9 Layer 3) and the matching `SENSITIVE_ACCESS`
    category emitters. Lands after impersonation V1.0 stabilizes.

The minimum viable set is steps 1–6. Once those land, ADR-027
V1.0 unblocks.
