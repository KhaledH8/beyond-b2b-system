import { Inject, Injectable, Logger } from '@nestjs/common';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';

/**
 * Caches the Auth0 tenant's signing keys (JWKS) and exposes a single
 * `getKey(kid)` method for the JWT validator.
 *
 * The cache is refreshed at most every `MIN_REFRESH_INTERVAL_MS` to
 * avoid hammering Auth0 on a request burst that contains an unknown
 * `kid` (which would otherwise trigger one fetch per request).
 *
 * Key rotation handling:
 *
 *   - On a successful fetch, all keys present in the JWKS response
 *     are stored. Auth0 keeps the previous key in JWKS for some time
 *     after rotation, so both old and new tokens validate during the
 *     rollover window without us needing dual logic.
 *
 *   - If a token arrives with a `kid` we have not seen, we refresh
 *     once (subject to the throttle). If still unknown, the validator
 *     rejects the token. Forging an unknown `kid` is not a viable
 *     attack — the public key would still need to validate the
 *     signature.
 *
 * No external dependency: uses node:crypto's `createPublicKey` to
 * accept Auth0's JWK shape directly.
 */
@Injectable()
export class JwksCacheService {
  private readonly logger = new Logger(JwksCacheService.name);

  /** Throttle for "kid not found, refetch" — prevents fetch storms. */
  private static readonly MIN_REFRESH_INTERVAL_MS = 60_000;

  /** Soft TTL: refresh proactively when older than this. */
  private static readonly SOFT_TTL_MS = 24 * 60 * 60 * 1000;

  private cache: ReadonlyMap<string, KeyObject> = new Map();
  private lastFetchAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Returns the verification key for a given `kid`, refreshing the
   * cache once if necessary. Throws if the `kid` cannot be resolved
   * after a fresh fetch.
   */
  async getKey(kid: string): Promise<KeyObject> {
    const cached = this.cache.get(kid);
    const isStale =
      this.lastFetchAt === 0 ||
      Date.now() - this.lastFetchAt > JwksCacheService.SOFT_TTL_MS;
    if (cached && !isStale) {
      return cached;
    }
    await this.refresh();
    const fresh = this.cache.get(kid);
    if (!fresh) {
      throw new Error(`No signing key in JWKS for kid="${kid}"`);
    }
    return fresh;
  }

  /**
   * Forces a fetch of the JWKS document and rebuilds the in-memory
   * map. Concurrent callers share a single in-flight fetch.
   */
  private async refresh(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    if (
      this.lastFetchAt > 0 &&
      Date.now() - this.lastFetchAt < JwksCacheService.MIN_REFRESH_INTERVAL_MS
    ) {
      // Recently fetched; do not refetch on every miss within the
      // throttle window. The kid is still unknown — the validator
      // will reject the token.
      return;
    }
    this.inFlight = (async () => {
      try {
        const next = await fetchJwks(this.config.jwksUri);
        this.cache = next;
        this.lastFetchAt = Date.now();
        this.logger.log(
          `Refreshed JWKS from ${this.config.jwksUri}; ${next.size} key(s)`,
        );
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }
}

async function fetchJwks(url: string): Promise<Map<string, KeyObject>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `JWKS fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) {
    throw new Error('JWKS response missing "keys" array');
  }
  const map = new Map<string, KeyObject>();
  for (const raw of body.keys) {
    const jwk = raw as Record<string, unknown>;
    const kid = jwk['kid'];
    const use = jwk['use'];
    const kty = jwk['kty'];
    const alg = jwk['alg'];
    if (typeof kid !== 'string') continue;
    // Only RS256 verification keys are accepted. Auth0's default
    // signing alg is RS256 with use=sig.
    if (use !== undefined && use !== 'sig') continue;
    if (kty !== 'RSA') continue;
    if (alg !== undefined && alg !== 'RS256') continue;
    try {
      const keyObj = createPublicKey({ key: jwk as never, format: 'jwk' });
      map.set(kid, keyObj);
    } catch {
      // Skip malformed keys but keep iterating; an attacker cannot
      // poison our JWKS with an extra well-formed key (Auth0 hosts
      // it), and we'd rather have the other valid keys than fail
      // the entire refresh on one bad entry.
      continue;
    }
  }
  if (map.size === 0) {
    throw new Error('JWKS response contained no usable RS256 signing keys');
  }
  return map;
}
