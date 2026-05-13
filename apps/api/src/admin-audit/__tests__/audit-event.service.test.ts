import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  AuditEventService,
  type ListAuditEventsInput,
} from '../audit-event.service';
import type {
  AuditEventRepository,
  AuditEventRow,
  ListAuditEventsQuery,
} from '../audit-event.repository';
import { decodeCursor, encodeCursor } from '../cursor';

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR = '01ARZ3NDEKTSV4RRFFQ69G5FBA';

function makeRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5AAA',
    occurred_at: '2026-05-13T10:00:00.000Z',
    recorded_at: '2026-05-13T10:00:00.500Z',
    schema_version: 1,
    category: 'IMPERSONATION',
    kind: 'IMPERSONATION_STARTED',
    tenant_id: TENANT,
    actor_kind: 'USER',
    actor_user_id: ACTOR,
    actor_api_key_id: null,
    actor_label: null,
    target_kind: 'ACCOUNT',
    target_id: '01ARZ3NDEKTSV4RRFFQ69G5TGT',
    request_id: '01ARZ3NDEKTSV4RRFFQ69G5REQ',
    impersonation_grant_id: '01ARZ3NDEKTSV4RRFFQ69G5GRA',
    ip_address: '127.0.0.1',
    user_agent: 'test',
    payload: { grantId: '01ARZ3NDEKTSV4RRFFQ69G5GRA' },
    ...overrides,
  };
}

function makeRepo(rows: AuditEventRow[] = []): AuditEventRepository {
  return {
    listEvents: vi.fn(async () => rows),
  } as unknown as AuditEventRepository;
}

function baseInput(
  overrides: Partial<ListAuditEventsInput> = {},
): ListAuditEventsInput {
  return {
    tenantId: TENANT,
    canViewSensitive: false,
    ...overrides,
  };
}

// ── Happy path + result shape ──────────────────────────────────────────

describe('AuditEventService.listEvents — happy path', () => {
  it('A — returns mapped events and nextCursor=null when no more pages', async () => {
    const repo = makeRepo([makeRow()]);
    const svc = new AuditEventService(repo);
    const result = await svc.listEvents(baseInput());
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5AAA');
    expect(result.events[0]!.occurredAt).toBe('2026-05-13T10:00:00.000Z');
    expect(result.events[0]!.actorUserId).toBe(ACTOR);
    expect(result.nextCursor).toBeNull();
  });

  it('A2 — fetches limit+1 rows from the repo (has-more detection)', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ limit: 10 }));
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    expect(passed.limit).toBe(11);
  });

  it('A3 — when limit+1 rows return, page is sliced to limit and nextCursor is emitted', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeRow({
        id: `01ARZ3NDEKTSV4RRFFQ69G5A${i.toString().padStart(2, '0')}`,
        occurred_at: new Date(2026, 4, 13, 10, i).toISOString(),
      }),
    );
    const repo = makeRepo(rows);
    const svc = new AuditEventService(repo);
    const result = await svc.listEvents(baseInput({ limit: 5 }));

    expect(result.events).toHaveLength(5);
    expect(result.nextCursor).not.toBeNull();
    const decoded = decodeCursor(result.nextCursor!);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(result.events[4]!.id);
  });
});

// ── Tenant scoping ─────────────────────────────────────────────────────

describe('AuditEventService.listEvents — tenant scoping', () => {
  it('B — passes tenantId through unchanged', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput());
    expect(repo.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});

// ── Category validation ───────────────────────────────────────────────

describe('AuditEventService.listEvents — category validation', () => {
  it.each([
    'APP',
    'AUTH',
    'IMPERSONATION',
    'SENSITIVE_ACCESS',
    'SECURITY',
  ])('C — accepts category=%s', async (cat) => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ category: cat, canViewSensitive: true }));
    expect(repo.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ category: cat }),
    );
  });

  it('D — rejects an unknown category with 400', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await expect(
      svc.listEvents(baseInput({ category: 'BOGUS' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('D2 — empty-string category is ignored (no filter applied)', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ category: '' }));
    expect(repo.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ category: undefined }),
    );
  });
});

// ── ULID validation ───────────────────────────────────────────────────

