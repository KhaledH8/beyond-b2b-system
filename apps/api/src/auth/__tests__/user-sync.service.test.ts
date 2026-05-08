import { describe, expect, it, vi } from 'vitest';
import {
  MissingUserError,
  UserSyncService,
} from '../user-sync/user-sync.service';
import type {
  CoreUserRecord,
  CoreUserRepository,
} from '../user-sync/user.repository';
import type { Pool } from '@bb/db';
import type { AuthConfig } from '../auth.tokens';

/**
 * Pure unit tests for UserSyncService.
 *
 * The locked rule (Slice E2-A): JIT user creation is permitted ONLY
 * when AUTH0_BOOTSTRAP_MODE=true. These tests pin that rule.
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const baseConfig: AuthConfig = {
  issuerBaseUrl: 'https://auth.beyondborders.test/',
  audience: 'https://api.beyondborders.test',
  jwksUri: 'https://auth.beyondborders.test/.well-known/jwks.json',
  bootstrapMode: false,
  defaultTenantId: TENANT_ID,
  management: null,
  webhookSecret: null,
};

const fakePool = {} as unknown as Pool;

function makeRepoMock(opts: {
  existing?: CoreUserRecord | undefined;
  insertResult?: CoreUserRecord;
}): {
  repo: CoreUserRepository;
  findByAuth0Sub: ReturnType<typeof vi.fn>;
  insertJit: ReturnType<typeof vi.fn>;
  touchLogin: ReturnType<typeof vi.fn>;
} {
  const findByAuth0Sub = vi.fn(async () => opts.existing);
  const insertJit = vi.fn(async () => opts.insertResult ?? null);
  const touchLogin = vi.fn(async () => undefined);
  return {
    repo: { findByAuth0Sub, insertJit, touchLogin } as unknown as CoreUserRepository,
    findByAuth0Sub,
    insertJit,
    touchLogin,
  };
}

const ACTIVE_USER: CoreUserRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FBA',
  tenantId: TENANT_ID,
  auth0Sub: 'auth0|abc123',
  email: 'op@beyondborders.test',
  displayName: 'Op Person',
  userClass: 'OPERATOR',
  status: 'ACTIVE',
};

describe('UserSyncService.syncOnAuthentication', () => {
  it('returns the existing user when the auth0_sub matches and tenant matches', async () => {
    const m = makeRepoMock({ existing: ACTIVE_USER });
    const svc = new UserSyncService(fakePool, baseConfig, m.repo);

    const result = await svc.syncOnAuthentication({
      auth0Sub: 'auth0|abc123',
      tenantId: TENANT_ID,
      userClass: 'OPERATOR',
    });

    expect(result).toBe(ACTIVE_USER);
    expect(m.findByAuth0Sub).toHaveBeenCalledWith(fakePool, 'auth0|abc123');
    expect(m.insertJit).not.toHaveBeenCalled();
    expect(m.touchLogin).toHaveBeenCalledWith(fakePool, ACTIVE_USER.id);
  });

  it('hard-fails when no user exists and bootstrap mode is OFF', async () => {
    const m = makeRepoMock({ existing: undefined });
    const svc = new UserSyncService(
      fakePool,
      { ...baseConfig, bootstrapMode: false },
      m.repo,
    );

    await expect(
      svc.syncOnAuthentication({
        auth0Sub: 'auth0|new123',
        tenantId: TENANT_ID,
        userClass: 'OPERATOR',
      }),
    ).rejects.toThrow(MissingUserError);
    expect(m.insertJit).not.toHaveBeenCalled();
  });

  it('JIT-creates a user when bootstrap mode is ON and email is present', async () => {
    const newRecord: CoreUserRecord = {
      ...ACTIVE_USER,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FBB',
      auth0Sub: 'auth0|new123',
      email: 'bootstrap@beyondborders.test',
    };
    const m = makeRepoMock({ existing: undefined, insertResult: newRecord });
    const svc = new UserSyncService(
      fakePool,
      { ...baseConfig, bootstrapMode: true },
      m.repo,
    );

    const result = await svc.syncOnAuthentication({
      auth0Sub: 'auth0|new123',
      tenantId: TENANT_ID,
      userClass: 'OPERATOR',
      email: 'bootstrap@beyondborders.test',
      displayName: 'Bootstrap Admin',
    });

    expect(result).toBe(newRecord);
    expect(m.insertJit).toHaveBeenCalledTimes(1);
    const arg = m.insertJit.mock.calls[0]![1];
    expect(arg.tenantId).toBe(TENANT_ID);
    expect(arg.email).toBe('bootstrap@beyondborders.test');
    expect(arg.userClass).toBe('OPERATOR');
    expect(arg.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('refuses bootstrap JIT when no email claim is present', async () => {
    const m = makeRepoMock({ existing: undefined });
    const svc = new UserSyncService(
      fakePool,
      { ...baseConfig, bootstrapMode: true },
      m.repo,
    );

    await expect(
      svc.syncOnAuthentication({
        auth0Sub: 'auth0|new123',
        tenantId: TENANT_ID,
        userClass: 'OPERATOR',
      }),
    ).rejects.toThrow(MissingUserError);
    expect(m.insertJit).not.toHaveBeenCalled();
  });

  it('hard-fails when token tenant_id does not match the existing row', async () => {
    const m = makeRepoMock({ existing: ACTIVE_USER });
    const svc = new UserSyncService(fakePool, baseConfig, m.repo);

    await expect(
      svc.syncOnAuthentication({
        auth0Sub: 'auth0|abc123',
        tenantId: '01ARZ3NDEKTSV4RRFFQ69G5XXX', // different
        userClass: 'OPERATOR',
      }),
    ).rejects.toThrow(MissingUserError);
    expect(m.insertJit).not.toHaveBeenCalled();
  });

  it('hard-fails when the existing user is DEACTIVATED', async () => {
    const deactivated: CoreUserRecord = { ...ACTIVE_USER, status: 'DEACTIVATED' };
    const m = makeRepoMock({ existing: deactivated });
    const svc = new UserSyncService(fakePool, baseConfig, m.repo);

    await expect(
      svc.syncOnAuthentication({
        auth0Sub: deactivated.auth0Sub,
        tenantId: deactivated.tenantId,
        userClass: deactivated.userClass,
      }),
    ).rejects.toThrow(MissingUserError);
  });

  it('does not fail the login if touchLogin throws', async () => {
    const m = makeRepoMock({ existing: ACTIVE_USER });
    m.touchLogin.mockRejectedValueOnce(new Error('db blip'));
    const svc = new UserSyncService(fakePool, baseConfig, m.repo);

    const result = await svc.syncOnAuthentication({
      auth0Sub: ACTIVE_USER.auth0Sub,
      tenantId: ACTIVE_USER.tenantId,
      userClass: ACTIVE_USER.userClass,
    });
    expect(result).toBe(ACTIVE_USER);
  });
});
