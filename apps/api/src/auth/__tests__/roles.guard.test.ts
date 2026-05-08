import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RolesGuard } from '../permissions/roles.guard';
import {
  REQUIRE_PERMISSION_KEY,
  RequirePermission,
} from '../permissions/require-permission.decorator';
import {
  PERMISSIONS,
  type Permission,
} from '../permissions/permissions';
import type { PermissionResolverService } from '../permissions/permission-resolver.service';
import { AUTH_CONTEXT_KEY, type AuthContext } from '../auth-context';

/**
 * Pure unit tests for RolesGuard.
 *
 * Reflector + resolver are constructed/mocked structurally. The
 * guard's responsibilities tested here:
 *   - 403 when no AuthContext on request
 *   - 403 when no @RequirePermission metadata (default deny)
 *   - 403 when resolved set lacks the required permission
 *   - allow when resolved set contains every required permission
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBA';

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    auth0Sub: 'auth0|x',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId: null,
    userClass: 'OPERATOR',
    ...overrides,
  };
}

function makeContext(opts: {
  authContext?: AuthContext | undefined;
  metadata?: readonly Permission[];
  handler?: (...args: unknown[]) => unknown;
}): ExecutionContext {
  const handler = opts.handler ?? function fakeHandler() { /* noop */ };
  if (opts.metadata) {
    Reflect.defineMetadata(REQUIRE_PERMISSION_KEY, opts.metadata, handler);
  }
  const req = {} as Request;
  if (opts.authContext) {
    (req as unknown as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] =
      opts.authContext;
  }
  // Simulate a class with no class-level metadata
  class FakeController {}
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

function makeResolver(
  permissions: ReadonlySet<Permission>,
): PermissionResolverService {
  return {
    resolve: vi.fn(async (auth: AuthContext) => ({
      userId: auth.userId,
      userClass: auth.userClass,
      roles: [],
      permissions,
      accountId: auth.accountId,
    })),
    hasPermission: vi.fn(),
  } as unknown as PermissionResolverService;
}

describe('RolesGuard', () => {
  it('throws ForbiddenException when AuthContext is missing on the request', async () => {
    const guard = new RolesGuard(new Reflector(), makeResolver(new Set()));
    const ctx = makeContext({
      authContext: undefined,
      metadata: [PERMISSIONS.BOOKING_READ],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when no @RequirePermission metadata is set (default deny)', async () => {
    const guard = new RolesGuard(new Reflector(), makeResolver(new Set()));
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: undefined,
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when @RequirePermission metadata is empty array', async () => {
    const guard = new RolesGuard(new Reflector(), makeResolver(new Set()));
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: [],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when the resolved set lacks the required permission', async () => {
    const guard = new RolesGuard(
      new Reflector(),
      makeResolver(new Set<Permission>([PERMISSIONS.BOOKING_READ])),
    );
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: [PERMISSIONS.BOOKING_CANCEL_MANUAL],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows when the resolved set contains the required permission', async () => {
    const guard = new RolesGuard(
      new Reflector(),
      makeResolver(
        new Set<Permission>([PERMISSIONS.BOOKING_CANCEL_MANUAL]),
      ),
    );
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: [PERMISSIONS.BOOKING_CANCEL_MANUAL],
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('requires every permission in the metadata (AND semantics)', async () => {
    const guard = new RolesGuard(
      new Reflector(),
      makeResolver(
        new Set<Permission>([PERMISSIONS.LEDGER_READ]),
      ),
    );
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: [PERMISSIONS.LEDGER_READ, PERMISSIONS.LEDGER_ADJUST],
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows when all required permissions are present', async () => {
    const guard = new RolesGuard(
      new Reflector(),
      makeResolver(
        new Set<Permission>([
          PERMISSIONS.LEDGER_READ,
          PERMISSIONS.LEDGER_ADJUST,
        ]),
      ),
    );
    const ctx = makeContext({
      authContext: makeAuthContext(),
      metadata: [PERMISSIONS.LEDGER_READ, PERMISSIONS.LEDGER_ADJUST],
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('@RequirePermission decorator', () => {
  it('attaches metadata to the method via the standard Nest reflector path', () => {
    class FakeController {
      @RequirePermission(PERMISSIONS.BOOKING_CONFIRM_MANUAL)
      confirm() { /* noop */ }
    }
    const reflector = new Reflector();
    const meta = reflector.get<readonly Permission[]>(
      REQUIRE_PERMISSION_KEY,
      FakeController.prototype.confirm,
    );
    expect(meta).toEqual([PERMISSIONS.BOOKING_CONFIRM_MANUAL]);
  });

  it('supports multiple permissions (AND)', () => {
    class FakeController {
      @RequirePermission(PERMISSIONS.LEDGER_READ, PERMISSIONS.LEDGER_ADJUST)
      adjust() { /* noop */ }
    }
    const reflector = new Reflector();
    const meta = reflector.get<readonly Permission[]>(
      REQUIRE_PERMISSION_KEY,
      FakeController.prototype.adjust,
    );
    expect(meta).toEqual([
      PERMISSIONS.LEDGER_READ,
      PERMISSIONS.LEDGER_ADJUST,
    ]);
  });
});
