# ADR-026: Identity, role, and permission model

- **Status:** Accepted (back-written 2026-05-09; implemented across slices
  E1, E2-A, E2-B, E3-A, E4-A, E4-B)
- **Date:** 2026-05-08 (initial design); back-written 2026-05-09
- **Supersedes:** nothing
- **Amends:** ADR-006 (adds `core_user`, `user_role`,
  `user_account_membership` to the tenancy model)
- **Depends on:** ADR-006 (tenancy + account model — `core_tenant`,
  `core_account`), ADR-007 (NestJS tech stack)
- **Required by:** ADR-027 (operator impersonation — depends on the
  `AuthContext` shape and the `IMPERSONATE_AGENCY_ACCOUNT` permission
  defined here), ADR-028 (audit infrastructure — depends on `AuthContext`
  correlation and the role-grant audit events defined here)

## Context

The platform serves two human user classes — operator team members
(Beyond Borders staff) and agency users (employees of B2B travel agency
accounts). Both reach the same NestJS API but with different scope,
capabilities, and trust levels.

Auth0 is the chosen identity provider. Auth0 handles credential storage,
MFA, session management, and password flows. The platform stores nothing
credential-related. The design challenge is cleanly separating:

1. **Identity verification** — is this token from Auth0, valid, and
   unexpired? Auth0's public JWKS is the oracle.
2. **Role and permission assignment** — what is this identity allowed to
   do on this platform? The platform's own DB is the oracle.

Splitting these lets the platform revoke a role or change a permission
without waiting for an access token to expire. It also lets the platform
enforce multi-tenant isolation and account-scope constraints that Auth0
has no awareness of.

The platform also separates human-user authentication from
service-to-service authentication. `/internal/*` routes are an internal
API key seam protected by `InternalAuthGuard`; this ADR does not touch
them.

## Decision

### D1. Identity lives in Auth0; roles and scope live in the DB

Auth0 is the canonical identity store. The platform does not store
credentials, passwords, or MFA state. When a user authenticates with
Auth0, Auth0 mints a JWT access token containing:

- `sub` — stable Auth0 user ID, the canonical identity handle.
- `iss`, `aud`, `exp`, `nbf` — standard JWT claims validated by the
  platform.
- Three custom namespaced claims (namespace:
  `https://beyondborders.platform/claims/`):
  - `tenant_id` — the tenant this token was minted for.
  - `user_class` — `OPERATOR` or `AGENCY`.
  - `account_id` — the `core_account.id` this user is bound to.
    Present when `user_class === 'AGENCY'`; absent (must not be set)
    when `user_class === 'OPERATOR'`.

**Roles are not in the token.** The platform resolves roles and
permissions from `user_role` on every request. Token-cached roles
would survive a revocation until access token expiry — typically 24
hours. DB-resolved roles take effect within one query.

This creates an important contract: token validation proves *who the
caller is*; DB resolution proves *what they are allowed to do*.

### D2. `core_user` — the application-side identity mirror

`core_user` is the bridge between Auth0 and the platform DB:

```sql
CREATE TABLE core_user (
  id           CHAR(26)     NOT NULL,
  tenant_id    CHAR(26)     NOT NULL,
  auth0_sub    VARCHAR(255) NOT NULL,
  email        VARCHAR(320) NOT NULL,
  display_name VARCHAR(200),
  user_class   VARCHAR(16)  NOT NULL,   -- 'OPERATOR' | 'AGENCY'
  status       VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT core_user_pk          PRIMARY KEY (id),
  CONSTRAINT core_user_tenant_fk   FOREIGN KEY (tenant_id) REFERENCES core_tenant(id),
  CONSTRAINT core_user_auth0_sub_uq UNIQUE (auth0_sub),
  CONSTRAINT core_user_class_chk   CHECK (user_class IN ('OPERATOR', 'AGENCY')),
  CONSTRAINT core_user_status_chk  CHECK (status IN ('ACTIVE', 'DEACTIVATED'))
);
CREATE INDEX core_user_tenant_idx ON core_user (tenant_id);
CREATE UNIQUE INDEX core_user_email_per_tenant_uq ON core_user (tenant_id, lower(email));
```

