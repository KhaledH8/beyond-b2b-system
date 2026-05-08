import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Auth0ManagementClient,
  Auth0ManagementError,
} from '../management/auth0-management.client';
import type { Auth0ManagementTokenService } from '../management/auth0-management-token.service';
import type { AuthConfig } from '../auth.tokens';

/**
 * Pure unit tests for the Management API client. Verifies the wire-
 * level shape (URL, headers, body) of the four operations we use, and
 * the error parsing path that distinguishes "email already taken"
 * (409) from other failures.
 */

const config: AuthConfig = {
  issuerBaseUrl: 'https://auth.beyondborders.test/',
  audience: 'https://api.beyondborders.test',
  jwksUri: 'https://auth.beyondborders.test/.well-known/jwks.json',
  bootstrapMode: false,
  defaultTenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  management: {
    clientId: 'mgmt_client',
    clientSecret: 'mgmt_secret',
    audience: 'https://auth.beyondborders.test/api/v2/',
    tokenUrl: 'https://auth.beyondborders.test/oauth/token',
  },
  webhookSecret: null,
};

function tokenSvc(token = 'mgmt_tok'): Auth0ManagementTokenService {
  return {
    getAccessToken: vi.fn(async () => token),
    invalidate: vi.fn(),
  } as unknown as Auth0ManagementTokenService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Auth0ManagementClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createUser POSTs /api/v2/users with bearer + namespaced metadata', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        user_id: 'auth0|new123',
        email: 'new@beyondborders.test',
      }),
    );
    const client = new Auth0ManagementClient(config, tokenSvc('mgmt_tok'));
    const result = await client.createUser({
      email: 'new@beyondborders.test',
      tenantId: 'tenantUlid',
      userClass: 'AGENCY',
      accountId: 'accUlid',
      name: 'New User',
    });
    expect(result.user_id).toBe('auth0|new123');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://auth.beyondborders.test/api/v2/users');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer mgmt_tok');
    const body = JSON.parse(init.body);
    expect(body.email).toBe('new@beyondborders.test');
    expect(body.connection).toBe('Username-Password-Authentication');
    expect(body.email_verified).toBe(false);
    expect(body.app_metadata).toEqual({
      tenant_id: 'tenantUlid',
      user_class: 'AGENCY',
      account_id: 'accUlid',
    });
    expect(body.name).toBe('New User');
    // No password supplied → verify_email defaults to true.
    expect(body.verify_email).toBe(true);
  });

  it('createUser with password skips verify_email', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ user_id: 'auth0|p' }));
    const client = new Auth0ManagementClient(config, tokenSvc());
    await client.createUser({
      email: 'p@beyondborders.test',
      tenantId: 't',
      userClass: 'OPERATOR',
      password: 'TempPass123!',
    });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.password).toBe('TempPass123!');
    expect(body.verify_email).toBeUndefined();
  });

  it('translates 409 into Auth0ManagementError(status=409)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statusCode: 409,
          errorCode: 'auth0_idp_error',
          message: 'The user already exists',
        }),
        { status: 409 },
      ),
    );
    const client = new Auth0ManagementClient(config, tokenSvc());
    await expect(
      client.createUser({
        email: 'dup@beyondborders.test',
        tenantId: 't',
        userClass: 'OPERATOR',
      }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: 'auth0_idp_error',
    });
  });

  it('updateUser PATCHes only the fields supplied', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ user_id: 'auth0|u' }));
    const client = new Auth0ManagementClient(config, tokenSvc());
    await client.updateUser('auth0|u', { blocked: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      'https://auth.beyondborders.test/api/v2/users/auth0%7Cu',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ blocked: true });
  });

  it('deleteUser DELETEs and tolerates an empty 204 response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new Auth0ManagementClient(config, tokenSvc());
    await expect(
      client.deleteUser('auth0|x'),
    ).resolves.not.toThrow();
  });

  it('getUserById returns null on 404', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 404 }), { status: 404 }),
    );
    const client = new Auth0ManagementClient(config, tokenSvc());
    const r = await client.getUserById('auth0|missing');
    expect(r).toBeNull();
  });

  it('propagates non-404 GET errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );
    const client = new Auth0ManagementClient(config, tokenSvc());
    await expect(client.getUserById('auth0|u')).rejects.toBeInstanceOf(
      Auth0ManagementError,
    );
  });
});
