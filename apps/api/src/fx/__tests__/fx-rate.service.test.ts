import { describe, expect, it, vi } from 'vitest';
import type { FxSnapshot } from '@bb/fx';
import { FxRateService } from '../fx-rate.service';
import type { FxRateSnapshotRepository } from '../fx-rate-snapshot.repository';

/**
 * Pure unit tests for FxRateService — repository is mocked, no DB, no
 * network. Verifies the OXR-then-ECB tier order, the SAME_CURRENCY
 * short-circuit, and the NO_RATE fallthrough.
 */

const NOW = new Date('2025-04-27T14:00:00Z');
const FRESH_OXR = '2025-04-27T13:30:00Z'; // 30m before NOW (within 60m TTL)
const FRESH_ECB = '2025-04-27T00:00:00Z'; // ~14h before NOW (within 1440m TTL)

function makeRepoMock(
  byProvider: Partial<Record<'OXR' | 'ECB', FxSnapshot[]>> = {},
): {
  repo: FxRateSnapshotRepository;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async (provider: string) => {
    return byProvider[provider as 'OXR' | 'ECB'] ?? [];
  });
  const repo = {
    findFreshSnapshots: fetch,
  } as unknown as FxRateSnapshotRepository;
  return { repo, fetch };
}

function snap(
  provider: 'OXR' | 'ECB',
  base: string,
  quote: string,
  rate: string,
  observedAt: string,
): FxSnapshot {
  return { provider, baseCurrency: base, quoteCurrency: quote, rate, observedAt };
}

describe('FxRateService', () => {
  it('returns SAME_CURRENCY without hitting the repository', async () => {
    const { repo, fetch } = makeRepoMock();
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'USD' },
      'USD',
      NOW,
    );
    expect(result).toEqual({ converted: false, reason: 'SAME_CURRENCY' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('converts via OXR DIRECT when a fresh OXR snapshot exists', async () => {
    const { repo, fetch } = makeRepoMock({
      OXR: [snap('OXR', 'USD', 'EUR', '0.92000000', FRESH_OXR)],
    });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'USD' },
      'EUR',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.method).toBe('DIRECT');
      expect(result.provider).toBe('OXR');
      expect(result.appliedRate).toBe('0.92000000');
      expect(result.displayAmount).toEqual({ amount: '92.00', currency: 'EUR' });
    }
    // ECB tier is never consulted when OXR succeeds.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('OXR', NOW, 60);
  });

  it('converts via OXR INVERSE when only USD/EUR is published', async () => {
    const { repo } = makeRepoMock({
      OXR: [snap('OXR', 'USD', 'EUR', '0.92000000', FRESH_OXR)],
    });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'EUR' },
      'USD',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.method).toBe('INVERSE');
      expect(result.provider).toBe('OXR');
    }
  });

  it('converts via OXR CROSS_RATE through the USD pivot', async () => {
    const { repo } = makeRepoMock({
      OXR: [
        snap('OXR', 'USD', 'EUR', '0.92000000', FRESH_OXR),
        snap('OXR', 'USD', 'GBP', '0.78000000', FRESH_OXR),
      ],
    });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'EUR' },
      'GBP',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.method).toBe('CROSS_RATE');
      expect(result.pivotCurrency).toBe('USD');
      expect(result.provider).toBe('OXR');
    }
  });

  it('falls back to ECB when OXR has no fresh snapshots', async () => {
    const { repo, fetch } = makeRepoMock({
      OXR: [],
      ECB: [snap('ECB', 'EUR', 'USD', '1.08500000', FRESH_ECB)],
    });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'EUR' },
      'USD',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.provider).toBe('ECB');
      expect(result.method).toBe('DIRECT');
    }
    expect(fetch).toHaveBeenNthCalledWith(1, 'OXR', NOW, 60);
    expect(fetch).toHaveBeenNthCalledWith(2, 'ECB', NOW, 1440);
  });

  it('falls back to ECB CROSS_RATE via EUR pivot when OXR is empty', async () => {
    const { repo } = makeRepoMock({
      OXR: [],
      ECB: [
        snap('ECB', 'EUR', 'AED', '3.98000000', FRESH_ECB),
        snap('ECB', 'EUR', 'GBP', '0.86100000', FRESH_ECB),
      ],
    });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '1000.00', currency: 'AED' },
      'GBP',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.provider).toBe('ECB');
      expect(result.method).toBe('CROSS_RATE');
      expect(result.pivotCurrency).toBe('EUR');
    }
  });

  it('returns NO_RATE when both OXR and ECB lack the pair', async () => {
    const { repo, fetch } = makeRepoMock({ OXR: [], ECB: [] });
    const service = new FxRateService(repo);
    const result = await service.convert(
      { amount: '100.00', currency: 'JPY' },
      'TRY',
      NOW,
    );
    expect(result).toEqual({ converted: false, reason: 'NO_RATE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not consult ECB when OXR returns a non-converted result for the wrong reason — but does when NO_RATE', async () => {
    // Sanity: OXR has an unrelated pair, can't convert EUR→GBP.
    // Service must consult ECB next.
    const { repo, fetch } = makeRepoMock({
      OXR: [snap('OXR', 'USD', 'JPY', '150.25000000', FRESH_OXR)],
      ECB: [
        snap('ECB', 'EUR', 'GBP', '0.86100000', FRESH_ECB),
      ],
    });
    const service = new FxRateService(repo);
    // EUR → GBP: OXR has no EUR or GBP info, ECB has DIRECT EUR→GBP.
    const result = await service.convert(
      { amount: '100.00', currency: 'EUR' },
      'GBP',
      NOW,
    );
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.provider).toBe('ECB');
      expect(result.method).toBe('DIRECT');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
