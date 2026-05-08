import { Inject, Injectable } from '@nestjs/common';
import { createVerify, type KeyObject } from 'node:crypto';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';
import { AUTH0_CLAIM_NAMESPACE } from '../auth.config';
import { JwksCacheService } from './jwks-cache.service';

/**
 * Validates an Auth0-issued OIDC JWT (RS256) and extracts the
 * application-relevant claims.
 *
 * Validation steps (RFC 7519 §7.2 + Auth0 specifics):
 *
 *   1. Parse 3-segment JWS structure.
 *   2. Header `alg` must be RS256 (Auth0 default; we explicitly do
 *      not accept HS256, which would let an attacker forge tokens
 *      using the JWKS as a shared secret — the classic RS-to-HS
 *      confusion attack).
 *   3. Resolve the verification key by `kid` via JwksCacheService.
 *   4. RSA-SHA256 signature verification over `header.payload`.
 *   5. Claim checks: `iss` exact match; `aud` contains our audience;
 *      `exp` and `nbf` are within tolerance.
 *
 * Custom claims of interest (per ADR-026 D1):
 *
 *   - `https://beyondborders.platform/claims/tenant_id` — required
 *   - `https://beyondborders.platform/claims/user_class` — required
 *   - `https://beyondborders.platform/claims/account_id` — required
 *      when user_class === 'AGENCY'; absent when 'OPERATOR'
 *
 * Roles are NOT extracted from the token. They are looked up fresh
 * in the DB on every request — a token-cached role would survive a
 * grant/revoke until expiry and produce silent permission bugs.
 *
 * No external JWT library: node:crypto handles RSA-SHA256 verify and
 * the JWS parsing is trivial. Adding `jose` would be cleaner but is
 * not warranted for one verifier.
 */
export interface ValidatedClaims {
  readonly auth0Sub: string;
  readonly tenantId: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  /** Present when `userClass === 'AGENCY'`; null otherwise. */
  readonly accountId: string | null;
  /** Token expiry (epoch seconds), useful for downstream caches. */
  readonly exp: number;
}

@Injectable()
export class JwtValidatorService {
  /** Allow up to 30 s of clock skew on iat / nbf / exp. */
  private static readonly CLOCK_SKEW_SECONDS = 30;

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(JwksCacheService) private readonly jwks: JwksCacheService,
  ) {}

  async validate(token: string): Promise<ValidatedClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw invalidToken('Token does not have three segments');
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts as [
      string,
      string,
      string,
    ];

    const header = decodeJsonSegment(headerSegment, 'header');
    const alg = header['alg'];
    const typ = header['typ'];
    const kid = header['kid'];
    if (alg !== 'RS256') {
      throw invalidToken(`Unsupported alg: ${String(alg)}`);
    }
    if (typ !== undefined && typ !== 'JWT' && typ !== 'at+jwt') {
      throw invalidToken(`Unsupported typ: ${String(typ)}`);
    }
    if (typeof kid !== 'string' || kid.length === 0) {
      throw invalidToken('Missing kid in token header');
    }

    const key = await this.jwks.getKey(kid);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signatureBytes = base64UrlToBuffer(signatureSegment);
    if (!verifyRs256(signingInput, signatureBytes, key)) {
      throw invalidToken('Signature verification failed');
    }

    const payload = decodeJsonSegment(payloadSegment, 'payload');
    const nowSec = Math.floor(Date.now() / 1000);
    const skew = JwtValidatorService.CLOCK_SKEW_SECONDS;

    const iss = payload['iss'];
    if (typeof iss !== 'string' || iss !== this.config.issuerBaseUrl) {
      throw invalidToken('iss claim mismatch');
    }
    const aud = payload['aud'];
    if (!audienceMatches(aud, this.config.audience)) {
      throw invalidToken('aud claim mismatch');
    }
    const exp = payload['exp'];
    if (typeof exp !== 'number') {
      throw invalidToken('Missing exp claim');
    }
    if (nowSec > exp + skew) {
      throw invalidToken('Token expired');
    }
    const nbf = payload['nbf'];
    if (typeof nbf === 'number' && nowSec + skew < nbf) {
      throw invalidToken('Token not yet valid (nbf)');
    }
    const sub = payload['sub'];
    if (typeof sub !== 'string' || sub.length === 0) {
      throw invalidToken('Missing sub claim');
    }

    const tenantId = readNamespacedClaim(payload, 'tenant_id');
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw invalidToken('Missing tenant_id claim');
    }
    const userClassRaw = readNamespacedClaim(payload, 'user_class');
    if (userClassRaw !== 'OPERATOR' && userClassRaw !== 'AGENCY') {
      throw invalidToken(`Invalid user_class claim: ${String(userClassRaw)}`);
    }
    const accountIdRaw = readNamespacedClaim(payload, 'account_id');
    if (userClassRaw === 'AGENCY') {
      if (typeof accountIdRaw !== 'string' || accountIdRaw.length === 0) {
        throw invalidToken('AGENCY user_class requires account_id claim');
      }
    } else if (accountIdRaw !== undefined && accountIdRaw !== null) {
      throw invalidToken('OPERATOR user_class must not carry account_id');
    }

    return {
      auth0Sub: sub,
      tenantId,
      userClass: userClassRaw,
      accountId:
        userClassRaw === 'AGENCY' ? (accountIdRaw as string) : null,
      exp,
    };
  }
}

function decodeJsonSegment(
  segment: string,
  label: string,
): Record<string, unknown> {
  let json: string;
  try {
    json = base64UrlToBuffer(segment).toString('utf8');
  } catch {
    throw invalidToken(`Malformed ${label} encoding`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidToken(`Malformed ${label} JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidToken(`${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function base64UrlToBuffer(input: string): Buffer {
  const padded =
    input.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function verifyRs256(
  signingInput: string,
  signature: Buffer,
  key: KeyObject,
): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key, signature);
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

function readNamespacedClaim(
  payload: Record<string, unknown>,
  key: string,
): unknown {
  return payload[`${AUTH0_CLAIM_NAMESPACE}${key}`];
}

/**
 * `InvalidJwtError` carries a short, non-leaking message. The guard
 * translates it to a generic 401 — we never echo the failure reason
 * back to the client.
 */
export class InvalidJwtError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidJwtError';
  }
}

function invalidToken(reason: string): InvalidJwtError {
  return new InvalidJwtError(reason);
}