`auth0_sub` is UNIQUE — one Auth0 identity maps to at most one
application user. `email` and `display_name` are denormalized mirrors
from Auth0 (refreshed by webhook events; see D9).

`status` is the application's view of the user. `DEACTIVATED` blocks
login even if Auth0 still allows it. Setting status is the application's
primary revocation action.

### D3. User classes — OPERATOR and AGENCY

`user_class` is a hard partitioning:

**OPERATOR** — a Beyond Borders staff member. Tenant-scoped, not
account-scoped. Has no `account_id` claim. Holds operator roles only.
Operator users represent internal employees: support, finance,
integrations, audit.

**AGENCY** — an employee of a B2B travel agency account. Account-scoped.
Carries an `account_id` in the JWT claim. Holds agency roles only.
Agency users are provisioned into exactly one account for V1 (D11).

Class coherence is enforced at write time (provisioning) and at read
time (resolver). A corrupted row that carries an operator role on an
AGENCY user is silently ignored by the resolver — the failure mode is
denial, not privilege escalation.

**API consumers** are not a user class. API keys are account-bound and
have their own scope semantics. They will be introduced in a future
Slice E7. This catalogue describes only roles that a `core_user` can
hold.

### D4. Role catalogue — operator roles

Operator roles are additive. A user holds one role in practice; the
design allows multiple for future "ops + auditor" combinations.

**`platform_admin`** — holds every permission in the catalogue.
There is no permission a platform admin cannot exercise. Any
"even platform_admin can't do X" requirement is a separation-of-duties
feature (out of scope for V1 — see D11); it is not modelled as a missing
permission.

**`ops_support`** — booking read (full trace + FX provenance),
manual booking confirm / cancel / refund, eligibility override, tax
document view, document reissue, ledger read, pricing rule read,
supplier config read, mapping queue read, account read + edit,
reseller profile read, audit read, and `IMPERSONATE_AGENCY_ACCOUNT`.

**`finance_ops`** — booking read (full trace + FX provenance), tax
document view, ledger read + adjust, pricing rule read + edit, account
read, reseller profile read, audit read.

**`integrations_ops`** — booking read (full trace + FX provenance),
supplier config read + edit, mapping queue read, mapping decision write,
audit read.

**`read_only_auditor`** — booking read (full trace + FX provenance),
tax document view, ledger read, pricing rule read, supplier config read,
mapping queue read, account read, reseller profile read, audit read.

### D5. Role catalogue — agency roles

Agency roles are scoped to the user's account. The permission names are
the same strings as operator permissions where both sides have the
concept (e.g. `booking.read`), but the endpoint is responsible for
applying the correct data-access scope — see D6.

**`account_admin`** — full agency-side access: search execute, booking
create, booking read (own + account), booking cancel (own + account
within policy), booking refund (own + account within policy), document
download (own + account), ledger read (account), statements download,
users manage, API keys manage, reseller profile read, account settings
edit.

**`booker`** — search execute, booking create, booking read (own
only), booking cancel (own within policy), booking refund (own within
policy), document download (own).

**`finance`** — search execute, booking read (account), document
download (account), ledger read (account), statements download.

`finance` holds `SEARCH_EXECUTE` because displaying account-level
booking data often requires re-querying the pricing context. It does not
hold `BOOKING_CREATE`, `BOOKING_CANCEL_*`, or `BOOKING_REFUND_*`.

### D6. Permission catalogue

Permissions are atomic strings declared as `PERMISSIONS.*` constants in
`apps/api/src/auth/permissions/permissions.ts`. The file is the single
source of truth; the roles in D4/D5 are expressed as `Set<Permission>`
maps in the same file so they are both the prose and the executable spec.

The canonical set at V1.0:

