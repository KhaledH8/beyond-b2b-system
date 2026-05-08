/**
 * ADR-026 Slice E3-A — permission catalogue and role-to-permission mapping.
 *
 * This file is the single source of truth for which roles hold which
 * permissions in V1. ADR-026 D8 is the prose reference; this code is
 * the executable form of that matrix.
 *
 * Operating principles (ADR-026):
 *
 *   - **Default deny.** Every endpoint declares its required permission
 *     via `@RequirePermission(...)`. An endpoint with no declaration
 *     is rejected by `RolesGuard` (rather than silently allowed).
 *
 *   - **Roles are DB-resolved, not token-resolved.** A token does not
 *     carry roles; the permission resolver fetches active grants from
 *     `user_role` on every check. A revoked grant takes effect within
 *     one query, not after access-token expiry.
 *
 *   - **Class coherence.** Operator users hold operator roles only;
 *     agency users hold agency roles only. Enforced at write-time by
 *     the future role-grant service (E2-B/E10). The resolver also
 *     filters roles by class as a defense-in-depth layer (a corrupted
 *     row that mismatches class is silently ignored — denied access,
 *     not granted).
 *
 *   - **`api_consumer` is not a user role.** API keys are
 *     account-bound, not user-bound (ADR-026 D3). When E7 ships, the
 *     `api_key` table will carry its own scope set; this catalogue
 *     describes only roles a `core_user` can hold.
 *
 *   - **Scope is an endpoint concern, not a permission concern.**
 *     `booking.read` for an operator returns tenant-wide; for an
 *     agency `account_admin` it returns account-wide; for a `booker`
 *     the matrix grants `booking.read.own` instead. The same name
 *     (`booking.read`) does NOT mean the same predicate — the
 *     endpoint is responsible for scoping its query against the
 *     caller's `AuthContext`. The permission grants the *ability*;
 *     the endpoint enforces the *visibility*.
 */

export const OPERATOR_ROLES = [
  'platform_admin',
  'ops_support',
  'finance_ops',
  'integrations_ops',
  'read_only_auditor',
] as const;

export const AGENCY_ROLES = [
  'account_admin',
  'booker',
  'finance',
] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];
export type AgencyRole = (typeof AGENCY_ROLES)[number];
export type Role = OperatorRole | AgencyRole;

const OPERATOR_ROLE_SET: ReadonlySet<string> = new Set(OPERATOR_ROLES);
const AGENCY_ROLE_SET: ReadonlySet<string> = new Set(AGENCY_ROLES);

export function isOperatorRole(role: string): role is OperatorRole {
  return OPERATOR_ROLE_SET.has(role);
}

export function isAgencyRole(role: string): role is AgencyRole {
  return AGENCY_ROLE_SET.has(role);
}

/**
 * Permissions are atomic strings. Each name is the canonical form
 * used in `@RequirePermission` decorators and audit log entries.
 *
 * The `as const` and `Permission` type below give us compile-time
 * autocompletion + a string-based runtime representation that is
 * cheap to compare and store.
 */
