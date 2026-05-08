import { describe, expect, it, vi } from 'vitest';
import { Auth0EventIngestionRepository } from '../webhook/auth0-event-ingestion.repository';
import type { Queryable } from '../../database/queryable';

/**
 * Pure tests for the idempotency repository. The behavior under test
 * is the unique_violation translation:
 *
 *   - first insert succeeds → tryRecord returns true.
 *   - duplicate (Postgres SQLSTATE 23505) → returns false, swallows.
 *   - any other SQL error → propagates.
 */

function makeQ(impl: (sql: string, vals: unknown[]) => Promise<unknown>): Queryable {
  return { query: vi.fn(async (sql: string, vals?: unknown[]) => impl(sql, vals ?? [])) } as unknown as Queryable;
}

describe('Auth0EventIngestionRepository', () => {
  it('returns true on a fresh insert', async () => {
    const q = makeQ(async () => ({ rows: [], rowCount: 1 }));
    const repo = new Auth0EventIngestionRepository();
    expect(await repo.tryRecord(q, 'log_a', 'sd')).toBe(true);
  });

  it('returns false on unique_violation (SQLSTATE 23505)', async () => {
    const dup = Object.assign(new Error('duplicate'), { code: '23505' });
    const q = makeQ(async () => {
      throw dup;
    });
    const repo = new Auth0EventIngestionRepository();
    expect(await repo.tryRecord(q, 'log_a', 'sd')).toBe(false);
  });

  it('propagates other SQL errors', async () => {
    const other = Object.assign(new Error('connection lost'), { code: '08006' });
    const q = makeQ(async () => {
      throw other;
    });
    const repo = new Auth0EventIngestionRepository();
    await expect(repo.tryRecord(q, 'log_a', 'sd')).rejects.toThrow(/connection lost/);
  });

  it('exists() runs a SELECT EXISTS', async () => {
    const q = makeQ(async () => ({ rows: [{ exists: true }], rowCount: 1 }));
    const repo = new Auth0EventIngestionRepository();
    expect(await repo.exists(q, 'log_a')).toBe(true);
  });
});
