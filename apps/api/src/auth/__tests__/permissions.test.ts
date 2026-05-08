import { describe, expect, it } from 'vitest';
import {
  AGENCY_ROLES,
  expandRolesToPermissions,
  isAgencyRole,
  isOperatorRole,
  OPERATOR_ROLES,
  PERMISSIONS,
  __PERMISSION_MAP_FOR_TESTS,
  type Permission,
} from '../permissions/permissions';

/**
 * Pure tests for the permission catalogue and role mapping. Pinning
 * the matrix here means a casual edit to permissions.ts that drops
 * a permission from a role surfaces as a test failure, not a
 * silent regression.
 */

describe('role classification', () => {
  it('isOperatorRole identifies all operator roles', () => {
    for (const r of OPERATOR_ROLES) expect(isOperatorRole(r)).toBe(true);
  });

  it('isOperatorRole rejects agency roles', () => {
    for (const r of AGENCY_ROLES) expect(isOperatorRole(r)).toBe(false);
  });

  it('isAgencyRole identifies all agency roles', () => {
    for (const r of AGENCY_ROLES) expect(isAgencyRole(r)).toBe(true);
  });

  it('isAgencyRole rejects operator roles', () => {
    for (const r of OPERATOR_ROLES) expect(isAgencyRole(r)).toBe(false);
  });

  it('rejects unknown / api_consumer (not a user role)', () => {
    expect(isOperatorRole('api_consumer')).toBe(false);
    expect(isAgencyRole('api_consumer')).toBe(false);
    expect(isOperatorRole('superuser')).toBe(false);
    expect(isAgencyRole('superuser')).toBe(false);
  });
});

