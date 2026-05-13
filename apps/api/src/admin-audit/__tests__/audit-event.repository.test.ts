import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@bb/db';
import {
  AuditEventRepository,
  type AuditEventRow,
  type ListAuditEventsQuery,
} from '../audit-event.repository';

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5OPE';
const GRANT = '01ARZ3NDEKTSV4RRFFQ69G5GRA';

function makePool(rows: AuditEventRow[] = []): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as Pool, query };
}

async function runWith(
  overrides: Partial<ListAuditEventsQuery>,
): Promise<{ sql: string; params: unknown[] }> {
  const { pool, query } = makePool();
  const repo = new AuditEventRepository(pool);
  await repo.listEvents({
    tenantId: TENANT,
    includeSensitive: false,
    limit: 50,
    ...overrides,
  });
  const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
  return { sql, params };
}

describe('AuditEventRepository.listEvents — SQL shape', () => {
  it('A — parameterized: 14 positional placeholders, no interpolation', async () => {
    const { sql, params } = await runWith({});
    // Every placeholder must be a $N literal — no concatenation of user values.
    for (let i = 1; i <= 14; i++) {
      expect(sql).toContain(`$${i}`);
    }
    expect(params).toHaveLength(14);
    // Sanity: no user-controlled string is interpolated.
    expect(sql).not.toContain(TENANT);
    expect(sql).not.toContain(ACTOR);
  });

  it('B — tenant_id is bound to $1', async () => {
    const { sql, params } = await runWith({});
    expect(sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(params[0]).toBe(TENANT);
  });

  it('C — ORDER BY occurred_at DESC, id DESC', async () => {
    const { sql } = await runWith({});
    expect(sql).toMatch(/ORDER BY\s+occurred_at\s+DESC,\s+id\s+DESC/i);
  });

  it('D — LIMIT $14', async () => {
    const { sql, params } = await runWith({ limit: 75 });
    expect(sql).toMatch(/LIMIT\s+\$14/);
    expect(params[13]).toBe(75);
  });
});

describe('AuditEventRepository.listEvents — filter parameter binding', () => {
  it('E — category bound to $2', async () => {
    const { params } = await runWith({ category: 'IMPERSONATION' });
    expect(params[1]).toBe('IMPERSONATION');
  });

  it('F — kind bound to $3', async () => {
    const { params } = await runWith({ kind: 'IMPERSONATION_STARTED' });
    expect(params[2]).toBe('IMPERSONATION_STARTED');
  });

  it('G — actorUserId bound to $4', async () => {
    const { params } = await runWith({ actorUserId: ACTOR });
    expect(params[3]).toBe(ACTOR);
  });

  it('H — targetKind ($5) + targetId ($6) bound together', async () => {
    const { params } = await runWith({
      targetKind: 'BOOKING',
      targetId: 'BK-1',
    });
    expect(params[4]).toBe('BOOKING');
    expect(params[5]).toBe('BK-1');
  });

  it('I — requestId bound to $7', async () => {
    const reqId = '01ARZ3NDEKTSV4RRFFQ69G5REQ';
    const { params } = await runWith({ requestId: reqId });
    expect(params[6]).toBe(reqId);
  });

  it('J — impersonationGrantId bound to $8', async () => {
    const { params } = await runWith({ impersonationGrantId: GRANT });
    expect(params[7]).toBe(GRANT);
  });

  it('K — occurredFrom ($9) + occurredTo ($10) bound', async () => {
    const from = new Date('2026-05-01T00:00:00Z');
    const to = new Date('2026-05-14T00:00:00Z');
    const { params } = await runWith({ occurredFrom: from, occurredTo: to });
    expect(params[8]).toBe(from);
    expect(params[9]).toBe(to);
  });

  it('L — unset filters are bound as null (so the IS NULL branch fires)', async () => {
    const { params } = await runWith({});
    expect(params[1]).toBeNull(); // category
    expect(params[2]).toBeNull(); // kind
    expect(params[3]).toBeNull(); // actorUserId
    expect(params[4]).toBeNull(); // targetKind
    expect(params[5]).toBeNull(); // targetId
    expect(params[6]).toBeNull(); // requestId
    expect(params[7]).toBeNull(); // impersonationGrantId
    expect(params[8]).toBeNull(); // occurredFrom
    expect(params[9]).toBeNull(); // occurredTo
  });
});

describe('AuditEventRepository.listEvents — sensitive scope', () => {
  it('M — includeSensitive=false binds $11 to false', async () => {
    const { sql, params } = await runWith({ includeSensitive: false });
    expect(sql).toContain("category != 'SENSITIVE_ACCESS'");
    expect(params[10]).toBe(false);
  });

  it('N — includeSensitive=true binds $11 to true (short-circuits the filter)', async () => {
    const { params } = await runWith({ includeSensitive: true });
    expect(params[10]).toBe(true);
  });
});

describe('AuditEventRepository.listEvents — cursor pagination', () => {
  it('O — no cursor: $12 and $13 are null', async () => {
    const { params } = await runWith({});
    expect(params[11]).toBeNull();
    expect(params[12]).toBeNull();
  });

  it('P — cursor: $12 (timestamp) + $13 (id) bound together', async () => {
    const at = new Date('2026-05-13T11:00:00Z');
    const { params } = await runWith({
      cursor: { occurredAt: at, id: '01ARZ3NDEKTSV4RRFFQ69G5CUR' },
    });
    expect(params[11]).toBe(at);
    expect(params[12]).toBe('01ARZ3NDEKTSV4RRFFQ69G5CUR');
  });

  it('Q — SQL uses (occurred_at, id) row-comparison for the cursor predicate', async () => {
    const { sql } = await runWith({});
    expect(sql).toContain('(occurred_at, id) < ($12::timestamptz, $13::char(26))');
  });
});

describe('AuditEventRepository.listEvents — injection safety', () => {
  it('R — quote-bearing user values are passed as parameters, never substituted into SQL', async () => {
    const injection = "x'; DROP TABLE audit_event; --";
    const { sql, params } = await runWith({ kind: injection });
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain(injection);
    expect(params[2]).toBe(injection);
  });
});
