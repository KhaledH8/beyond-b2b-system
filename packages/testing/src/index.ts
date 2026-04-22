import type { TenantContext, Money, CurrencyCode } from '@bb/domain';

export const TEST_TENANT_ID = 'test-tenant-01';
export const TEST_ACCOUNT_ID = 'test-account-01';
export const TEST_SUPPLIER_ID = 'test-supplier-hotelbeds';

export const TEST_TENANT_CONTEXT: TenantContext = {
  tenantId: TEST_TENANT_ID,
};

export function money(amount: string, currency: CurrencyCode = 'USD'): Money {
  return { amount, currency };
}

/**
 * Adapter conformance suite placeholder.
 * The real suite lands with the first supplier adapter implementation.
 * Each adapter must pass these tests to be merged (ADR-003).
 */
export const ADAPTER_CONFORMANCE_SUITE_PLACEHOLDER =
  'Conformance suite: implement in Phase 1 alongside the first adapter.';