```
booking.read                       booking.read.full_pricing_trace
booking.read.fx_provenance         booking.confirm.manual
booking.cancel.manual              booking.refund.manual
booking.eligibility.override       booking.create
booking.read.own                   booking.read.account
booking.cancel.own_within_policy   booking.cancel.account_within_policy
booking.refund.own_within_policy   booking.refund.account_within_policy
documents.view_tax                 documents.reissue
documents.download.own             documents.download.account
ledger.read                        ledger.adjust
ledger.read.account                statements.download
pricing.rule.read                  pricing.rule.edit
supplier.config.read               supplier.config.edit
mapping.queue.read                 mapping.decision.write
account.read                       account.edit
account.settings.edit              reseller.profile.read
reseller.profile.edit              search.execute
users.manage                       api_keys.manage
user.role.grant                    audit.read
impersonate.agency_account
```

**Scope is an endpoint concern, not a permission concern.** A permission
grants the *ability*; the endpoint enforces the *visibility*. For
example, `booking.read` means "tenant-wide" for an operator and
"account-wide" for an `account_admin` — but the permission string is the
same. The endpoint checks `auth.userClass` and scopes its query
accordingly. This means permission names are stable even when the
data-scope model changes for one class.

**AND semantics.** `@RequirePermission(A, B)` means the caller must hold
both A and B. OR semantics are not supported in V1 and are deferred.

### D7. `AuthContext` — the session object

`AuthContext` is the typed object attached to every authenticated
request. It is populated by `JwtAuthGuard` and read by `RolesGuard`,
controller handlers, and the `@Auth()` decorator:

```ts
interface AuthContext {
  readonly auth0Sub: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly accountId: string | null;  // null for OPERATOR users
  readonly userClass: 'OPERATOR' | 'AGENCY';
}
```

**Roles are NOT on `AuthContext`.** Permission checks resolve roles
fresh from the DB via `PermissionResolverService`. Putting roles on
`AuthContext` would create a caching surface that ages stale on
grant/revoke.

**`impersonation` is not on this object in V1.** ADR-027 adds an
optional `impersonation` field when a session is running under an
impersonation grant. That field is additive and does not change the base
shape.

`AuthContext` is stashed on the request using a private Symbol
(`AUTH_CONTEXT_KEY`) to prevent accidental inspection or mutation by
non-auth code.

### D8. Guard pipeline — `JwtAuthGuard` + `RolesGuard`

