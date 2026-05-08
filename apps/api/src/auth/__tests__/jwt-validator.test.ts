import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidJwtError,
  JwtValidatorService,
} from '../jwt/jwt-validator.service';
import type { JwksCacheService } from '../jwt/jwks-cache.service';
import type { AuthConfig } from '../auth.tokens';
import { AUTH0_CLAIM_NAMESPACE } from '../auth.config';

/**
 * Pure unit tests for JwtValidatorService.
 *
 * We generate a test RSA keypair, sign tokens with the private key,
 * and stub `JwksCacheService.getKey` to return the matching public
 * key. The validator code path is exercised end-to-end without a
 * real Auth0 tenant or HTTP fetch.
 */

const ISSUER = 'https://auth.beyondborders.test/';
const AUDIENCE = 'https://api.beyondborders.test';
const KID = 'test-key-1';

const config: AuthConfig = {
  issuerBaseUrl: ISSUER,
  audience: AUDIENCE,
  jwksUri: `${ISSUER}.well-known/jwks.json`,
  bootstrapMode: false,
  defaultTenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  management: null,
  webhookSecret: null,
};

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

function makeJwksMock(key: KeyObject = publicKey): JwksCacheService {
  return {
    getKey: vi.fn(async (kid: string) => {
      if (kid !== KID) throw new Error(`unknown kid: ${kid}`);
      return key;
    }),
  } as unknown as JwksCacheService;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

interface SignOpts {
  readonly header?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly key?: KeyObject;
}

function signJwt(opts: SignOpts): string {
  const header = opts.header ?? { alg: 'RS256', typ: 'JWT', kid: KID };
  const headerSeg = base64url(JSON.stringify(header));
  const payloadSeg = base64url(JSON.stringify(opts.payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(opts.key ?? privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

const NOW_SEC = Math.floor(Date.now() / 1000);

function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'auth0|abc123',
    iat: NOW_SEC - 60,
    exp: NOW_SEC + 600,
    [`${AUTH0_CLAIM_NAMESPACE}tenant_id`]: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    [`${AUTH0_CLAIM_NAMESPACE}user_class`]: 'OPERATOR',
    ...over,
  };
}

describe('JwtValidatorService', () => {
  it('accepts a well-formed RS256 token and extracts claims', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({ payload: basePayload() });

    const claims = await validator.validate(token);
    expect(claims.auth0Sub).toBe('auth0|abc123');
    expect(claims.tenantId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(claims.userClass).toBe('OPERATOR');
    expect(claims.accountId).toBeNull();
    expect(claims.exp).toBeGreaterThan(NOW_SEC);
  });

  it('extracts account_id when user_class is AGENCY', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        [`${AUTH0_CLAIM_NAMESPACE}user_class`]: 'AGENCY',
        [`${AUTH0_CLAIM_NAMESPACE}account_id`]: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      }),
    });

    const claims = await validator.validate(token);
    expect(claims.userClass).toBe('AGENCY');
    expect(claims.accountId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW');
  });

  it('rejects AGENCY tokens missing account_id', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        [`${AUTH0_CLAIM_NAMESPACE}user_class`]: 'AGENCY',
      }),
    });
    await expect(validator.validate(token)).rejects.toThrow(InvalidJwtError);
  });

  it('rejects OPERATOR tokens that carry an account_id', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        [`${AUTH0_CLAIM_NAMESPACE}account_id`]: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/OPERATOR/);
  });

  it('rejects tokens with non-RS256 alg (HS256 confusion guard)', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    // Forge a header that claims HS256 but use RSA-signed bytes;
    // validator should refuse based on alg alone.
    const headerSeg = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }));
    const payloadSeg = base64url(JSON.stringify(basePayload()));
    const sigSeg = base64url(Buffer.from('not-a-real-signature'));
    const token = `${headerSeg}.${payloadSeg}.${sigSeg}`;

    await expect(validator.validate(token)).rejects.toThrow(/alg/);
  });

  it('rejects tokens with mismatched signature', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    // Sign with a different key
    const otherKp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signJwt({
      payload: basePayload(),
      key: createPrivateKey(otherKp.privateKey.export({ type: 'pkcs1', format: 'pem' })),
    });
    await expect(validator.validate(token)).rejects.toThrow(/Signature/);
  });

  it('rejects tokens with wrong issuer', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({ iss: 'https://attacker.example/' }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/iss/);
  });

  it('rejects tokens with wrong audience', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({ aud: 'https://wrong.example' }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/aud/);
  });

  it('accepts tokens with audience as an array containing our audience', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        aud: ['https://other.example', AUDIENCE, 'https://third.example'],
      }),
    });
    const claims = await validator.validate(token);
    expect(claims.auth0Sub).toBe('auth0|abc123');
  });

  it('rejects expired tokens (beyond skew)', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        iat: NOW_SEC - 1000,
        exp: NOW_SEC - 100, // expired well past 30s skew
      }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/expired/);
  });

  it('rejects tokens not yet valid (nbf in future, beyond skew)', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        nbf: NOW_SEC + 1000,
        exp: NOW_SEC + 2000,
      }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/nbf/);
  });

  it('rejects tokens missing kid', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      header: { alg: 'RS256', typ: 'JWT' },
      payload: basePayload(),
    });
    await expect(validator.validate(token)).rejects.toThrow(/kid/);
  });

  it('rejects tokens missing tenant_id custom claim', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const payload = basePayload();
    delete payload[`${AUTH0_CLAIM_NAMESPACE}tenant_id`];
    const token = signJwt({ payload });
    await expect(validator.validate(token)).rejects.toThrow(/tenant_id/);
  });

  it('rejects tokens with invalid user_class', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    const token = signJwt({
      payload: basePayload({
        [`${AUTH0_CLAIM_NAMESPACE}user_class`]: 'B2C',
      }),
    });
    await expect(validator.validate(token)).rejects.toThrow(/user_class/);
  });

  it('rejects tokens that are not three segments', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    await expect(validator.validate('not.a.jwt.really')).rejects.toThrow();
    await expect(validator.validate('only.two')).rejects.toThrow();
  });

  it('rejects malformed base64 segments', async () => {
    const validator = new JwtValidatorService(config, makeJwksMock());
    await expect(
      validator.validate('!!!.!!!.!!!'),
    ).rejects.toThrow();
  });
});
