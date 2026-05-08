import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth0ManagementTokenService } from '../management/auth0-management-token.service';
import type { AuthConfig } from '../auth.tokens';

/**
 * Unit tests for the Management API token cache.
 *
 * The fetch path is mocked via `vi.stubGlobal('fetch', ...)` so we
 * never hit Auth0 during tests. The contract under test is:
 *
 *   - missing M2M config → throws (not configured).
 *   - cold path mints a token via /oauth/token.
 *   - subsequent calls use the cached token until near expiry.
 *   - concurrent callers share a single in-flight mint.
 *   - invalidate() forces a fresh mint on the next call.
 */

const baseConfig: AuthConfig = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Auth0ManagementTokenService', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('throws when M2M config is null', async () => {
    const svc = new Auth0ManagementTokenService({
      ...baseConfig,
      management: null,
    });
    await expect(svc.getAccessToken()).rejects.toThrow(/not configured/);
  });

  it('mints a token on cold path and caches it', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok_abc', expires_in: 3600 }),
    );
    const svc = new Auth0ManagementTokenService(baseConfig);

    const t1 = await svc.getAccessToken();
    const t2 = await svc.getAccessToken();
    expect(t1).toBe('tok_abc');
    expect(t2).toBe('tok_abc');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Body sent to /oauth/token contains client_credentials grant.
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://auth.beyondborders.test/oauth/token');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      grant_type: 'client_credentials',
      client_id: 'mgmt_client',
      client_secret: 'mgmt_secret',
      audience: 'https://auth.beyondborders.test/api/v2/',
    });
  });

  it('shares a single in-flight mint between concurrent callers', async () => {
    let resolveBody!: (v: Response) => void;
    fetchSpy.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveBody = res;
      }),
    );
    const svc = new Auth0ManagementTokenService(baseConfig);
    const p1 = svc.getAccessToken();
    const p2 = svc.getAccessToken();
    resolveBody(jsonResponse({ access_token: 'tok_concurrent', expires_in: 3600 }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('tok_concurrent');
    expect(r2).toBe('tok_concurrent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is near expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00Z'));
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'first', expires_in: 60 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'second', expires_in: 3600 }),
      );
    const svc = new Auth0ManagementTokenService(baseConfig);
    expect(await svc.getAccessToken()).toBe('first');
    // Advance past the freshness threshold (60 s remaining).
    vi.setSystemTime(new Date('2026-05-08T00:00:30Z'));
    expect(await svc.getAccessToken()).toBe('second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a fresh mint', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'first', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'second', expires_in: 3600 }),
      );
    const svc = new Auth0ManagementTokenService(baseConfig);
    expect(await svc.getAccessToken()).toBe('first');
    svc.invalidate();
    expect(await svc.getAccessToken()).toBe('second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on non-2xx and does not cache', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('forbidden', { status: 403 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'recovered', expires_in: 3600 }),
      );
    const svc = new Auth0ManagementTokenService(baseConfig);
    await expect(svc.getAccessToken()).rejects.toThrow(/403/);
    expect(await svc.getAccessToken()).toBe('recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when response body lacks access_token', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ expires_in: 3600 }));
    const svc = new Auth0ManagementTokenService(baseConfig);
    await expect(svc.getAccessToken()).rejects.toThrow(/access_token/);
  });

  it('throws when response body lacks expires_in', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok' }),
    );
    const svc = new Auth0ManagementTokenService(baseConfig);
    await expect(svc.getAccessToken()).rejects.toThrow(/expires_in/);
  });
});
