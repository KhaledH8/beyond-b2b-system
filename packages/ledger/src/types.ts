import type { Money } from '@bb/domain';

export type LedgerEntryKind =
  // Core booking flows
  | 'BOOKING_CHARGE'
  | 'BOOKING_REFUND'
  // Cash wallet (ADR-012 — jurisdiction gated)
  | 'CASH_WALLET_TOPUP'
  | 'CASH_WALLET_WITHDRAWAL'
  // Promotional credit
  | 'PROMO_CREDIT_GRANT'
  | 'PROMO_CREDIT_REDEEM'
  | 'PROMO_CREDIT_EXPIRE'
  // Loyalty reward (ADR-014)
  | 'LOYALTY_REWARD_ACCRUE'
  | 'LOYALTY_REWARD_REDEEM'
  | 'LOYALTY_REWARD_EXPIRE'
  | 'LOYALTY_REWARD_CLAWBACK'
  // Referral reward (ADR-014)
  | 'REFERRAL_REWARD_ACCRUE'
  | 'REFERRAL_REWARD_REDEEM'
  | 'REFERRAL_REWARD_CLAWBACK'
  // B2B agency credit line (ADR-012)
  | 'AGENCY_CREDIT_DRAW'
  | 'AGENCY_CREDIT_REPAY'
  // Reseller earnings — cash (ADR-018)
  | 'RESELLER_EARNINGS_ACCRUAL'
  | 'RESELLER_EARNINGS_MATURATION'
  | 'RESELLER_EARNINGS_CLAWBACK'
  | 'RESELLER_EARNINGS_RESERVE'
  | 'RESELLER_EARNINGS_PAYOUT'
  // Reseller earnings — non-withdrawable platform credit (ADR-018)
  | 'RESELLER_CREDIT_ACCRUAL'
  | 'RESELLER_CREDIT_REDEEM'
  | 'RESELLER_CREDIT_EXPIRE'
  | 'RESELLER_CREDIT_CLAWBACK'
  // Reseller collections suspense (ADR-018)
  | 'RESELLER_COLLECTIONS_RECEIVED'
  | 'RESELLER_COLLECTIONS_REMITTANCE'
  | 'RESELLER_COLLECTIONS_REFUND'
  // Supplier-side books (ADR-020)
  | 'SUPPLIER_PREPAID_TOPUP'
  | 'SUPPLIER_PREPAID_DRAWDOWN'
  | 'SUPPLIER_POSTPAID_ACCRUAL'
  | 'SUPPLIER_POSTPAID_SETTLEMENT'
  | 'SUPPLIER_COMMISSION_ACCRUAL'
  | 'SUPPLIER_COMMISSION_RECEIVED'
  | 'SUPPLIER_COMMISSION_CLAWBACK'
  | 'VCC_LOAD'
  | 'VCC_SETTLEMENT'
  | 'VCC_UNUSED_RETURN';

export type WalletBalanceType =
  | 'CASH_WALLET'
  | 'PROMO_CREDIT'
  | 'LOYALTY_REWARD'
  | 'REFERRAL_REWARD'
  | 'AGENCY_CREDIT_LINE'
  | 'RESELLER_PLATFORM_CREDIT'
  | 'RESELLER_CASH_EARNINGS';

export interface WalletAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly balanceType: WalletBalanceType;
  readonly currency: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

export interface LedgerEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amount: Money;
  readonly bookingId?: string;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}
