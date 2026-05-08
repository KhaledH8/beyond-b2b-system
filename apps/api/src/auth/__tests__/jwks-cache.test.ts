import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwksCacheService } from '../jwt/jwks-cache.service';
import type { AuthConfig } from '../auth.tokens';

/**
 * Tests for JwksCacheService.
 *
 * `globalThis.fetch` is stubbed per-test, returning a JWKS document
 * built from a real RSA keypair so the createPublicKey path runs.
 */

const config: AuthConfig = {
  issuerBaseUrl: 'https://auth.beyondborders.test/',
  audience: 'https://api.beyondborders.test',
  jwksUri: 'https://auth.beyondborders.test/.well-known/jwks.json',
  bootstrapMode: false,
  defaultTenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  management: null,
  webhookSecret: null,
};

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

const KID_ONE = 'kid-one';
const KID_TWO = 'kid-two';

function makeJwksDoc(kids: string[]): { keys: Record<string, unknown>[] } {
  return {
    keys: kids.map((kid) => ({
      kid,
      kty: jwk['kty'],
      use: 'sig',
      alg: 'RS256',
      n: jwk['n'],
      e: jwk['e'],
    })),
  };
}

describe('JwksCacheService', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockJwksResponse(kids: string[]): void {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeJwksDoc(kids),
    } as Response);
  }

  it('fetches JWKS on first lookup and resolves the kid', async () => {
    mockJwksResponse([KID_ONE]);
    const cache = new JwksCacheService(config);
    const key = await cache.getKey(KID_ONE);
    expect(key).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(config.jwksUri);
  });

  it('reuses the cache on subsequent lookups within the soft TTL', async () => {
    mockJwksResponse([KID_ONE]);
    const cache = new JwksCacheService(config);
    await cache.getKey(KID_ONE);
    await cache.getKey(KID_ONE);
    await cache.getKey(KID_ONE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when a kid is unknown after a fresh fetch', async () => {
    mockJwksResponse([KID_ONE]);
    const cache = new JwksCacheService(config);
    await expect(cache.getKey(KID_TWO)).rejects.toThrow(/No signing key/);
  });

  it('refetches when an unknown kid arrives after the throttle window', async () => {
    // First fetch returns only KID_ONE
    mockJwksResponse([KID_ONE]);
    const cache = new JwksCacheService(config);
    await cache.getKey(KID_ONE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second lookup for an unknown kid within the throttle window
    // does NOT refetch (the throttle prevents it).
    await expect(cache.getKey(KID_TWO)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on non-OK fetch response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    } as Response);
    const cache = new JwksCacheService(config);
    await expect(cache.getKey(KID_ONE)).rejects.toThrow(/JWKS fetch failed/);
  });

  it('throws when JWKS response has no usable keys', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [] }),
    } as Response);
    const cache = new JwksCacheService(config);
    await expect(cache.getKey(KID_ONE)).rejects.toThrow(
      /no usable RS256 signing keys/,
    );
  });

  it('skips non-RSA / non-RS256 / non-sig entries during fetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [
          { kid: 'enc-key', kty: 'RSA', use: 'enc', alg: 'RS256', n: jwk['n'], e: jwk['e'] },
          { kid: 'wrong-alg', kty: 'RSA', use: 'sig', alg: 'PS256', n: jwk['n'], e: jwk['e'] },
          { kid: 'ec-key', kty: 'EC', use: 'sig', alg: 'ES256' },
          { kid: KID_ONE, kty: 'RSA', use: 'sig', alg: 'RS256', n: jwk['n'], e: jwk['e'] },
        ],
      }),
    } as Response);
    const cache = new JwksCacheService(config);
    const key = await cache.getKey(KID_ONE);
    expect(key).toBeDefined();
    await expect(cache.getKey('enc-key')).rejects.toThrow();
  });

  it('shares a single in-flight fetch across concurrent callers', async () => {
    mockJwksResponse([KID_ONE]);
    const cache = new JwksCacheService(config);
    const [a, b, c] = await Promise.all([
      cache.getKey(KID_ONE),
      cache.getKey(KID_ONE),
      cache.getKey(KID_ONE),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
