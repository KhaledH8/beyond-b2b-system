import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../jwt/jwt-auth.guard';
import {
  InvalidJwtError,
  type JwtValidatorService,
  type ValidatedClaims,
} from '../jwt/jwt-validator.service';
import {
  MissingUserError,
  type UserSyncService,
} from '../user-sync/user-sync.service';
import { AUTH_CONTEXT_KEY } from '../auth-context';
import type { CoreUserRecord } from '../user-sync/user.repository';

/**
 * Pure unit tests for JwtAuthGuard.
 *
 * Both downstream services are mocked. The guard is responsible for:
 *   - extracting the bearer token,
 *   - converting validator errors to 401,
 *   - converting MissingUserError to 401,
 *   - attaching AuthContext on success.
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
const ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';

function makeContext(authHeader?: string): {
  ctx: ExecutionContext;
  req: Request;
} {
  const req = {
    headers: authHeader === undefined ? {} : { authorization: authHeader },
  } as unknown as Request;
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function operatorClaims(): ValidatedClaims {
  return {
    auth0Sub: 'auth0|abc123',
    tenantId: TENANT_ID,
    userClass: 'OPERATOR',
    accountId: null,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
}

function operatorRecord(): CoreUserRecord {
  return {
    id: USER_ID,
    tenantId: TENANT_ID,
    auth0Sub: 'auth0|abc123',
    email: 'op@beyondborders.test',
    displayName: 'Op Person',
    userClass: 'OPERATOR',
    status: 'ACTIVE',
  };
}

describe('JwtAuthGuard', () => {
  it('rejects when no bearer header is present', async () => {
    const validator = { validate: vi.fn() } as unknown as JwtValidatorService;
    const sync = { syncOnAuthentication: vi.fn() } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx } = makeContext();
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when authorization header is not Bearer', async () => {
    const validator = { validate: vi.fn() } as unknown as JwtValidatorService;
    const sync = { syncOnAuthentication: vi.fn() } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx } = makeContext('Basic abc123');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when validator throws InvalidJwtError', async () => {
    const validator = {
      validate: vi.fn(async () => {
        throw new InvalidJwtError('Signature verification failed');
      }),
    } as unknown as JwtValidatorService;
    const sync = { syncOnAuthentication: vi.fn() } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx } = makeContext('Bearer some.token.here');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when sync throws MissingUserError', async () => {
    const validator = {
      validate: vi.fn(async () => operatorClaims()),
    } as unknown as JwtValidatorService;
    const sync = {
      syncOnAuthentication: vi.fn(async () => {
        throw new MissingUserError('auth0|abc123');
      }),
    } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx } = makeContext('Bearer some.token.here');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches AuthContext for an OPERATOR on success', async () => {
    const validator = {
      validate: vi.fn(async () => operatorClaims()),
    } as unknown as JwtValidatorService;
    const sync = {
      syncOnAuthentication: vi.fn(async () => operatorRecord()),
    } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx, req } = makeContext('Bearer abc.def.ghi');

    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    const ctxOnReq = (req as unknown as Record<symbol, unknown>)[
      AUTH_CONTEXT_KEY
    ] as { userId: string; userClass: string; accountId: string | null };
    expect(ctxOnReq.userId).toBe(USER_ID);
    expect(ctxOnReq.userClass).toBe('OPERATOR');
    expect(ctxOnReq.accountId).toBeNull();
  });

  it('attaches AuthContext with accountId for an AGENCY user', async () => {
    const claims: ValidatedClaims = {
      auth0Sub: 'auth0|agent1',
      tenantId: TENANT_ID,
      userClass: 'AGENCY',
      accountId: ACCOUNT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const record: CoreUserRecord = {
      id: USER_ID,
      tenantId: TENANT_ID,
      auth0Sub: 'auth0|agent1',
      email: 'admin@acme.test',
      displayName: 'Admin',
      userClass: 'AGENCY',
      status: 'ACTIVE',
    };
    const validator = {
      validate: vi.fn(async () => claims),
    } as unknown as JwtValidatorService;
    const sync = {
      syncOnAuthentication: vi.fn(async () => record),
    } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx, req } = makeContext('Bearer abc.def.ghi');

    await guard.canActivate(ctx);
    const ctxOnReq = (req as unknown as Record<symbol, unknown>)[
      AUTH_CONTEXT_KEY
    ] as { userId: string; userClass: string; accountId: string | null };
    expect(ctxOnReq.userClass).toBe('AGENCY');
    expect(ctxOnReq.accountId).toBe(ACCOUNT_ID);
  });

  it('passes through the trimmed Bearer token to the validator', async () => {
    const claims = operatorClaims();
    const validateMock = vi.fn(async () => claims);
    const validator = { validate: validateMock } as unknown as JwtValidatorService;
    const sync = {
      syncOnAuthentication: vi.fn(async () => operatorRecord()),
    } as unknown as UserSyncService;
    const guard = new JwtAuthGuard(validator, sync);
    const { ctx } = makeContext('Bearer  abc.def.ghi  ');

    await guard.canActivate(ctx);
    expect(validateMock).toHaveBeenCalledWith('abc.def.ghi');
  });
});
