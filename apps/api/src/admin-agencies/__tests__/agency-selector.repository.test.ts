import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@bb/db';
import {
  AgencySelectorRepository,
  type AgencySummaryRow,
} from '../agency-selector.repository';

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function makePool(rows: AgencySummaryRow[] = []): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as Pool, query };
}

describe('AgencySelectorRepository.listActiveAgencies — SQL contract', () => {
  it('A — runs a parameterised query with tenantId, q, limit (in order)', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: 'acme', limit: 25 });

    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(params).toEqual([TENANT, 'acme', 25]);
  });

  it('B — SQL hard-filters to AGENCY + ACTIVE in the WHERE clause', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: '', limit: 20 });

    const [sql] = query.mock.calls[0]! as [string];
    expect(sql).toContain("account_type  = 'AGENCY'");
    expect(sql).toContain("status        = 'ACTIVE'");
  });

  it('C — SQL scopes by tenant_id via $1', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: '', limit: 20 });
    const [sql] = query.mock.calls[0]! as [string];
    expect(sql).toMatch(/tenant_id\s*=\s*\$1/);
  });

  it('D — orders by name asc, id asc', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: '', limit: 20 });
    const [sql] = query.mock.calls[0]! as [string];
    expect(sql).toMatch(/ORDER BY\s+name\s+ASC,\s+id\s+ASC/i);
  });

  it('E — applies LIMIT via $3', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: '', limit: 7 });
    const [sql] = query.mock.calls[0]! as [string];
    expect(sql).toMatch(/LIMIT\s+\$3/);
  });

  it('F — empty q matches every row (passes through the $2="" branch)', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({ tenantId: TENANT, q: '', limit: 20 });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/\$2::text\s*=\s*''/);
    expect(params[1]).toBe('');
  });

  it('G — non-empty q is passed verbatim (parameterised, no interpolation)', async () => {
    const { pool, query } = makePool();
    const repo = new AgencySelectorRepository(pool);
    await repo.listActiveAgencies({
      tenantId: TENANT,
      q: "acme'; DROP TABLE core_account; --",
      limit: 20,
    });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    // SQL string itself contains NO interpolated value — only $-placeholders.
    expect(sql).not.toContain('acme');
    expect(sql).not.toContain('DROP TABLE');
    expect(params[1]).toBe("acme'; DROP TABLE core_account; --");
  });

  it('H — returns the rows array as-is', async () => {
    const rows: AgencySummaryRow[] = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5AAA', name: 'Acme', status: 'ACTIVE' },
    ];
    const { pool } = makePool(rows);
    const repo = new AgencySelectorRepository(pool);
    const out = await repo.listActiveAgencies({
      tenantId: TENANT,
      q: '',
      limit: 20,
    });
    expect(out).toEqual(rows);
  });
});
