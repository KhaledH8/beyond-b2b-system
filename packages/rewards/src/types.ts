import type { Money } from '@bb/domain';

export type RewardStatus = 'PENDING' | 'POSTED' | 'REDEEMED' | 'EXPIRED' | 'CLAWED_BACK';

/**
 * ADR-014 amendment (2026-04-22): every posting declares its funder.
 * HOTEL_FUNDED requires a RewardCampaign + funding_agreement_ref + approver.
 */
export type FundingSource = 'PLATFORM_FUNDED' | 'HOTEL_FUNDED' | 'SHARED_FUNDED';

export type EarnRuleType =
  | 'PERCENT_OF_MARGIN'
  | 'FIXED_REWARD_BY_MARGIN_BRACKET'
  | 'HOTEL_FUNDED_BONUS'
  | 'MANUAL_OVERRIDE'
  | 'CAP_AND_FLOOR';

export interface EarnRule {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId?: string;
  readonly accountType?: string;
  readonly ruleType: EarnRuleType;
  readonly fundingSource: FundingSource;
  /** Decimal string, e.g. "0.05" for 5%. Default rule is PERCENT_OF_MARGIN. */
  readonly percentOfMargin?: string;
  readonly fixedAmount?: Money;
  readonly capAmount?: Money;
  readonly floorAmount?: Money;
  readonly rewardCampaignId?: string;
  readonly isActive: boolean;
  readonly priority: number;
}

export interface RewardCampaign {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly fundingSource: FundingSource;
  readonly fundingAgreementRef?: string;
  readonly approvedBy?: string;
  readonly isActive: boolean;
  readonly startsAt: Date;
  readonly endsAt?: Date;
}

export interface RewardPosting {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly bookingId: string;
  readonly earnRuleId: string;
  readonly rewardCampaignId?: string;
  readonly fundingSource: FundingSource;
  readonly amount: Money;
  readonly status: RewardStatus;
  readonly matureAfter: Date;
  readonly postedAt?: Date;
  readonly clawbackAt?: Date;
}

export interface ReferralInvite {
  readonly id: string;
  readonly tenantId: string;
  readonly inviterAccountId: string;
  readonly code: string;
  readonly status: 'PENDING' | 'USED' | 'EXPIRED';
  readonly usedByAccountId?: string;
  readonly fraudDecisionId?: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type FraudVerdict = 'CLEAR' | 'FLAGGED' | 'REJECTED';

export interface FraudDecision {
  readonly id: string;
  readonly referralInviteId: string;
  readonly verdict: FraudVerdict;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly reason?: string;
}
