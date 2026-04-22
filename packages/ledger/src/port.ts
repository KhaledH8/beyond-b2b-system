import type { Money } from '@bb/domain';
import type { LedgerEntry, WalletAccount } from './types';

export interface LedgerPort {
  record(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): Promise<LedgerEntry>;
  getBalance(accountId: string, asOf?: Date): Promise<Money>;
  getEntries(
    accountId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ entries: ReadonlyArray<LedgerEntry>; nextCursor?: string }>;
  getAccount(accountId: string): Promise<WalletAccount | undefined>;
}
