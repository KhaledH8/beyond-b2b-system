import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AdminAgenciesController } from '../admin-agencies.controller';
import type { AgencySelectorService } from '../agency-selector.service';
import type { AuthContext } from '../../auth/auth-context';
import { InternalAuthGuard } from '../../internal-auth/internal-auth.guard';
import { JwtAuthGuard } from '../../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../../auth/permissions/roles.guard';
import { PERMISSIONS } from '../../auth/permissions/permissions';
import { REQUIRE_PERMISSION_KEY } from '../../auth/permissions/require-permission.decorator';

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OPERATOR_ID = '01ARZ3NDEKTSV4RRFFQ69G5OPE';

function operatorAuth(): AuthContext {
  return {
    auth0Sub: 'auth0|operator',
    userId: OPERATOR_ID,
    tenantId: TENANT,
    accountId: null,
    userClass: 'OPERATOR',
  };
}

function makeService(
  result: { accounts: { id: string; name: string; status: string }[] } = {
    accounts: [],
  },
): AgencySelectorService {
  return {
    listAgencies: vi.fn(async () => result),
  } as unknown as AgencySelectorService;
}

describe('AdminAgenciesController.list — delegation', () => {
  it('A — sources tenantId from AuthContext, not from query', async () => {
    const svc = makeService();
    const ctrl = new AdminAgenciesController(svc);
    await ctrl.list(operatorAuth(), undefined, undefined);
    expect(svc.listAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it('B — forwards `q` to service unchanged', async () => {
    const svc = makeService();
    const ctrl = new AdminAgenciesController(svc);
    await ctrl.list(operatorAuth(), 'acme', undefined);
    expect(svc.listAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'acme' }),
    );
  });

  it('C — passes limit as undefined when query is missing', async () => {
    const svc = makeService();
    const ctrl = new AdminAgenciesController(svc);
    await ctrl.list(operatorAuth(), undefined, undefined);
    expect(svc.listAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it('D — parses string limit to number', async () => {
    const svc = makeService();
    const ctrl = new AdminAgenciesController(svc);
    await ctrl.list(operatorAuth(), undefined, '15');
    expect(svc.listAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 15 }),
    );
  });

  it('E — empty string limit is treated as missing (undefined)', async () => {
    const svc = makeService();
    const ctrl = new AdminAgenciesController(svc);
    await ctrl.list(operatorAuth(), undefined, '');
    expect(svc.listAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it('F — returns the service result verbatim', async () => {
    const expected = {
      accounts: [
        { id: '01ARZ3NDEKTSV4RRFFQ69G5AAA', name: 'Acme', status: 'ACTIVE' },
      ],
    };
    const svc = makeService(expected);
    const ctrl = new AdminAgenciesController(svc);
    const result = await ctrl.list(operatorAuth(), undefined, undefined);
    expect(result).toEqual(expected);
  });
});

describe('AdminAgenciesController — guard + permission metadata', () => {
  const reflector = new Reflector();

  it('G — declares JwtAuthGuard + RolesGuard via @UseGuards (NOT InternalAuthGuard)', () => {
    // `@UseGuards` writes the list to `__guards__` on the class metadata.
    const guards = reflector.get<unknown[]>('__guards__', AdminAgenciesController);
    expect(guards).toBeDefined();
    const names = guards!.map((g) => (g as { name?: string })?.name);
    expect(names).toContain(JwtAuthGuard.name);
    expect(names).toContain(RolesGuard.name);
    expect(names).not.toContain(InternalAuthGuard.name);
  });

  it('H — `list` requires IMPERSONATE_AGENCY_ACCOUNT', () => {
    const required = reflector.get<readonly string[]>(
      REQUIRE_PERMISSION_KEY,
      AdminAgenciesController.prototype.list,
    );
    expect(required).toEqual([PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT]);
  });
});