export const PERMISSIONS = {
  // ─── Booking — operator-side ───────────────────────────────────
  BOOKING_READ:                          'booking.read',
  BOOKING_READ_FULL_PRICING_TRACE:       'booking.read.full_pricing_trace',
  BOOKING_READ_FX_PROVENANCE:            'booking.read.fx_provenance',
  BOOKING_CONFIRM_MANUAL:                'booking.confirm.manual',
  BOOKING_CANCEL_MANUAL:                 'booking.cancel.manual',
  BOOKING_REFUND_MANUAL:                 'booking.refund.manual',
  BOOKING_ELIGIBILITY_OVERRIDE:          'booking.eligibility.override',

  // ─── Booking — agency-side ─────────────────────────────────────
  BOOKING_CREATE:                        'booking.create',
  BOOKING_READ_OWN:                      'booking.read.own',
  BOOKING_READ_ACCOUNT:                  'booking.read.account',
  BOOKING_CANCEL_OWN_WITHIN_POLICY:      'booking.cancel.own_within_policy',
  BOOKING_CANCEL_ACCOUNT_WITHIN_POLICY:  'booking.cancel.account_within_policy',
  BOOKING_REFUND_OWN_WITHIN_POLICY:      'booking.refund.own_within_policy',
  BOOKING_REFUND_ACCOUNT_WITHIN_POLICY:  'booking.refund.account_within_policy',

  // ─── Documents ─────────────────────────────────────────────────
  DOCUMENTS_VIEW_TAX:                    'documents.view_tax',
  DOCUMENTS_REISSUE:                     'documents.reissue',
  DOCUMENTS_DOWNLOAD_OWN:                'documents.download.own',
  DOCUMENTS_DOWNLOAD_ACCOUNT:            'documents.download.account',

  // ─── Ledger / finance ──────────────────────────────────────────
  LEDGER_READ:                           'ledger.read',
  LEDGER_ADJUST:                         'ledger.adjust',
  LEDGER_READ_ACCOUNT:                   'ledger.read.account',
  STATEMENTS_DOWNLOAD:                   'statements.download',

  // ─── Pricing ───────────────────────────────────────────────────
  PRICING_RULE_READ:                     'pricing.rule.read',
  PRICING_RULE_EDIT:                     'pricing.rule.edit',

  // ─── Supplier / mapping ────────────────────────────────────────
  SUPPLIER_CONFIG_READ:                  'supplier.config.read',
  SUPPLIER_CONFIG_EDIT:                  'supplier.config.edit',
  MAPPING_QUEUE_READ:                    'mapping.queue.read',
  MAPPING_DECISION_WRITE:                'mapping.decision.write',

  // ─── Account / reseller ────────────────────────────────────────
  ACCOUNT_READ:                          'account.read',
  ACCOUNT_EDIT:                          'account.edit',
  ACCOUNT_SETTINGS_EDIT:                 'account.settings.edit',
  RESELLER_PROFILE_READ:                 'reseller.profile.read',
  RESELLER_PROFILE_EDIT:                 'reseller.profile.edit',

  // ─── Search ────────────────────────────────────────────────────
  SEARCH_EXECUTE:                        'search.execute',

  // ─── User / API key management ─────────────────────────────────
  USERS_MANAGE:                          'users.manage',
  API_KEYS_MANAGE:                       'api_keys.manage',
  USER_ROLE_GRANT:                       'user.role.grant',

  // ─── Cross-cutting ─────────────────────────────────────────────
  AUDIT_READ:                            'audit.read',
  IMPERSONATE_AGENCY_ACCOUNT:            'impersonate.agency_account',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * Operator role → permission set (ADR-026 D8 operator-side matrix).
 *
 * `platform_admin` holds every permission: this is the locked rule
 * — there is no permission a platform admin cannot exercise. Any
 * "even platform_admin can't do this" requirement should be a
 * separation-of-duties feature (deferred per D11), not a missing
 * permission.
 */
const OPERATOR_PERMISSIONS: Record<OperatorRole, ReadonlySet<Permission>> = {
  platform_admin: new Set<Permission>(ALL_PERMISSIONS),

  ops_support: new Set<Permission>([
    PERMISSIONS.BOOKING_READ,
    PERMISSIONS.BOOKING_READ_FULL_PRICING_TRACE,
    PERMISSIONS.BOOKING_READ_FX_PROVENANCE,
    PERMISSIONS.BOOKING_CONFIRM_MANUAL,
    PERMISSIONS.BOOKING_CANCEL_MANUAL,
    PERMISSIONS.BOOKING_REFUND_MANUAL,
    PERMISSIONS.BOOKING_ELIGIBILITY_OVERRIDE,
    PERMISSIONS.DOCUMENTS_VIEW_TAX,
    PERMISSIONS.DOCUMENTS_REISSUE,
    PERMISSIONS.LEDGER_READ,
    PERMISSIONS.PRICING_RULE_READ,
    PERMISSIONS.SUPPLIER_CONFIG_READ,
    PERMISSIONS.MAPPING_QUEUE_READ,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.ACCOUNT_EDIT,
    PERMISSIONS.RESELLER_PROFILE_READ,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT,
  ]),

  finance_ops: new Set<Permission>([
    PERMISSIONS.BOOKING_READ,
    PERMISSIONS.BOOKING_READ_FULL_PRICING_TRACE,
    PERMISSIONS.BOOKING_READ_FX_PROVENANCE,
    PERMISSIONS.DOCUMENTS_VIEW_TAX,
    PERMISSIONS.LEDGER_READ,
    PERMISSIONS.LEDGER_ADJUST,
    PERMISSIONS.PRICING_RULE_READ,
    PERMISSIONS.PRICING_RULE_EDIT,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.RESELLER_PROFILE_READ,
    PERMISSIONS.AUDIT_READ,
  ]),

  integrations_ops: new Set<Permission>([
    PERMISSIONS.BOOKING_READ,
    PERMISSIONS.BOOKING_READ_FULL_PRICING_TRACE,
    PERMISSIONS.BOOKING_READ_FX_PROVENANCE,
    PERMISSIONS.SUPPLIER_CONFIG_READ,
    PERMISSIONS.SUPPLIER_CONFIG_EDIT,
    PERMISSIONS.MAPPING_QUEUE_READ,
    PERMISSIONS.MAPPING_DECISION_WRITE,
    PERMISSIONS.AUDIT_READ,
  ]),

  read_only_auditor: new Set<Permission>([
    PERMISSIONS.BOOKING_READ,
    PERMISSIONS.BOOKING_READ_FULL_PRICING_TRACE,
    PERMISSIONS.BOOKING_READ_FX_PROVENANCE,
    PERMISSIONS.DOCUMENTS_VIEW_TAX,
    PERMISSIONS.LEDGER_READ,
    PERMISSIONS.PRICING_RULE_READ,
    PERMISSIONS.SUPPLIER_CONFIG_READ,
    PERMISSIONS.MAPPING_QUEUE_READ,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.RESELLER_PROFILE_READ,
    PERMISSIONS.AUDIT_READ,
  ]),
};

/**
 * Agency role → permission set (ADR-026 D8 agency-side matrix).
 *
 * `account_admin` holds every agency-side permission. `booker` and
 * `finance` are scoped down. `api_consumer` is intentionally absent
 * — it is not a user role.
 */
const AGENCY_PERMISSIONS: Record<AgencyRole, ReadonlySet<Permission>> = {
  account_admin: new Set<Permission>([
    PERMISSIONS.SEARCH_EXECUTE,
    PERMISSIONS.BOOKING_CREATE,
    PERMISSIONS.BOOKING_READ_OWN,
    PERMISSIONS.BOOKING_READ_ACCOUNT,
    PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY,
    PERMISSIONS.BOOKING_CANCEL_ACCOUNT_WITHIN_POLICY,
    PERMISSIONS.BOOKING_REFUND_OWN_WITHIN_POLICY,
    PERMISSIONS.BOOKING_REFUND_ACCOUNT_WITHIN_POLICY,
    PERMISSIONS.DOCUMENTS_DOWNLOAD_OWN,
    PERMISSIONS.DOCUMENTS_DOWNLOAD_ACCOUNT,
    PERMISSIONS.LEDGER_READ_ACCOUNT,
    PERMISSIONS.STATEMENTS_DOWNLOAD,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.API_KEYS_MANAGE,
    PERMISSIONS.RESELLER_PROFILE_READ,
    PERMISSIONS.ACCOUNT_SETTINGS_EDIT,
  ]),

  booker: new Set<Permission>([
    PERMISSIONS.SEARCH_EXECUTE,
    PERMISSIONS.BOOKING_CREATE,
    PERMISSIONS.BOOKING_READ_OWN,
    PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY,
    PERMISSIONS.BOOKING_REFUND_OWN_WITHIN_POLICY,
    PERMISSIONS.DOCUMENTS_DOWNLOAD_OWN,
  ]),

  finance: new Set<Permission>([
    PERMISSIONS.SEARCH_EXECUTE,
    PERMISSIONS.BOOKING_READ_ACCOUNT,
    PERMISSIONS.DOCUMENTS_DOWNLOAD_ACCOUNT,
    PERMISSIONS.LEDGER_READ_ACCOUNT,
    PERMISSIONS.STATEMENTS_DOWNLOAD,
  ]),
};

/**
 * Returns the union of permissions held by the given set of role
 * grants. Roles outside the user's class (per `userClass`) are
 * silently ignored — defense in depth against a corrupted DB row.
 */
export function expandRolesToPermissions(
  userClass: 'OPERATOR' | 'AGENCY',
  roles: Iterable<string>,
): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    if (userClass === 'OPERATOR' && isOperatorRole(role)) {
      for (const p of OPERATOR_PERMISSIONS[role]) out.add(p);
    } else if (userClass === 'AGENCY' && isAgencyRole(role)) {
      for (const p of AGENCY_PERMISSIONS[role]) out.add(p);
    }
    // Cross-class role on a user is ignored (denial), not honored.
  }
  return out;
}

/**
 * Test-only export so unit tests can assert the matrix without
 * reading the maps via reflection. Production code uses
 * `expandRolesToPermissions`.
 */
export const __PERMISSION_MAP_FOR_TESTS = {
  operator: OPERATOR_PERMISSIONS,
  agency: AGENCY_PERMISSIONS,
} as const;
