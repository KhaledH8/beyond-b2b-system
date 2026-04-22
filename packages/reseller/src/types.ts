import type { Money } from '@bb/domain';

/**
 * ADR-018: settlement modes.
 * RESELLER_COLLECTS = default, reseller bills guest directly.
 * CREDIT_ONLY       = BB collects, earnings are non-withdrawable platform credit.
 * PAYOUT_ELIGIBLE   = BB collects, earnings are withdrawable cash (KYC gated).
 */
export type ResellerSettlementMode =
  | 'RESELLER_COLLECTS'
  | 'CREDIT_ONLY'
  | 'PAYOUT_ELIGIBLE';

/** ADR-017: how the reseller prices to their guest. */
export type ResaleRuleKind =
  | 'FIXED_GUEST_AMOUNT'
  | 'FIXED_MARKUP_ABSOLUTE'
  | 'PERCENT_MARKUP'
  | 'HIDE_PRICE';

export type GuestPriceDisplayKind = 'SHOW_RESALE_AMOUNT' | 'SHOW_ORIGINAL_AMOUNT' | 'HIDE';

export interface ResellerProfile {
  readonly id: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly settlementMode: ResellerSettlementMode;
  readonly billingProfileId: string;
  readonly taxProfileId: string;
  readonly brandingProfileId: string;
  readonly resaleRuleId: string;
  readonly guestPriceDisplayPolicyId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BillingProfile {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly legalEntityName: string;
  readonly billingAddress: string;
  readonly version: number;
}

export interface TaxRegistration {
  readonly countryCode: string;
  readonly taxId: string;
  readonly taxIdType: string;
}

export interface TaxProfile {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly taxRegistrations: ReadonlyArray<TaxRegistration>;
  readonly version: number;
}

export interface BrandingProfile {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly displayName: string;
  readonly logoObjectKey?: string;
  readonly version: number;
}

export interface ResellerResaleRule {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly kind: ResaleRuleKind;
  readonly fixedAmount?: Money;
  readonly markupAbsolute?: Money;
  readonly percentMarkup?: string;
  readonly version: number;
}

export interface GuestPriceDisplayPolicy {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly kind: GuestPriceDisplayKind;
  readonly version: number;
}

/** ADR-018: KYC/KYB profile required for PAYOUT_ELIGIBLE. */
export type LegalEntityKind = 'COMPANY' | 'PARTNERSHIP' | 'INDIVIDUAL_NOT_BUSINESS';
export type KycStatus = 'PENDING' | 'IN_REVIEW' | 'VERIFIED' | 'REJECTED';

export interface ResellerKycProfile {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly legalEntityKind: LegalEntityKind;
  readonly status: KycStatus;
  readonly sanctionsScreeningClearedAt?: Date;
  readonly pepScreeningClearedAt?: Date;
  readonly verifiedAt?: Date;
  readonly rejectedAt?: Date;
  readonly rejectionReason?: string;
}

export type PayoutAccountStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface PayoutAccount {
  readonly id: string;
  readonly resellerProfileId: string;
  readonly status: PayoutAccountStatus;
  readonly accountHolderName: string;
  readonly externalRef: string;
  readonly verifiedAt?: Date;
}