describe('AuditEventService.listEvents — ULID validation', () => {
  it.each([
    ['actorUserId', 'actorUserId' as const],
    ['requestId', 'requestId' as const],
    ['impersonationGrantId', 'impersonationGrantId' as const],
  ])('E — rejects malformed %s with 400', async (_label, field) => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await expect(
      svc.listEvents(baseInput({ [field]: 'not-a-ulid' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('F — accepts a valid ULID for actorUserId', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ actorUserId: ACTOR }));
    expect(repo.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ACTOR }),
    );
  });
});

// ── Date validation ───────────────────────────────────────────────────

describe('AuditEventService.listEvents — date validation', () => {
  it('G — accepts valid ISO timestamps', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(
      baseInput({
        occurredFrom: '2026-05-01T00:00:00Z',
        occurredTo: '2026-05-14T00:00:00Z',
      }),
    );
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    expect(passed.occurredFrom).toBeInstanceOf(Date);
    expect(passed.occurredTo).toBeInstanceOf(Date);
  });

  it('H — rejects an invalid date string with 400', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await expect(
      svc.listEvents(baseInput({ occurredFrom: 'tomorrow-ish' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('I — rejects occurredFrom > occurredTo', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await expect(
      svc.listEvents(
        baseInput({
          occurredFrom: '2026-05-14T00:00:00Z',
          occurredTo: '2026-05-01T00:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Limit clamping ────────────────────────────────────────────────────

describe('AuditEventService.listEvents — limit clamping', () => {
  async function effective(limit: number | undefined): Promise<number> {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ limit }));
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    return passed.limit - 1; // service adds +1 for has-more detection
  }

  it('J — default 50 when undefined', async () => {
    expect(await effective(undefined)).toBe(50);
  });
  it('K — passes through 25', async () => {
    expect(await effective(25)).toBe(25);
  });
  it('L — caps at 200', async () => {
    expect(await effective(1000)).toBe(200);
  });
  it('M — clamps 0 to 1', async () => {
    expect(await effective(0)).toBe(1);
  });
  it('N — clamps negative to 1', async () => {
    expect(await effective(-99)).toBe(1);
  });
  it('O — floors fractional', async () => {
    expect(await effective(12.9)).toBe(12);
  });
  it('P — NaN falls back to default', async () => {
    expect(await effective(NaN)).toBe(50);
  });
});

// ── Cursor decode ─────────────────────────────────────────────────────

describe('AuditEventService.listEvents — cursor decoding', () => {
  it('Q — accepts a valid cursor and passes the decoded value to the repo', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    const cursor = encodeCursor(
      '2026-05-13T09:00:00.000Z',
      '01ARZ3NDEKTSV4RRFFQ69G5CRR',
    );
    await svc.listEvents(baseInput({ cursor }));
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    expect(passed.cursor?.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5CRR');
  });

  it('R — rejects a malformed cursor with 400', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await expect(
      svc.listEvents(baseInput({ cursor: 'this-is-not-base64-json' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Sensitive scope passthrough ───────────────────────────────────────

describe('AuditEventService.listEvents — sensitive scope', () => {
  it('S — canViewSensitive=false → includeSensitive=false', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ canViewSensitive: false }));
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    expect(passed.includeSensitive).toBe(false);
  });

  it('T — canViewSensitive=true → includeSensitive=true', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    await svc.listEvents(baseInput({ canViewSensitive: true }));
    const passed = (repo.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ListAuditEventsQuery;
    expect(passed.includeSensitive).toBe(true);
  });
});

// ── Applied-filters echo ──────────────────────────────────────────────

describe('AuditEventService.listEvents — appliedFilters echo', () => {
  it('U — appliedFilters reflects only the filters the caller actually passed', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    const result = await svc.listEvents(
      baseInput({
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_STARTED',
        actorUserId: ACTOR,
      }),
    );
    expect(result.appliedFilters).toEqual({
      category: 'IMPERSONATION',
      kind: 'IMPERSONATION_STARTED',
      actorUserId: ACTOR,
    });
  });

  it('V — empty input yields empty appliedFilters', async () => {
    const repo = makeRepo([]);
    const svc = new AuditEventService(repo);
    const result = await svc.listEvents(baseInput());
    expect(result.appliedFilters).toEqual({});
  });
});