describe('OPERATOR_PERMISSIONS matrix', () => {
  const m = __PERMISSION_MAP_FOR_TESTS.operator;

  it('platform_admin holds every permission', () => {
    const all = Object.values(PERMISSIONS) as Permission[];
    for (const p of all) {
      expect(m.platform_admin.has(p)).toBe(true);
    }
  });

  it('ops_support can intervene on bookings + impersonate', () => {
    expect(m.ops_support.has(PERMISSIONS.BOOKING_CONFIRM_MANUAL)).toBe(true);
    expect(m.ops_support.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
    expect(m.ops_support.has(PERMISSIONS.BOOKING_REFUND_MANUAL)).toBe(true);
    expect(m.ops_support.has(PERMISSIONS.BOOKING_ELIGIBILITY_OVERRIDE)).toBe(true);
    expect(m.ops_support.has(PERMISSIONS.DOCUMENTS_REISSUE)).toBe(true);
    expect(m.ops_support.has(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)).toBe(true);
  });

  it('ops_support cannot adjust ledger or edit pricing rules', () => {
    expect(m.ops_support.has(PERMISSIONS.LEDGER_ADJUST)).toBe(false);
    expect(m.ops_support.has(PERMISSIONS.PRICING_RULE_EDIT)).toBe(false);
    expect(m.ops_support.has(PERMISSIONS.RESELLER_PROFILE_EDIT)).toBe(false);
    expect(m.ops_support.has(PERMISSIONS.USER_ROLE_GRANT)).toBe(false);
  });

  it('finance_ops can adjust ledger and edit pricing rules', () => {
    expect(m.finance_ops.has(PERMISSIONS.LEDGER_READ)).toBe(true);
    expect(m.finance_ops.has(PERMISSIONS.LEDGER_ADJUST)).toBe(true);
    expect(m.finance_ops.has(PERMISSIONS.PRICING_RULE_EDIT)).toBe(true);
  });

  it('finance_ops cannot intervene on bookings or impersonate', () => {
    expect(m.finance_ops.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(false);
    expect(m.finance_ops.has(PERMISSIONS.BOOKING_REFUND_MANUAL)).toBe(false);
    expect(m.finance_ops.has(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)).toBe(false);
  });

  it('integrations_ops can edit supplier config + write mappings', () => {
    expect(m.integrations_ops.has(PERMISSIONS.SUPPLIER_CONFIG_EDIT)).toBe(true);
    expect(m.integrations_ops.has(PERMISSIONS.MAPPING_DECISION_WRITE)).toBe(true);
  });

  it('integrations_ops has no financial actions', () => {
    expect(m.integrations_ops.has(PERMISSIONS.LEDGER_ADJUST)).toBe(false);
    expect(m.integrations_ops.has(PERMISSIONS.BOOKING_REFUND_MANUAL)).toBe(false);
    expect(m.integrations_ops.has(PERMISSIONS.PRICING_RULE_EDIT)).toBe(false);
  });

  it('read_only_auditor has no write permissions', () => {
    const writePerms: Permission[] = [
      PERMISSIONS.BOOKING_CONFIRM_MANUAL,
      PERMISSIONS.BOOKING_CANCEL_MANUAL,
      PERMISSIONS.BOOKING_REFUND_MANUAL,
      PERMISSIONS.BOOKING_ELIGIBILITY_OVERRIDE,
      PERMISSIONS.DOCUMENTS_REISSUE,
      PERMISSIONS.LEDGER_ADJUST,
      PERMISSIONS.PRICING_RULE_EDIT,
      PERMISSIONS.SUPPLIER_CONFIG_EDIT,
      PERMISSIONS.MAPPING_DECISION_WRITE,
      PERMISSIONS.ACCOUNT_EDIT,
      PERMISSIONS.RESELLER_PROFILE_EDIT,
      PERMISSIONS.USER_ROLE_GRANT,
      PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT,
    ];
    for (const p of writePerms) {
      expect(m.read_only_auditor.has(p)).toBe(false);
    }
  });

  it('read_only_auditor can see audit log + reads', () => {
    expect(m.read_only_auditor.has(PERMISSIONS.AUDIT_READ)).toBe(true);
    expect(m.read_only_auditor.has(PERMISSIONS.BOOKING_READ)).toBe(true);
    expect(m.read_only_auditor.has(PERMISSIONS.LEDGER_READ)).toBe(true);
  });
});

describe('AGENCY_PERMISSIONS matrix', () => {
  const m = __PERMISSION_MAP_FOR_TESTS.agency;

  it('account_admin can manage users, api keys, account settings', () => {
    expect(m.account_admin.has(PERMISSIONS.USERS_MANAGE)).toBe(true);
    expect(m.account_admin.has(PERMISSIONS.API_KEYS_MANAGE)).toBe(true);
    expect(m.account_admin.has(PERMISSIONS.ACCOUNT_SETTINGS_EDIT)).toBe(true);
  });

  it('account_admin can read reseller profile but not edit it', () => {
    expect(m.account_admin.has(PERMISSIONS.RESELLER_PROFILE_READ)).toBe(true);
    expect(m.account_admin.has(PERMISSIONS.RESELLER_PROFILE_EDIT)).toBe(false);
  });

  it('booker scoped to own bookings only', () => {
    expect(m.booker.has(PERMISSIONS.BOOKING_READ_OWN)).toBe(true);
    expect(m.booker.has(PERMISSIONS.BOOKING_READ_ACCOUNT)).toBe(false);
    expect(m.booker.has(PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY)).toBe(true);
    expect(m.booker.has(PERMISSIONS.BOOKING_CANCEL_ACCOUNT_WITHIN_POLICY)).toBe(false);
  });

  it('booker cannot access ledger or statements', () => {
    expect(m.booker.has(PERMISSIONS.LEDGER_READ_ACCOUNT)).toBe(false);
    expect(m.booker.has(PERMISSIONS.STATEMENTS_DOWNLOAD)).toBe(false);
  });

  it('finance can read account ledger and download statements but cannot book', () => {
    expect(m.finance.has(PERMISSIONS.LEDGER_READ_ACCOUNT)).toBe(true);
    expect(m.finance.has(PERMISSIONS.STATEMENTS_DOWNLOAD)).toBe(true);
    expect(m.finance.has(PERMISSIONS.BOOKING_READ_ACCOUNT)).toBe(true);
    expect(m.finance.has(PERMISSIONS.BOOKING_CREATE)).toBe(false);
    expect(m.finance.has(PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY)).toBe(false);
  });
});

describe('expandRolesToPermissions', () => {
  it('returns the union of permissions for the given operator roles', () => {
    const perms = expandRolesToPermissions('OPERATOR', [
      'ops_support',
      'finance_ops',
    ]);
    // From ops_support
    expect(perms.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
    // From finance_ops
    expect(perms.has(PERMISSIONS.LEDGER_ADJUST)).toBe(true);
    // Not granted by either
    expect(perms.has(PERMISSIONS.SUPPLIER_CONFIG_EDIT)).toBe(false);
  });

  it('ignores agency roles silently when userClass is OPERATOR', () => {
    const perms = expandRolesToPermissions('OPERATOR', [
      'ops_support',
      'account_admin',  // mismatched class, must be ignored
    ]);
    expect(perms.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
    expect(perms.has(PERMISSIONS.USERS_MANAGE)).toBe(false);
    expect(perms.has(PERMISSIONS.BOOKING_CREATE)).toBe(false);
  });

  it('ignores operator roles silently when userClass is AGENCY', () => {
    const perms = expandRolesToPermissions('AGENCY', [
      'booker',
      'platform_admin',  // mismatched class, must be ignored
    ]);
    expect(perms.has(PERMISSIONS.BOOKING_READ_OWN)).toBe(true);
    expect(perms.has(PERMISSIONS.LEDGER_ADJUST)).toBe(false);
    expect(perms.has(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)).toBe(false);
  });

  it('ignores api_consumer (not a user role)', () => {
    const opsPerms = expandRolesToPermissions('OPERATOR', ['api_consumer']);
    expect(opsPerms.size).toBe(0);
    const agencyPerms = expandRolesToPermissions('AGENCY', ['api_consumer']);
    expect(agencyPerms.size).toBe(0);
  });

  it('returns empty set for a user with no roles (default deny)', () => {
    const opsPerms = expandRolesToPermissions('OPERATOR', []);
    expect(opsPerms.size).toBe(0);
    const agencyPerms = expandRolesToPermissions('AGENCY', []);
    expect(agencyPerms.size).toBe(0);
  });

  it('ignores arbitrary unknown role strings', () => {
    const perms = expandRolesToPermissions('OPERATOR', [
      'ops_support',
      'superuser',
      '',
      'platform_admin',
    ]);
    // Both real ones contributed; junk ignored.
    expect(perms.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
    expect(perms.has(PERMISSIONS.USER_ROLE_GRANT)).toBe(true);
  });
});
