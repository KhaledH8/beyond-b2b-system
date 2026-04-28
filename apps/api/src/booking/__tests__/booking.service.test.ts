import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BookingService } from '../booking.service';
import type {
  BookingRecord,
  BookingRepository,
  BookingStatus,
} from '../booking.repository';

/**
 * Pure unit tests for BookingService.confirm. The pg pool/client and
 * the repository are both mocked. No DB, no Nest test module.
 *
 * Coverage:
 *   - chargeCurrency validation
 *   - not-found / terminal-state guards
 *   - idempotency fast-path (status='CONFIRMED' on entry)
 *   - successful confirm (UPDATE returns 1 row)
 *   - race / concurrent-confirm path (UPDATE returns 0 rows)
 *   - error during UPDATE → ROLLBACK + rethrow
 *   - client.release() always runs
 */

const BOOKING_ID = '01ARZ3NDEKTSV4RRFFQ69G5BKG';

interface PoolMock {
  pool: Pool;
  connect: ReturnType<typeof vi.fn>;
  client: PoolClient;
  clientQuery: ReturnType<typeof vi.fn>;
  clientRelease: ReturnType<typeof vi.fn>;
}

function makePoolMock(): PoolMock {
  const clientQuery = vi.fn(async () => ({ rows: [] }));
  const clientRelease = vi.fn();
  const client = {
    query: clientQuery,
    release: clientRelease,
  } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  return { pool, connect, client, clientQuery, clientRelease };
}

interface RepoMock {
  repository: BookingRepository;
  loadById: ReturnType<typeof vi.fn>;
  markConfirmed: ReturnType<typeof vi.fn>;
}

function makeRepoMock(): RepoMock {
  const loadById = vi.fn();
  const markConfirmed = vi.fn();
  return {
    repository: { loadById, markConfirmed } as unknown as BookingRepository,
    loadById,
    markConfirmed,
  };
}

function bookingRecord(status: BookingStatus): BookingRecord {
  return {
    id: BOOKING_ID,
    tenantId: '01ARZ3NDEKTSV4RRFFQ69G5TEN',
    status,
    sellAmountMinorUnits: null,
    sellCurrency: null,
  };
}

describe('BookingService.confirm', () => {
  let pool: PoolMock;
  let repo: RepoMock;
  let service: BookingService;

  beforeEach(() => {
    pool = makePoolMock();
    repo = makeRepoMock();
    service = new BookingService(pool.pool, repo.repository);
  });

  it('rejects non-3-letter-uppercase chargeCurrency before any DB call', async () => {
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'usd' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'US' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USDA' }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.loadById).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the booking does not exist', async () => {
    repo.loadById.mockResolvedValue(undefined);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(NotFoundException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('returns alreadyConfirmed: true on the idempotency fast-path without opening a transaction', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('CONFIRMED'));
    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'USD',
    });
    expect(result).toEqual({ bookingId: BOOKING_ID, alreadyConfirmed: true });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(repo.markConfirmed).not.toHaveBeenCalled();
  });

  it.each<BookingStatus>(['CANCELLED', 'FAILED', 'REFUNDED'])(
    'throws BadRequestException for terminal status %s',
    async (status) => {
      repo.loadById.mockResolvedValue(bookingRecord(status));
      await expect(
        service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
      ).rejects.toThrow(BadRequestException);
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );

  it.each<BookingStatus>(['INITIATED', 'PENDING_PAYMENT'])(
    'opens a transaction, calls markConfirmed, and COMMITs from %s',
    async (status) => {
      repo.loadById.mockResolvedValue(bookingRecord(status));
      repo.markConfirmed.mockResolvedValue({ updated: true });

      const result = await service.confirm({
        bookingId: BOOKING_ID,
        chargeCurrency: 'USD',
      });

      expect(result).toEqual({ bookingId: BOOKING_ID, alreadyConfirmed: false });
      expect(pool.connect).toHaveBeenCalledTimes(1);
      // BEGIN ... COMMIT bracket the markConfirmed call.
      expect(pool.clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(repo.markConfirmed).toHaveBeenCalledWith(pool.client, BOOKING_ID);
      expect(pool.clientQuery).toHaveBeenLastCalledWith('COMMIT');
      expect(pool.clientRelease).toHaveBeenCalledTimes(1);
    },
  );

  it('throws ConflictException and ROLLBACKs when markConfirmed returns updated:false (race)', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: false });

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(ConflictException);

    // ROLLBACK fired (at least once); COMMIT never fired.
    const rollbackCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'ROLLBACK',
    );
    const commitCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(commitCalls.length).toBe(0);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and re-throws when markConfirmed itself throws', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    const boom = new Error('database is sad');
    repo.markConfirmed.mockRejectedValue(boom);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toBe(boom);

    const rollbackCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'ROLLBACK',
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the client even when ROLLBACK itself fails', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockRejectedValue(new Error('update failed'));
    pool.clientQuery.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('rollback also failed');
      return { rows: [] };
    });

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/update failed/);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });
});
