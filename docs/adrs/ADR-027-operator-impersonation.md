# ADR-027: Operator impersonation — model, audit, and constraints

- **Status:** Accepted (design); no code yet
- **Date:** 2026-05-09
- **Supersedes:** nothing
- **Amends:** nothing (additive layer; existing controllers do not change)
- **Depends on:** ADR-026 (identity / role model — JwtAuthGuard,
  RolesGuard, PermissionResolverService, AuthContext shape, default
  deny, DB-resolved permissions); the audit-log infrastructure ADR
  (forthcoming — see Open items)

## Context

Slice E4-A added `JwtAuthGuard + RolesGuard + @RequirePermission` to
`POST /search`. Slice E4-B added body-vs-`AuthContext` reconciliation
on the same endpoint and locked operator-as-self search out:
operators today receive **403 with the policy message _"Operator
search requires impersonation; not supported in V1 (ADR-026 E8)"_**.
The agency-side surface is otherwise functional, but operators have
no path to see what an agency sees.

That gap is the support team's primary unresolved capability. Real
support tickets routinely require an operator to reproduce the
agency's view: "I can't see my booking", "pricing looks wrong on this
hotel", "the document is missing". Operators today work blind, asking
the agency to take screenshots or relay details. Every alternative —
ad-hoc DB reads, shadow-account testing, account-credential sharing
— is worse than a designed impersonation flow on every dimension
(auditability, blast radius, legal exposure).

This ADR records the impersonation model that closes that gap. It is
deliberately **read-only**, deliberately **single-account at a time**,
deliberately **DB-bound** rather than token-bound, and deliberately
**narrow in initial rollout**. Each of those choices removes a class
of abuse vector that a more permissive design would carry.

The locked rules below interact with several already-shipped pieces:

- ADR-026 D1 — "roles are DB-resolved, not token-resolved." Already
  obliges a per-request DB read in `PermissionResolverService`. This
  ADR adds one more indexed lookup to the same hot path.
- ADR-026 D8 — `IMPERSONATE_AGENCY_ACCOUNT` permission already exists
  in the catalogue, granted to `platform_admin` and `ops_support`.
- ADR-026 D11 — "single account per agency user." Mirrored here as
  "single un-ended impersonation grant per actor."
- E4-A guard pipeline — `JwtAuthGuard` runs before `RolesGuard`. This
  ADR slots impersonation resolution into `JwtAuthGuard` so
  `RolesGuard` continues to read the populated `AuthContext`
  unchanged.
- E4-B body reconciliation — depends on `AuthContext.userClass` and
  `AuthContext.accountId`. By having impersonation set userClass to
  `'AGENCY'` and accountId to the target's, every E4-B-style
  retrofitted endpoint accepts an impersonation session without
  per-endpoint changes.

The model below is design-locked. Implementation is the responsibility
of the impersonation slices that follow this ADR's acceptance.

## Decision

### D1. Read-only, V1; possibly forever

An active impersonation grant in V1 confers exactly the agency-side
**read** capability of the impersonated account's `account_admin`
role. No write capability. No exception, no escalation, no
override.

This is the most important property in this ADR. Stated three
ways for emphasis:

- The resolver, when an impersonation grant is active, returns a
  permission set computed as
  `(agency_permissions['account_admin']) ∩ READ`.
- Every existing write permission held by the operator's own
  operator-roles — `BOOKING_CANCEL_MANUAL`, `LEDGER_ADJUST`,
  `BOOKING_REFUND_MANUAL`, etc — is suspended for the duration of the
  grant. The operator does not gain agency-attributed write
  capability; they also temporarily lose their own operator-attributed
  write capability while the grant is active. To exercise an
  operator-attributed write they must `POST /impersonation/stop`
  first.
- Agency-attributed writes never come from operator hands.

Why "possibly forever": granting write capability while impersonating
introduces a dual-attribution audit problem (which identity took the
action?), a contractual disclosure problem (the agency's ToS may not
permit operator-as-agency writes), and a regulatory problem in the
finance-adjacent surfaces (a `LEDGER_ADJUST` performed under
impersonation muddies the books). The product cost of disallowing
write impersonation is low — operators can already perform every
write they need under their own operator-roles, with their own
audit trail. The marginal benefit of write impersonation is "fewer
clicks for the operator", which is not worth the four risks above.

### D2. Subjects: who may impersonate whom

