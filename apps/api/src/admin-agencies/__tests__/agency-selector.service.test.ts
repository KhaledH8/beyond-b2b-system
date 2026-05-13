import { describe, expect, it, vi } from 'vitest';
import {
  AgencySelectorService,
  type ListAgenciesInput,
} from '../agency-selector.service';
import type {
  AgencySelectorRepository,
  AgencySummaryRow,
} from '../agency-selector.repository';

const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function makeRepo(
  rows: AgencySummaryRow[] = [],
): AgencySelectorRepository {
  return {
    listActiveAgencies: vi.fn(async () => rows),
  } as unknown as AgencySelectorRepository;
}

function makeService(repo: AgencySelectorRepository): AgencySelectorService {
  return new AgencySelectorService(repo);
}

const SAMPLE_ROWS: AgencySummaryRow[] = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5AAA', name: 'Acme Travel', status: 'ACTIVE' },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5BBB', name: 'Beta Tours',  status: 'ACTIVE' },
];

describe('AgencySelectorService.listAgencies — input shaping', () => {
  it('A — passes tenantId through unchanged', async () => {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    await svc.listAgencies({ tenantId: TENANT_A });
    expect(repo.listActiveAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
    );
  });

  it('B — defaults q to empty string when not provided', async () => {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    await svc.listAgencies({ tenantId: TENANT_A });
    expect(repo.listActiveAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ q: '' }),
    );
  });

  it('C — trims q before passing to repo', async () => {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    await svc.listAgencies({ tenantId: TENANT_A, q: '  acme  ' });
    expect(repo.listActiveAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'acme' }),
    );
  });

  it('D — empty-string q remains empty after trim', async () => {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    await svc.listAgencies({ tenantId: TENANT_A, q: '   ' });
    expect(repo.listActiveAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ q: '' }),
    );
  });
});

describe('AgencySelectorService.listAgencies — limit clamping', () => {
  async function call(input: Partial<ListAgenciesInput>): Promise<number> {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    await svc.listAgencies({ tenantId: TENANT_A, ...input });
    const call = (repo.listActiveAgencies as ReturnType<typeof vi.fn>).mock.calls[0]!;
    return (call[0] as { limit: number }).limit;
  }

  it('E — defaults to 20 when limit is undefined', async () => {
    expect(await call({})).toBe(20);
  });

  it('F — passes through a valid limit unchanged', async () => {
    expect(await call({ limit: 10 })).toBe(10);
  });

  it('G — caps limit at 50', async () => {
    expect(await call({ limit: 1000 })).toBe(50);
  });

  it('H — floors fractional limits', async () => {
    expect(await call({ limit: 12.7 })).toBe(12);
  });

  it('I — clamps zero / negative limit to 1', async () => {
    expect(await call({ limit: 0 })).toBe(1);
    expect(await call({ limit: -5 })).toBe(1);
  });

  it('J — falls back to default when limit is NaN', async () => {
    expect(await call({ limit: NaN })).toBe(20);
  });
});

describe('AgencySelectorService.listAgencies — result mapping', () => {
  it('K — returns accounts array shaped { id, name, status }', async () => {
    const repo = makeRepo(SAMPLE_ROWS);
    const svc = makeService(repo);
    const result = await svc.listAgencies({ tenantId: TENANT_A });
    expect(result).toEqual({
      accounts: [
        { id: SAMPLE_ROWS[0]!.id, name: 'Acme Travel', status: 'ACTIVE' },
        { id: SAMPLE_ROWS[1]!.id, name: 'Beta Tours', status: 'ACTIVE' },
      ],
    });
  });

  it('L — empty repo result yields empty accounts array', async () => {
    const repo = makeRepo([]);
    const svc = makeService(repo);
    const result = await svc.listAgencies({ tenantId: TENANT_A });
    expect(result).toEqual({ accounts: [] });
  });
});
