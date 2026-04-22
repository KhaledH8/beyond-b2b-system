/** ISO 4217 currency code, e.g. "USD", "AED" */
export type CurrencyCode = string;

/** Monetary amount. Always a decimal string — never a float. */
export interface Money {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

/** Passed on every cross-module call to identify the active tenant. */
export interface TenantContext {
  readonly tenantId: string;
}

export interface PaginationCursor {
  readonly cursor?: string;
  readonly pageSize: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor?: string;
  readonly total?: number;
}