V1 subjects are tightly constrained. The constraint set is
schema-level (CHECK + FK + index) plus application-level (rejection
in the start endpoint) plus permission-level
(`IMPERSONATE_AGENCY_ACCOUNT` is the gate).

**Permitted:**

- Actor: any **OPERATOR** user holding `IMPERSONATE_AGENCY_ACCOUNT`.
  Today: `platform_admin` and `ops_support`.
- Target: any **AGENCY** account in the actor's tenant.

**Forbidden, locked:**

- Operator-impersonating-operator. No support case; pure abuse vector.
  Schema-level: target is FK to `core_account` with a runtime check
  that the account's `account_type = 'AGENCY'`.
- Agency-impersonating-anyone. AGENCY users do not hold
  `IMPERSONATE_AGENCY_ACCOUNT` per the role matrix and cannot
  acquire it without an ADR amendment.
- Operator-impersonating-themselves. Degenerate; the start endpoint
  rejects.
- Cross-tenant impersonation. V1 is single-tenant; the constraint
  forward-loads multi-tenant. The start endpoint rejects when
  `target_account.tenant_id != actor.tenant_id`.
- Reseller-as-sub-reseller, account-as-sub-account, any account-tree
  flavour of impersonation. None are needed for V1 support; all
  introduce permission-tree complexity that has no current use.

**Forward-loaded for V1.x (not blocking V1.0):**

- Compliance-hold gate. Accounts flagged with an open compliance
  hold may be undelegatable (operators cannot impersonate them
  because the hold itself blocks all third-party access). The hold
  flag does not exist yet; the start endpoint will gain a check
  when it does.

### D3. Session shape: DB-bound

An impersonation **session** is a row in `impersonation_grant`. The
session is identified to the resolver by the actor (operator
`core_user.id`); the resolver looks for an active row on every
request. Token-encoded `act` claims (RFC 8693) are explicitly NOT
used.

Rationale for DB-bound:

- ADR-026 D1 already mandates a per-request DB read in the resolver.
  The impersonation lookup folds into that path with one additional
  indexed query (or one LEFT JOIN). The latency budget is already
  spent.
- Stop has zero token-rotation latency. A `POST /impersonation/stop`
  marks the row `ended_at = now()`; the next request resolves as
  operator-self again. A token-encoded session would either need a
  short TTL with frequent re-mints or a server-side revocation list,
  both of which re-introduce a per-request DB read anyway.
- The grant row is the audit anchor. Every request during the grant
  references its `grantId`; the lifecycle log lives on the row.

### D4. Schema — `impersonation_grant`

```sql
CREATE TABLE impersonation_grant (
  id                 CHAR(26) PRIMARY KEY,
  tenant_id          CHAR(26) NOT NULL REFERENCES core_tenant(id),

  -- Actor: an operator user holding IMPERSONATE_AGENCY_ACCOUNT.
  actor_user_id      CHAR(26) NOT NULL REFERENCES core_user(id),

  -- Target: an AGENCY account in the same tenant.
  target_account_id  CHAR(26) NOT NULL REFERENCES core_account(id),

  -- Why. ticket_ref required in V1; see D5.
  reason_text        TEXT     NOT NULL,
  ticket_ref         VARCHAR(100) NOT NULL,

  -- Capability scope. V1: only 'READ_ONLY'.
  scope              VARCHAR(16) NOT NULL,

  -- Lifecycle.
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  ended_reason       VARCHAR(32),

  -- Provenance. Captured at start; not updated.
  ip_address         INET,
  user_agent         TEXT,

  CONSTRAINT impersonation_grant_scope_chk
    CHECK (scope IN ('READ_ONLY')),

  CONSTRAINT impersonation_grant_lifecycle_chk
    CHECK (ended_at IS NULL OR ended_at >= started_at),

  CONSTRAINT impersonation_grant_window_chk
    CHECK (expires_at > started_at),

  CONSTRAINT impersonation_grant_ended_reason_chk
    CHECK (
      (ended_at IS NULL AND ended_reason IS NULL)
      OR (ended_at IS NOT NULL AND ended_reason IN
          ('OPERATOR_ENDED', 'EXPIRED', 'ADMIN_REVOKED'))
    )
);

-- One un-ended grant per actor; the schema is the authority.
CREATE UNIQUE INDEX impersonation_grant_actor_active_uq
  ON impersonation_grant (actor_user_id) WHERE ended_at IS NULL;

-- Per-actor lookup of active grant on every request — hot path.
CREATE INDEX impersonation_grant_actor_lookup_idx
  ON impersonation_grant (actor_user_id, ended_at, expires_at);

-- Audit / admin views by target.
CREATE INDEX impersonation_grant_target_idx
  ON impersonation_grant (target_account_id, started_at DESC);
```

