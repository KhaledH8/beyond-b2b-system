import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';

/**
 * Caches the Auth0 Management API M2M access token (Slice E2-B).
 *
 * The Management API itself uses bearer tokens minted by Auth0's
 * `/oauth/token` endpoint via the `client_credentials` grant on a
 * machine-to-machine application. Each token has a short lifetime
 * (Auth0 default is 24h) and is comparatively expensive to mint, so
 * we cache it in-process.
 *
 * Cache invariants:
 *
 *   - Returned token is always at least `MIN_REMAINING_LIFETIME_MS`
 *     fresh, so a downstream Management API call never races a hard
 *     expiry mid-flight.
 *
 *   - Concurrent callers share a single in-flight refresh
 *     (`inFlight`), to avoid a thundering herd on cold start or
 *     rotation.
 *
 *   - The cached token is held only in process memory; restarting the
 *     instance forces a fresh mint, which is the intended behavior.
 *     We deliberately do not persist tokens (they would become a
 *     credential at rest that needs its own protection).
 *
 * Failure mode: if Auth0 returns non-2xx, we throw a generic error and
 * do not cache — the caller (provisioning service) surfaces a 5xx so
 * ops sees the failure. We deliberately do not retry inside this
 * service; retry policy belongs to the caller.
 */
@Injectable()
export class Auth0ManagementTokenService {
  private readonly logger = new Logger(Auth0ManagementTokenService.name);

  /** Refresh proactively when fewer than this many ms remain. */
  private static readonly MIN_REMAINING_LIFETIME_MS = 60_000;

  private cache: { token: string; expiresAtMs: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /**
   * Returns a Management API access token, minting a fresh one if
   * none is cached or the cached one is near expiry. Throws if M2M
   * creds are not configured on this instance.
   */
  async getAccessToken(): Promise<string> {
    const mgmt = this.config.management;
    if (!mgmt) {
      throw new Error(
        'Auth0 Management API is not configured (AUTH0_MGMT_CLIENT_ID/SECRET unset)',
      );
    }
    const now = Date.now();
    if (
      this.cache &&
      this.cache.expiresAtMs - now > Auth0ManagementTokenService.MIN_REMAINING_LIFETIME_MS
    ) {
      return this.cache.token;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const minted = await mintToken(mgmt);
        this.cache = {
          token: minted.accessToken,
          expiresAtMs: now + minted.expiresInSeconds * 1000,
        };
        this.logger.log(
          `Minted Auth0 Management token (expires in ${minted.expiresInSeconds}s)`,
        );
        return minted.accessToken;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Test/operability hook: drop the cached token. The next
   * `getAccessToken()` call will mint fresh. Useful when a 401 from
   * the Management API indicates the token was revoked early (rare
   * but possible if an admin rotates the M2M credential).
   */
  invalidate(): void {
    this.cache = null;
  }
}

interface MintedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

async function mintToken(
  mgmt: AuthConfig['management'] & object,
): Promise<MintedToken> {
  const body = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: mgmt.clientId,
    client_secret: mgmt.clientSecret,
    audience: mgmt.audience,
  });
  const response = await fetch(mgmt.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Auth0 token mint failed: ${response.status} ${response.statusText} ${truncate(text, 200)}`,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  const accessToken = json['access_token'];
  const expiresIn = json['expires_in'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Auth0 token mint response missing access_token');
  }
  if (typeof expiresIn !== 'number' || expiresIn <= 0) {
    throw new Error('Auth0 token mint response missing expires_in');
  }
  return { accessToken, expiresInSeconds: expiresIn };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
