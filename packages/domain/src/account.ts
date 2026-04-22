export type AccountType = 'B2C' | 'AGENCY' | 'SUBSCRIBER' | 'CORPORATE';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

export interface Account {
  readonly id: string;
  readonly tenantId: string;
  readonly type: AccountType;
  readonly name: string;
  readonly isActive: boolean;
  /** True when a ResellerProfile exists for this account (AGENCY/SUBSCRIBER only). */
  readonly hasResellerProfile: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