Tenant-coherence (the target account belongs to the actor's tenant)
is application-enforced at the start endpoint; the FK to
`core_account` does not encode tenant identity.

The `ended_reason` CHECK enforces that `(ended_at, ended_reason)`
move together. A row with `ended_at` set must name a reason from the
fixed enum.

Rows are NEVER deleted. End is always `UPDATE ... SET ended_at,
ended_reason`. Retention aligns with platform audit retention (see
D9).

### D5. `ticket_ref` is REQUIRED in V1

The `ticket_ref` column is `NOT NULL` and rejected when empty by the
start endpoint. V1 support workflow assumes every impersonation
session is tied to a specific support ticket. Reasons:

- **Audit traceability.** The single most important question after
  an impersonation incident is "why was this account viewed?"
  Free-text `reason_text` rots quickly; a structured ticket ref ties
  the grant to the support system of record where the reason is
  durably captured.
- **Abuse deterrence.** Requiring a ticket ref forces the operator
  to either (a) have a real ticket (good), or (b) fabricate one,
  which is itself an audit-detectable anomaly (no matching ticket
  in the support system).
- **Cross-system correlation.** Future ops dashboards can join
  `impersonation_grant.ticket_ref` against the support system to
  produce a "tickets with impersonation activity" view.

The format of `ticket_ref` is intentionally not constrained by this
ADR (no regex CHECK). Different support tooling produces different
ID shapes (`SUP-12345`, `JIRA-ABC-9`, opaque UUIDs), and locking the
shape here would either over-constrain or be permissive enough to
be useless. Validation, if any, lives in the start endpoint and can
be adjusted without an ADR amendment.

The "very strong reason not to require it" exception requires a
follow-up ADR amendment if it ever arises. None is anticipated for
V1.

### D6. AuthContext shape extension

`AuthContext` gains one optional field. No existing field changes
its meaning. Existing controllers do not need to read the new
field; they continue to read `userClass`, `tenantId`, `accountId` as
today, and impersonation reshapes those values transparently.

```ts
interface AuthContext {
  // Unchanged from E2-A.
  readonly auth0Sub: string;        // operator's sub during impersonation
  readonly userId: string;          // operator's core_user.id during impersonation
  readonly tenantId: string;        // = target.tenant_id during impersonation
  readonly accountId: string | null;// = target.account_id during impersonation
  readonly userClass: 'OPERATOR' | 'AGENCY'; // = 'AGENCY' during impersonation

  // New in this ADR. Present iff a grant is active.
  readonly impersonation?: {
    readonly grantId: string;
    readonly actorUserId: string;
    readonly actorAuth0Sub: string;
    readonly actorUserClass: 'OPERATOR';
    readonly expiresAt: string;
    readonly scope: 'READ_ONLY';
  };
}
```

The userClass flip is what makes E4-A and E4-B work unchanged. An
impersonated operator looks like an AGENCY user to every retrofitted
endpoint; reconciliation accepts the synthetic accountId; writes
get filtered out at permission resolution.

The `auth0Sub` and `userId` fields stay the operator's so audit
trails attribute the request to the human who initiated it. The
`actorUserId` field on the impersonation block is therefore
redundant with `userId` during a grant — it exists so audit code
can read the actor uniformly without branching on
`impersonation === undefined`.

### D7. Guard / resolver wiring

Only two existing components change. No new guard, no new decorator.

**`JwtAuthGuard` (one new step, after user sync):**

1. Validate JWT, sync user (existing).
2. **New:** if the synced user is an OPERATOR, look up their active
   impersonation grant via `ImpersonationGrantRepository
   .findActiveByActor`.
3. If a grant is found and unexpired, build the AuthContext as
   AGENCY-shaped with the `impersonation` block set.
4. Otherwise, build the operator-self AuthContext as today.

The validator and JWKS layer are untouched. AGENCY users do not
trigger the lookup (they cannot have an active grant per D2).

**`PermissionResolverService` (one new branch):**

When `auth.impersonation` is present:

1. Bypass `findActiveRolesForUser` for the operator. Their
   operator-roles are irrelevant for this request.
2. Set the resolved role list to `['account_admin']` synthetically —
   for return-shape continuity. Downstream code that reads
   `resolved.roles` sees a single, stable answer.
3. Compute permissions as `(agency_permissions['account_admin']) ∩
   READ`, where `READ` is determined by the new `PERMISSION_KIND`
   map (D8).
4. Continue to enforce membership/account-id coherence — but against
   the **target** account, derived from the grant. The actor's own
   `user_account_membership` rows are not consulted (operators have
   none anyway).

**`RolesGuard` is unchanged.** It still calls `resolver.resolve(auth)`
and checks each `@RequirePermission`. The impersonation filtering
happens inside the resolver, so the guard sees a smaller set
automatically.

**Default-deny is preserved by construction.** A write endpoint
declares e.g. `@RequirePermission(BOOKING_CANCEL_OWN_WITHIN_POLICY)`.
During impersonation, that permission has been filtered out of the
resolved set → `RolesGuard` 403s. The endpoint never executes. No
code path can accidentally let a write through during impersonation,
because the deny happens at the resolver level — before the
controller.

### D8. `PERMISSION_KIND` map — load-bearing primitive

A new static map sits next to the catalogue:

```ts
export const PERMISSION_KIND: Readonly<Record<Permission, 'READ' | 'WRITE'>> = {
  [PERMISSIONS.BOOKING_READ]:                          'READ',
  [PERMISSIONS.BOOKING_READ_OWN]:                      'READ',
  [PERMISSIONS.BOOKING_READ_ACCOUNT]:                  'READ',
  [PERMISSIONS.BOOKING_CANCEL_MANUAL]:                 'WRITE',
  [PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY]:      'WRITE',
  // ... every permission tagged exactly once
} satisfies Record<Permission, 'READ' | 'WRITE'>;
```

The `satisfies` clause is load-bearing: adding a permission to the
catalogue without also adding its kind is a TS error at the
`PERMISSION_KIND` declaration. This forecloses the silent-write-
during-impersonation failure mode at compile time, not at code
review.

**Classifications locked in V1:**

| Permission | Kind | Notes |
|---|---|---|
| `*_READ`, `*_READ_OWN`, `*_READ_ACCOUNT`, `AUDIT_READ`, `RESELLER_PROFILE_READ`, `BOOKING_READ_FULL_PRICING_TRACE`, `BOOKING_READ_FX_PROVENANCE`, `LEDGER_READ`, `LEDGER_READ_ACCOUNT`, `STATEMENTS_DOWNLOAD`, `DOCUMENTS_VIEW_TAX`, `DOCUMENTS_DOWNLOAD_OWN`, `DOCUMENTS_DOWNLOAD_ACCOUNT`, `MAPPING_QUEUE_READ`, `PRICING_RULE_READ`, `SUPPLIER_CONFIG_READ`, `ACCOUNT_READ` | READ | Read endpoints. |
| `BOOKING_CREATE`, `BOOKING_CANCEL_*`, `BOOKING_REFUND_*`, `BOOKING_CONFIRM_MANUAL`, `BOOKING_ELIGIBILITY_OVERRIDE`, `LEDGER_ADJUST`, `PRICING_RULE_EDIT`, `SUPPLIER_CONFIG_EDIT`, `MAPPING_DECISION_WRITE`, `ACCOUNT_EDIT`, `ACCOUNT_SETTINGS_EDIT`, `RESELLER_PROFILE_EDIT`, `USERS_MANAGE`, `API_KEYS_MANAGE`, `USER_ROLE_GRANT`, `DOCUMENTS_REISSUE`, `IMPERSONATE_AGENCY_ACCOUNT` | WRITE | Mutating or credential-minting actions. |
| `SEARCH_EXECUTE` | READ | **Acknowledged risk.** Search executes pricing logic and may hit suppliers (incurring rate-limit / billing pressure). The legitimate support case is exactly "show me what the agency saw" — classifying as WRITE would defeat the entire point of impersonation. Mitigations live in D11 and Open items. |

Mis-classifying a write as a read is a contract bug. Reviewers of any
diff that touches `PERMISSION_KIND` should treat the change with the
same scrutiny as a permission grant.

### D9. Audit obligations

Three layers, each non-skippable.

**Layer 1 — lifecycle audit on the grant itself.** Every state
transition of `impersonation_grant` produces an entry in the
platform's append-only audit log:

| Event | Trigger | Required fields |
|---|---|---|
| `IMPERSONATION_STARTED` | row insert | actor_user_id, target_account_id, reason_text, ticket_ref, scope, expires_at, ip_address, user_agent |
| `IMPERSONATION_ENDED` | row update where `ended_at` transitions from NULL | grant_id, ended_reason ∈ {OPERATOR_ENDED, EXPIRED, ADMIN_REVOKED}, end timestamp |
| `IMPERSONATION_START_REJECTED` | start endpoint denies | actor_user_id, attempted target_account_id, rejection_reason ∈ {ACTOR_LACKS_PERMISSION, TARGET_NOT_AGENCY, TARGET_DIFFERENT_TENANT, ACTIVE_GRANT_EXISTS, TARGET_SELF, TICKET_REF_MISSING, REASON_TEXT_MISSING}, ip_address, user_agent |

Failed starts are as audit-relevant as successful ones. An attacker
probing impersonation against accounts they should not have access
to leaves a trail in the rejection log.

**Layer 2 — per-request annotation.** Every authenticated request
made during an active grant carries the `grantId` into:

- The structured logger MDC for the request's lifetime.
- The HTTP access log line.
- Every audit log entry the request itself produces (e.g.
  `BOOKING_VIEWED` when the operator hits a booking detail
  endpoint).

Worded contract: **no request made during an active grant may be
invisible from the grant's audit trail.** A retrofit slice that
adds a new endpoint and forgets to propagate `grantId` into its own
audit emissions is a breach of this contract and should be caught
in code review.

**Layer 3 — sensitive-access secondary audit.** Initially: tax
documents, ledger views, and PII-rich passenger details. A
successful read of any of these during a grant produces an
additional row in `impersonation_sensitive_access` keyed to the
grant. The list of "sensitive" surfaces is itself a forward-loaded
design item — the list lives next to the `PERMISSION_KIND` map and
is ADR-amendable, not free-form.

This third layer is **not blocking V1.0**. The grant id is in the
structured log per Layer 2; the sensitive-access table can be added
in V1.1 with no schema change to `impersonation_grant`.

**Append-only audit log is a precondition.** The audit table
itself must be INSERT-only at the database role level — even
`platform_admin`'s connection cannot UPDATE or DELETE. This is the
responsibility of the audit-log infrastructure ADR (forthcoming).
ADR-027 V1.0 must not ship before that ADR is accepted and its
INSERT-only invariant is enforced. See Open items.

### D10. API surface

Five HTTP endpoints. All five live under the same controller. All
five sit behind `JwtAuthGuard` + `RolesGuard` per the E4-A pattern.

**`POST /impersonation/start`** — operator-only.

- Permission: `IMPERSONATE_AGENCY_ACCOUNT`.
- Body: `{ targetAccountId, reasonText, ticketRef }`. All three
  required (`ticketRef` per D5).
- Reconciliation: D2 subject rules. The actor must be OPERATOR; the
  target must be AGENCY in the actor's tenant; the target must not
  be the actor's own account (degenerate); no active grant may
  exist for the actor.
- Side effects: insert `impersonation_grant` row with
  `expires_at = now() + DEFAULT_TTL`, scope `'READ_ONLY'`, captured
  IP and UA. Emit `IMPERSONATION_STARTED`.
- Response: 201 with `{ grantId, expiresAt, target: { accountId,
  accountName } }`.
- Error mapping: 403 for permission failure or subject violation,
  409 for `ACTIVE_GRANT_EXISTS`, 400 for body validation failure
  (`ticket_ref` empty, etc).

**`POST /impersonation/stop`** — operator-only.

- Permission: `IMPERSONATE_AGENCY_ACCOUNT`.
- Body: empty.
- Idempotent. If an active grant exists for the actor, end it with
  `ended_reason = 'OPERATOR_ENDED'`. If none exists, return 200
  with no-op body.
- Response: 200 with `{ ended: boolean }`.

**`GET /impersonation/active`** — operator-only.

- Permission: `IMPERSONATE_AGENCY_ACCOUNT`.
- Returns the actor's own active grant (if any) for UI banner
  state. `null` when none.

**`GET /admin/impersonation/grants`** — admin oversight.

- Permission: future `audit.read` or equivalent (V1: `AUDIT_READ`).
- Paginated listing, default sort `started_at DESC`.
- Filters: by actor, target account, time range, ended_reason.

**`POST /admin/impersonation/grants/:id/revoke`** — admin revoke.

- Permission: `platform_admin`-only initially (or a future
  `security_ops` role); enforced by a dedicated permission whose
  catalogue add is part of this slice's implementation.
- Ends the grant with `ended_reason = 'ADMIN_REVOKED'`. Idempotent
  on already-ended grants (200, no-op).
- Phase: V1.1 (see D14). V1.0 ships with stop = operator or
  expiry only.

`/me` augmentation:

- The existing `GET /me` response gains an optional `impersonation`
  field mirroring `AuthContext.impersonation`. UIs use this to
  decide whether to render the banner.

### D11. UI architectural requirement — persistent banner

When the session has an active impersonation grant, every operator-
facing UI page MUST render a non-dismissable, high-contrast banner:

> You are impersonating **\<Account Name\>** on ticket
> **\<Ticket Ref\>**. Session ends in \<countdown\>. **End
> impersonation**.

This is an **architectural requirement**, not a UI nice-to-have.
The risk model assumes the operator knows they are impersonating —
without the banner, an operator could attempt a write thinking
they are themselves, get a 403, and have no idea why. The banner
must be implemented at the layout level, conditional on
`AuthContext.impersonation`, not buried in a per-page component.

The countdown is desirable but optional in V1.0; the account name
and ticket ref are mandatory.

### D12. Locked non-features

The following are forbidden in V1 and are not added by future
slices without an ADR amendment:

- **Write-capable impersonation.** Out of scope, possibly forever.
- **Cross-tenant impersonation.** The actor's tenant must equal
  the target account's tenant.
- **Multiple parallel grants per actor.** One un-ended grant
  per actor; new starts must end the previous explicitly.
- **Operator-impersonating-operator.** No support case.
- **Agency-impersonating-anyone.** AGENCY users do not hold
  `IMPERSONATE_AGENCY_ACCOUNT`.
- **Agency-as-itself impersonation.** Conceptually nonsensical;
  excluded for completeness.
- **Reduction of the agency's actual permissions during a grant.**
  The agency's own users continue to have their normal access.
  Impersonation is overlaid; it is not exclusive lock.
- **Bulk-impersonation tools.** The actor cannot enumerate or
  iterate accounts via impersonation; one explicit start per
  target. Bulk operator visibility belongs in operator-side
  read endpoints (D13), not in the impersonation surface.
- **Role-scoped impersonation in V1.** The grant always confers
  `account_admin`'s read view. Per-grant role selection is a V2
  concern if it is ever needed.

### D13. Initial rollout — DELIBERATELY narrow

V1.0 rollout is **explicitly narrow**, not "any read endpoint
automatically." The retrofit pattern (E4-A / E4-B) makes
impersonation work on any guarded endpoint by definition; that
property must be balanced against the risk that a newly retrofitted
endpoint becomes impersonation-visible without explicit review.

**V1.0 impersonation-visible surfaces:**

1. **Search.** `POST /search`. Already retrofitted. Operator can
   see the agency's pricing view.
2. **Booking read surfaces.** Once the booking-read endpoints are
   retrofitted (slice E5 or its successor), they become
   impersonation-visible. Specific endpoints in scope:
   `GET /bookings`, `GET /bookings/:id`, `GET /bookings/:id/timeline`
   if it exists. Lists and detail views.
3. **Document read surfaces.** Once retrofitted (same slice or
   adjacent): `GET /bookings/:id/documents`, the document-download
   endpoints. Read-only document access for support — operators
   need to see what document an agency was emailed.

**Explicitly NOT impersonation-visible in V1.0**, even when the
retrofit makes them technically possible:

- Ledger views. `LEDGER_READ_ACCOUNT` is in the agency role's READ
  set; classifying it READ-only is correct for the catalogue, but
  ledger visibility carries direct financial-account information
  that warrants its own review before it becomes a support tool.
  V1.x extension after a deliberate slice review.
- Statement downloads. Same reasoning; statements expose monthly
  agency-side P&L lines.
- Reseller profile read. Branding / billing detail; surface review
  pending.
- Any endpoint that exposes a third-party's data inside the agency
  (e.g. supplier-side ratesheets reflected back). Out of scope
  V1.0.

Mechanism for the narrow rollout: a deny-list overlay on top of
the resolver-filtered permission set. The resolver computes
`(account_admin) ∩ READ` and then subtracts the
`IMPERSONATION_DENY_INITIAL` set:

```ts
const IMPERSONATION_DENY_INITIAL: ReadonlySet<Permission> = new Set([
  PERMISSIONS.LEDGER_READ_ACCOUNT,
  PERMISSIONS.STATEMENTS_DOWNLOAD,
  PERMISSIONS.RESELLER_PROFILE_READ,
  // future: any other initially-witheld READ permission
]);
```

The `IMPERSONATION_DENY_INITIAL` set is not a deny-list against
agencies — it only restricts the impersonation overlay. Agency
users using their own credentials retain full normal access to
these surfaces. This list shrinks over time as deliberate slice
reviews remove items from it.

The list is locked here; subsequent slices cannot add to it
silently, and removals require an ADR amendment.

### D14. Phased delivery

**V1.0 — minimum viable impersonation.** Ships:

1. `impersonation_grant` migration.
2. `PERMISSION_KIND` map.
3. `IMPERSONATION_DENY_INITIAL` deny-list overlay.
4. `ImpersonationGrantRepository`.
5. `JwtAuthGuard` integration.
6. `PermissionResolverService` impersonation branch.
7. `ImpersonationController` — `start`, `stop`, `active`.
8. Audit emission for `STARTED`, `ENDED`, `START_REJECTED`.
9. `/me` augmentation.
10. Tests at three layers (repository, resolver-with-impersonation,
    controller HTTP).
11. UI banner integration in the operator UI (when the operator UI
    exists; until then, the API contract is in place).

V1.0 confers the operator support workflow on the surfaces in D13.

**V1.1 — admin oversight.** Adds:

- `GET /admin/impersonation/grants` listing.
- `POST /admin/impersonation/grants/:id/revoke`.
- The `impersonation_sensitive_access` table (Layer 3 audit).

**V1.x — broadening.** As specific deny-list items get reviewed
and removed:

- Ledger read for support cases.
- Statement download for finance disputes.
- Etc. Each removal is an ADR amendment.

**V2 — only if needed.** Write-capable impersonation. Would require
an entirely separate audit story (dual-attribution semantics), a
contractual disclosure update, and a fresh ADR.

## Consequences

- **No new auth architecture.** Existing controllers do not change.
  E4-A guard pattern and E4-B reconciliation pattern keep working
  unchanged. The retrofit checklist in
  `docs/architecture/auth-endpoint-retrofit-pattern.md` does not
  need a new section — impersonation is invisible to a controller
  author beyond classifying their endpoint's permissions.
- **One additional DB query per authenticated request** for OPERATOR
  users. Folds into the existing per-request DB read in
  `PermissionResolverService` (one LEFT JOIN to
  `impersonation_grant` on `actor_user_id = $userId AND ended_at
  IS NULL AND expires_at > now()`). AGENCY users incur no overhead.
- **`PERMISSION_KIND` becomes a load-bearing primitive.** Adding a
  permission requires also classifying its kind, by TS compiler
  enforcement. Mis-classification is a contract bug detectable in
  diff review.
- **Default-deny extends naturally.** Write endpoints during
  impersonation deny via the resolver, before the handler. No
  per-endpoint guard logic is needed.
- **Audit retention costs.** `impersonation_grant` rows are tiny,
  permanent (we set `ended_at`, never DELETE). Per-request
  annotations live wherever the access log lives. Net storage
  cost: negligible.
- **Operator workflow change.** Operators now have a deliberate
  context-switch step (`start` / `stop`). The product cost is one
  round-trip per support session. The benefit is a clear audit
  boundary on every account view.
- **Banner is mandatory UI work.** The operator UI must implement
  the persistent banner before any operator UI ships impersonation
  controls. There is no "we'll add the banner later" option.
- **No agency-side impact at launch.** Agency users' own access is
  unchanged. The agency's audit log gains a record that an
  operator viewed their account during a support window — that is
  the intended visibility, disclosed contractually (Open items).

## Open items

- **Contractual disclosure to agencies.** The agency's service
  agreement / ToS must state that operator support staff may view
  account data when investigating tickets. Legal review must
  confirm the wording before V1.0 ships. If the disclosure cannot
  be made in V1.0 timeframe, V1.0 either delays (preferred) or
  ships with the deny-list narrowed further to remove anything
  PII-rich.
- **Append-only audit-log infrastructure ADR.** D9 Layer 1 requires
  an INSERT-only audit table at the DB role level — even
  `platform_admin`'s connection cannot UPDATE or DELETE. This
  invariant is the responsibility of the audit-log infrastructure
  ADR, which has not yet been drafted. ADR-027 V1.0 must not ship
  before that ADR is accepted and its invariant is enforced. If
  the audit ADR lags, V1.0 either delays or ships with explicit
  acceptance of the residual risk (NOT recommended).
- **MFA step-up at impersonation start.** Desirable but parked. The
  operator's session token already required MFA at mint per
  ADR-026; requiring a fresh MFA challenge specifically at
  `POST /impersonation/start` is a stronger control but lives in
  the MFA-policy slice rather than this ADR. V1.0 ships without
  it; revisit when the MFA-policy slice lands.
- **`SEARCH_EXECUTE`-as-READ supplier-billing risk.** D8 classifies
  search as READ, accepting that an impersonation session could
  drive supplier-side rate-limit or billing pressure. Mitigations
  not blocking V1.0: per-grant search count instrumented in the
  audit annotation; rate-limit per grant if abuse is observed
  post-launch. If supplier billing terms make this materially
  costly (per-search pricing), the classification may need to flip
  to WRITE — in which case impersonation loses search and the
  feature is much less useful. Confirm with supplier-contract owner.
- **Default TTL value.** D3 implies 30 minutes; this is provisional.
  Locked range: `min 5, max 240` minutes. Default value resolved
  by ops / security review before V1.0 ships, exposed as
  `IMPERSONATION_DEFAULT_TTL_MINUTES`.
- **`impersonation_sensitive_access` schema (Layer 3 audit).**
  Table shape, retention, and which surfaces feed it are deferred
  to V1.1. The list itself is small (tax documents, ledger,
  passenger PII) but locking the schema before the audit-log ADR
  resolves would be premature.
- **Compliance-hold gate.** D2 forward-loads the gate; the hold
  flag does not exist on `core_account` yet. When it does, the
  start endpoint gains a check. No schema change to
  `impersonation_grant` required.
- **UI scope boundary.** ADR-027 mandates the banner but does not
  specify which specific operator UI(s) carry it. Resolved when
  the operator UI architecture is finalized.
- **`/admin/impersonation/grants` permission.** D10 marks this as
  `AUDIT_READ` provisionally. The audit-log infrastructure ADR may
  introduce a more specific `audit.read.impersonation` permission;
  this ADR is fine with either.
- **Banner countdown.** The countdown UI element is desirable in
  V1.0 but not mandatory. If product chooses to ship without it,
  account name + ticket ref + end button are still required.

## Implementation order

The following order is the smallest safe sequence to V1.0. Each
numbered step is its own slice; each slice ships independently.

1. **Migration** — `impersonation_grant` table + indexes + the
   FK to `core_account`. Includes a forward-compat `account_type`
   check at insert time (application-enforced).
2. **`PERMISSION_KIND` map** — exhaustively typed via `satisfies`,
   committed alongside the existing catalogue. Deny-list constant
   `IMPERSONATION_DENY_INITIAL` lives next to it.
3. **`ImpersonationGrantRepository`** — find-active-by-actor, insert,
   end. Same shape as `UserRoleRepository` (E3-A).
4. **`JwtAuthGuard` integration** — read active grant after user
   sync; rewrite AuthContext when one exists. Tests cover the
   AGENCY-shape rewrite, the lapsed-grant cleanup, and the
   no-grant pass-through.
5. **`PermissionResolverService` branch** — return
   `(account_admin) ∩ READ ∖ IMPERSONATION_DENY_INITIAL` when the
   AuthContext carries an impersonation block. Tests cover the
   filtering, the deny-list overlay, and the fall-through to the
   normal path when no grant is present.
6. **`ImpersonationController`** — `start`, `stop`, `active`.
   Subject reconciliation in `start`. Audit emission for STARTED,
   ENDED, START_REJECTED.
7. **`/me` augmentation** — return the impersonation block when
   present.
8. **Operator UI banner** — depends on the operator UI shipping;
   API contract is in place independently.
9. **V1.1 — admin views and revoke** — listing endpoint and
   admin-revoke endpoint. `impersonation_sensitive_access`
   table per Layer 3.
10. **V1.x deny-list shrinks** — deliberate slice reviews remove
    individual surfaces (ledger, statements, reseller profile) as
    the support workflow matures.

V2 (write-capable) is out of scope and likely never; if it is ever
revisited, it requires its own ADR.
