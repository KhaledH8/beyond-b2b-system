import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../auth.config';

/**
 * Pure tests for loadAuthConfig — covers the required-env, trailing-
 * slash, and bootstrap-mode parsing rules.
 */

const REQUIRED = [
  'AUTH0_ISSUER_BASE_URL',
  'AUTH0_AUDIENCE',
  'AUTH0_DEFAULT_TENANT_ID',
] as const;

describe('loadAuthConfig', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of [
      ...REQUIRED,
      'AUTH0_BOOTSTRAP_MODE',
      'AUTH0_MGMT_CLIENT_ID',
      'AUTH0_MGMT_CLIENT_SECRET',
      'AUTH0_MGMT_AUDIENCE',
      'AUTH0_WEBHOOK_SECRET',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('loads a valid configuration with bootstrap mode off by default', () => {
    process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test/';
    process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
    process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const cfg = loadAuthConfig();
    expect(cfg.issuerBaseUrl).toBe('https://auth.beyondborders.test/');
    expect(cfg.audience).toBe('https://api.beyondborders.test');
    expect(cfg.jwksUri).toBe(
      'https://auth.beyondborders.test/.well-known/jwks.json',
    );
    expect(cfg.bootstrapMode).toBe(false);
    expect(cfg.defaultTenantId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('rejects an issuer without trailing slash', () => {
    process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test';
    process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
    process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(() => loadAuthConfig()).toThrow(/trailing slash/);
  });

  it.each(REQUIRED)('rejects missing %s', (envKey) => {
    process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test/';
    process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
    process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    delete process.env[envKey];
    expect(() => loadAuthConfig()).toThrow(new RegExp(envKey));
  });

  it('parses bootstrap mode = true', () => {
    process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test/';
    process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
    process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    process.env['AUTH0_BOOTSTRAP_MODE'] = 'true';
    expect(loadAuthConfig().bootstrapMode).toBe(true);
  });

  it('rejects invalid bootstrap mode values', () => {
    process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test/';
    process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
    process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    process.env['AUTH0_BOOTSTRAP_MODE'] = 'YES';
    expect(() => loadAuthConfig()).toThrow(/AUTH0_BOOTSTRAP_MODE/);
  });

  describe('E2-B optional config', () => {
    function setRequiredEnv(): void {
      process.env['AUTH0_ISSUER_BASE_URL'] = 'https://auth.beyondborders.test/';
      process.env['AUTH0_AUDIENCE'] = 'https://api.beyondborders.test';
      process.env['AUTH0_DEFAULT_TENANT_ID'] = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    }

    it('returns null management when M2M creds are unset', () => {
      setRequiredEnv();
      expect(loadAuthConfig().management).toBeNull();
    });

    it('loads management config when both client_id and secret are set', () => {
      setRequiredEnv();
      process.env['AUTH0_MGMT_CLIENT_ID'] = 'mgmt_client';
      process.env['AUTH0_MGMT_CLIENT_SECRET'] = 'mgmt_secret';
      const cfg = loadAuthConfig();
      expect(cfg.management).not.toBeNull();
      expect(cfg.management?.clientId).toBe('mgmt_client');
      expect(cfg.management?.clientSecret).toBe('mgmt_secret');
      // Default audience and token URL derive from issuer.
      expect(cfg.management?.audience).toBe(
        'https://auth.beyondborders.test/api/v2/',
      );
      expect(cfg.management?.tokenUrl).toBe(
        'https://auth.beyondborders.test/oauth/token',
      );
    });

    it('honors AUTH0_MGMT_AUDIENCE override', () => {
      setRequiredEnv();
      process.env['AUTH0_MGMT_CLIENT_ID'] = 'mgmt_client';
      process.env['AUTH0_MGMT_CLIENT_SECRET'] = 'mgmt_secret';
      process.env['AUTH0_MGMT_AUDIENCE'] = 'https://custom-mgmt.example/';
      expect(loadAuthConfig().management?.audience).toBe(
        'https://custom-mgmt.example/',
      );
    });

    it('rejects half-configured M2M creds (client_id set, secret missing)', () => {
      setRequiredEnv();
      process.env['AUTH0_MGMT_CLIENT_ID'] = 'mgmt_client';
      expect(() => loadAuthConfig()).toThrow(/together/);
    });

    it('rejects half-configured M2M creds (secret set, client_id missing)', () => {
      setRequiredEnv();
      process.env['AUTH0_MGMT_CLIENT_SECRET'] = 'mgmt_secret';
      expect(() => loadAuthConfig()).toThrow(/together/);
    });

    it('returns null webhookSecret when unset', () => {
      setRequiredEnv();
      expect(loadAuthConfig().webhookSecret).toBeNull();
    });

    it('returns the webhook secret when set', () => {
      setRequiredEnv();
      process.env['AUTH0_WEBHOOK_SECRET'] = 'shh';
      expect(loadAuthConfig().webhookSecret).toBe('shh');
    });
  });
});