Every human-user endpoint (outside `/internal/*`) applies both guards
at the controller class level:

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('my-area')
export class MyController {
  @Post()
  @RequirePermission(PERMISSIONS.SOME_PERMISSION)
  async myHandler(...) { ... }
}
```

**Guard evaluation order matters.** NestJS evaluates guards in
declaration order. `JwtAuthGuard` runs first: it validates the bearer
token, resolves `core_user`, and attaches `AuthContext` to the request.
`RolesGuard` runs second: it reads `AuthContext`. Reversing the order
leaves `RolesGuard` with no `AuthContext` to read, causing it to return
403 with a log warning (`RolesGuard hit without AuthContext on request —
JwtAuthGuard missing or out of order`).

**`JwtAuthGuard` steps:**

1. Extract `Authorization: Bearer <token>` header. Missing → 401.
2. Parse the JWT as a 3-segment JWS.
3. Assert `alg === 'RS256'` (HS256 is rejected to prevent the RS-to-HS
   confusion attack where the JWKS is misused as a shared secret).
4. Fetch the signing key from JWKS cache by `kid`.
5. Verify RSA-SHA256 signature.
6. Validate standard claims: `iss` exact match, `aud` contains the
   API audience, `exp` not expired (±30 s clock skew), `nbf` if
   present.
7. Validate custom claims: `tenant_id` non-empty string; `user_class`
   in `{'OPERATOR', 'AGENCY'}`; `account_id` present and non-empty
   when `AGENCY`, absent when `OPERATOR`.
8. Call `UserSyncService.syncOnAuthentication`: find the `core_user`
   row for the `auth0Sub`. Outside bootstrap mode, a missing row is a
   hard 401 — never JIT-create.
9. Assert `core_user.status === 'ACTIVE'` and `core_user.tenant_id ===`
   token `tenant_id`. Mismatch → 401.
10. Attach `AuthContext` to the request.

All failure responses are uniform 401 with a generic body. The specific
reason is logged at WARN but never returned to the client — leaking
"expired" vs "wrong audience" vs "unprovisioned" gives an attacker
information they shouldn't have.

**`RolesGuard` steps:**

1. Read `AuthContext` from the request. If absent → 403 (logged as
   a misconfiguration).
2. Read the `@RequirePermission(...)` metadata from the handler (with
   class-level fallback). If no metadata → 403 (default-deny: an
   endpoint that opts into `RolesGuard` without declaring a required
   permission is a misconfiguration, not a public route).
3. Call `PermissionResolverService.resolve(auth)`:
   - Load active `user_role` grants from the DB.
   - For AGENCY users, load `user_account_membership` and assert
     `auth.accountId` matches the DB membership. Mismatch → no
     permissions (deny, not escalate).
   - Expand roles to permissions via `expandRolesToPermissions`,
     silently ignoring any cross-class role (corruption defense).
4. Assert the resolved permission set contains every required
   permission. Any missing → 403.

The 403 response body is uniform and carries no permission name.
The WARN log carries `userId`, `userClass`, and the failing permission
name so ops can triage.

**JWKS cache** maintains a short-lived (`JwksCacheService`) in-memory
map of `kid → KeyObject`. It re-fetches from Auth0's
`/.well-known/jwks.json` endpoint when a `kid` is not found and on a
configurable TTL. This prevents per-request JWKS round-trips while
handling Auth0 key rotations transparently.

### D9. User provisioning and the Auth0 webhook mirror

**Admin-driven provisioning (E2-B)** is the only supported path for
creating production users. `UserProvisioningService` creates the Auth0
user via the Management API (`POST /api/v2/users`) and then atomically
creates `core_user` + `user_role` grant(s) + `user_account_membership`
(for AGENCY users) in a DB transaction. If the DB transaction fails,
a compensating Auth0 user DELETE is issued. If the compensating DELETE
also fails, the failure is logged loudly for ops triage.

Auth0 is always the source of truth on credential state (password
resets, MFA factors, lockouts). The DB is the source of truth on role
and permission state.

**Auth0 webhook ingestion (E2-B)** keeps the `core_user` mirror fresh.
Auth0 Log Streams deliver events to `POST /webhooks/auth0`. The
controller verifies the HMAC-SHA256 signature over
`${timestamp}.${rawBody}` (shared webhook secret; replay window
enforced). The following event types are handled:

| Auth0 event type | Platform action |
|---|---|
| `sce` (email changed) | Update `core_user.email` |
| `scu` (email verified — treated as refresh) | Update `core_user.email` |
| `scn` (display name changed) | Update `core_user.display_name` |
| `sd` (user deleted) | Set `core_user.status = 'DEACTIVATED'` |
| `sapi` Block / Unblock | Toggle `status` (`DEACTIVATED` / `ACTIVE`) |

Unknown event types are ledger-only (idempotency record written,
no `core_user` mutation). Malformed entries in a batch are isolated;
the remaining entries process normally.

**Bootstrap path.** The very first `platform_admin` cannot be
provisioned through the normal admin-driven path (there is no admin yet
to provision them). `BootstrapPlatformAdminService` handles this: given
an `auth0Sub`, it idempotently creates or reactivates the `core_user`
row and issues the `platform_admin` role grant. Run once via CLI
(`apps/api/src/auth/bootstrap/bootstrap-platform-admin.ts`) against the
deployed stack. The `AUTH0_BOOTSTRAP_MODE=true` env var on the API
instance permits JIT `core_user` creation for exactly this first-login
case; it is set to `false` on all production deployments after the
bootstrap is complete.

**Idempotency ledger.** Every webhook event is recorded in
`auth0_event_ingestion` (keyed by Auth0's `log_id`) before the handler
runs. Duplicate deliveries from Auth0 are no-ops — the unique constraint
on `log_id` is the idempotency gate.

### D10. `user_role` and `user_account_membership` schema

```sql
CREATE TABLE user_role (
  id          CHAR(26)     NOT NULL,
  user_id     CHAR(26)     NOT NULL,
  role        VARCHAR(32)  NOT NULL,
  granted_by  CHAR(26),               -- NULL only for bootstrap platform_admin
  granted_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revoked_by  CHAR(26),
  revoked_at  TIMESTAMPTZ,
  CONSTRAINT user_role_pk         PRIMARY KEY (id),
  CONSTRAINT user_role_user_fk    FOREIGN KEY (user_id) REFERENCES core_user(id) ON DELETE CASCADE,
  CONSTRAINT user_role_grantor_fk FOREIGN KEY (granted_by) REFERENCES core_user(id),
  CONSTRAINT user_role_revoker_fk FOREIGN KEY (revoked_by) REFERENCES core_user(id),
  CONSTRAINT user_role_role_chk   CHECK (role IN (
    'platform_admin', 'ops_support', 'finance_ops', 'integrations_ops', 'read_only_auditor',
    'account_admin', 'booker', 'finance'
  )),
  CONSTRAINT user_role_revoke_chk CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX user_role_active_uq ON user_role (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX user_role_user_idx ON user_role (user_id);
CREATE INDEX user_role_role_active_idx ON user_role (role) WHERE revoked_at IS NULL;
```

Active grant = `revoked_at IS NULL`. Revoking sets both `revoked_at`
and `revoked_by` atomically — the partial unique constraint means
re-granting the same role after a revoke produces a new row while
preserving the history of the revoked row.

`granted_by IS NULL` is only legitimate for the bootstrap
`platform_admin` initial grant. Every other grant must carry a granter.
This invariant is enforced at the application layer; no SQL CHECK
forbids NULL because that would block the bootstrap path.

```sql
CREATE TABLE user_account_membership (
  id         CHAR(26)     NOT NULL,
  user_id    CHAR(26)     NOT NULL,
  account_id CHAR(26)     NOT NULL,
  status     VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uam_pk           PRIMARY KEY (id),
  CONSTRAINT uam_user_fk      FOREIGN KEY (user_id) REFERENCES core_user(id) ON DELETE CASCADE,
  CONSTRAINT uam_account_fk   FOREIGN KEY (account_id) REFERENCES core_account(id),
  CONSTRAINT uam_status_chk   CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT uam_one_per_user UNIQUE (user_id)
);
CREATE INDEX uam_account_idx ON user_account_membership (account_id);
```

The `UNIQUE (user_id)` constraint is the V1 lock (D11): each AGENCY
user belongs to exactly one account. Loosening this requires a
deliberate ADR amendment — it is not an inline relaxation.

OPERATOR users have zero membership rows. `PermissionResolverService`
skips the membership check for OPERATOR users.

### D11. Locked V1 constraints

The following design points are explicitly locked for V1. Loosening
any requires a named ADR amendment or a new ADR.

- **One account per agency user.** The `UNIQUE (user_id)` on
  `user_account_membership` is the enforcer. Multi-account AGENCY users
  (e.g. a consultant working across clients) are deferred.
- **JIT user creation is bootstrap-only.** In production
  (`AUTH0_BOOTSTRAP_MODE=false`), a token arriving for an unprovisioned
  user is a 401 and an ops WARN log. JIT creates outside bootstrap
  would blur the signal between "config mistake" and "test user."
- **Operator-as-self on account-scoped endpoints is forbidden.** OPERATOR
  users have no `accountId`. Any endpoint that is account-scoped and
  would otherwise be reachable by an operator role must deny the operator
  with a policy message pointing to impersonation (E8). This is enforced
  in the controller body, not in `RolesGuard`, because `platform_admin`
  holds every permission and would otherwise pass the guard check.
- **No separation-of-duties within `platform_admin`.** `platform_admin`
  holds all permissions. If future auditors or regulators require that
  no single human can both approve and execute a sensitive action, a
  separate separation-of-duties feature is needed. This ADR does not
  block that; it simply does not build it.
- **`@RequirePermission` multi-perm is AND only.** OR-style
  ("any of A, B") is not wired. The V1 role matrix does not need it.
- **`user.role.grant` is in the catalogue but no role-grant UI exists.**
  Role grants in V1 happen via the provisioning service (E2-B) and the
  bootstrap CLI. A self-service role-grant endpoint (E10) is deferred.

### D12. Identity-baseline route exception

`GET /me` uses only `@UseGuards(JwtAuthGuard)` — no `RolesGuard`, no
`@RequirePermission`. It returns the resolved `AuthContext`.

Rationale: `GET /me` is the auth probe. Its purpose is "confirm I am
authenticated and this is my identity." Gating it with a permission
would be circular — a user with no roles would get 403 from their very
first authenticated call and have no way to diagnose the problem. The
endpoint reveals nothing sensitive (no role list, no PII beyond what
the token already contains) and carries no mutation risk.

Every other human-user endpoint outside `/internal/*` gets the full
guard pattern.

### D13. Endpoint retrofit pattern

Adding auth to a new or existing endpoint follows a mechanical checklist:

1. `@UseGuards(JwtAuthGuard, RolesGuard)` at the controller class level.
2. `@RequirePermission(PERMISSIONS.X)` at the method level.
3. The controller's module imports `AuthModule`.
4. For endpoints that accept `tenantId` / `accountId` in the body: read
   them as optional and validate them against `AuthContext` in the
   handler body (D14 below).

The full runbook and Layer A + B + C test templates live in
`docs/architecture/auth-endpoint-retrofit-pattern.md`.

### D14. Body-vs-AuthContext reconciliation

Any endpoint that accepts `tenantId`, `accountId`, or any other
already-known-from-context identifier in its request body must reconcile
those against `AuthContext`. The locked V1 rule:

**AGENCY user:**
- Body fields `tenantId` and `accountId` are parsed as optional.
- If present, each must equal the corresponding `AuthContext` field.
  Mismatch → **403** (no detail body; reason logged at WARN).
- If absent, the `AuthContext` value is used.
- Defense-in-depth: if `auth.accountId` is null or empty-string for an
  AGENCY user, reject with 403 before any DB call.
- The service always receives the `AuthContext`-derived values, never
  the body values.

**OPERATOR user:**
- Account-scoped endpoints are unsupported as-self in V1. Return **403**
  with the message:
  `'Operator <action> requires impersonation; not supported in V1 (ADR-026 E8)'`
  This applies even when the operator holds the required permission
  (e.g. `platform_admin` holds `SEARCH_EXECUTE`). The impersonation
  flow (E8 / ADR-027) will synthesize an AGENCY-shaped `AuthContext`
  when it ships; that synthetic context passes through this gate
  unchanged.

**Failure is always 403, never 400.** A foreign `accountId` in a
well-formed body is an authorization concern — the fix is "use a
different identity," not "fix the body." Returning 400 misleads clients.

**The first retrofitted endpoint is `POST /search`.** It serves as the
canonical reference implementation for all future retrofits.

## Consequences

- **Every human-user endpoint requires explicit opt-in to the guard
  pipeline.** An endpoint that forgets `@UseGuards(JwtAuthGuard,
  RolesGuard)` is open to unauthenticated access. Mitigation: a
  metadata-pin test (`Reflect.getMetadata('__guards__', ...)`) is
  required for every controller as part of the Layer A test.
- **Every endpoint with `RolesGuard` requires `@RequirePermission`.**
  An endpoint that forgets the decorator returns 403 to all callers.
  The default-deny failure mode is intentionally loud — misconfiguration
  fails closed, not open.
- **One DB round-trip per request for permission resolution.**
  `PermissionResolverService` is not cached in V1. For AGENCY users
  this is two round-trips (roles + membership). A bounded in-process
  cache (keyed by `userId`, invalidated on role-grant or revocation) is
  a known follow-up optimization. It is deliberately deferred here:
  cache invalidation semantics interact with the role-grant audit trail
  in ways that belong in a separate slice.
- **JWT validation uses `node:crypto` directly, not a JWT library.**
  `jose` or `jsonwebtoken` would be cleaner but are not warranted for
  a single RS256 verifier. The tradeoff is acknowledged.
- **Bootstrap mode is a footgun.** `AUTH0_BOOTSTRAP_MODE=true` permits
  JIT user creation. The env var must be `false` on every non-bootstrap
  deployment. Ops runbook must document this explicitly.
- **Auth0 is a hard dependency.** If Auth0 is down, token validation
  fails for all users (JWKS fetches fail). The JWKS cache mitigates
  short outages; a prolonged Auth0 outage is an availability event.
  Offline-capable tokens (self-signed fallback) are deferred.
- **Webhook secret is a configuration concern.** `AUTH0_WEBHOOK_SECRET`
  absent from the environment causes the webhook controller to reject
  every delivery as unauthorized. This is intentional and loud — a
  misconfigured deployment cannot silently accept unauthenticated webhook
  bodies.
- **`AuthModule` must be imported by every module that gates a
  controller with `JwtAuthGuard` or `RolesGuard`.** Forgetting the
  import causes a Nest DI startup failure (`Nest can't resolve
  dependencies of JwtAuthGuard`). This is a CI-detectable failure.

## Open items (deferred slices)

- **E7 — API key issuance and authentication.** API keys are account-
  bound and have their own scope semantics. This ADR reserves the
  `api_keys.manage` permission; the schema, guard, and scope resolution
  land in E7.
- **E8 — Operator impersonation.** Defined in ADR-027. The
  `IMPERSONATE_AGENCY_ACCOUNT` permission and the
  `impersonation` optional field on `AuthContext` are the touch points
  in this ADR. Both are forward-loaded placeholders; E8 builds on them.
- **E10 — Role-grant UI / API.** The `user.role.grant` permission is in
  the catalogue. The self-service or admin-driven role-grant endpoint
  does not yet exist. All grants in V1 are made via the provisioning
  service (E2-B) or the bootstrap CLI.
- **Per-request permission cache.** `PermissionResolverService` hits the
  DB every request. An in-process cache keyed by `userId` with
  invalidation on role-grant / revoke events is a Phase 2 optimization.
  Tradeoff: cache staleness vs DB load. Defer until DB load is measured.
- **`AUDIT_READ_SENSITIVE` permission.** Introduced by ADR-028 D9 for
  access to the `SENSITIVE_ACCESS` audit category. Not yet in this
  catalogue. Lands as a small amendment in the ADR-028 implementation
  slice.
- **Separation-of-duties for `platform_admin`.** Not in scope for V1.
  If a future auditor requires that financial approval and execution
  cannot be held by the same person, this is a role-split feature that
  amends this ADR.
- **Multi-account AGENCY users.** The `UNIQUE (user_id)` constraint on
  `user_account_membership` is the V1 lock. Multi-account support
  requires a deliberate schema amendment, updates to `AuthContext`
  (which `accountId` is the active one?), and changes to the
  reconciliation logic in D14.

## Implementation order (historical)

- **E1 / E2-A** — Identity baseline: `JwtAuthGuard`, `JwtValidatorService`,
  `JwksCacheService`, `UserSyncService`, `CoreUserRepository`, `GET /me`.
  Migration: `core_user` + `auth0_event_ingestion`.
- **E3-A** — Permission infrastructure: `RolesGuard`,
  `PermissionResolverService`, `UserRoleRepository`,
  `UserAccountMembershipRepository`, `@RequirePermission`, `PERMISSIONS`
  catalogue. Migration: `user_role` + `user_account_membership`.
- **E2-B** — Admin provisioning: `Auth0ManagementTokenService`,
  `Auth0ManagementClient`, `UserProvisioningService`,
  `Auth0WebhookSignatureService`, `Auth0EventIngestionRepository`,
  `Auth0EventHandlerService`, `Auth0WebhookController`,
  `BootstrapPlatformAdminService` + CLI.
- **E4-A** — First endpoint retrofit: `SearchController`
  (`POST /search`) gated with the full guard pattern. Retrofit runbook
  documented in `docs/architecture/auth-endpoint-retrofit-pattern.md`.
- **E4-B** — Body-vs-AuthContext reconciliation: locked V1 rule
  implemented on `POST /search`; OPERATOR gate; defense-in-depth null
  check; reconciliation unit test layer (Layer C).
