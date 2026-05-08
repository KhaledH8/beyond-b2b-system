import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Auth0WebhookSignatureService } from '../webhook/auth0-webhook-signature.service';
import type { AuthConfig } from '../auth.tokens';

/**
 * Verifies HMAC-SHA256 signature semantics, replay-window enforcement,
 * and constant-time mismatch behavior.
 */

const SECRET = 'shh_super_secret';

function makeConfig(secret: string | null): AuthConfig {
  return {
    issuerBaseUrl: 'https://auth.beyondborders.test/',
    audience: 'https://api.beyondborders.test',
    jwksUri: 'https://auth.beyondborders.test/.well-known/jwks.json',
    bootstrapMode: false,
    defaultTenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    management: null,
    webhookSecret: secret,
  };
}

function sign(secret: string, ts: string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex');
}

describe('Auth0WebhookSignatureService.verify', () => {
  const nowSec = 1762556400; // 2025-11-07T22:20:00Z; freezes time independent of test host
  const nowMs = nowSec * 1000;

  it('returns true for correctly signed body within the replay window', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const ts = String(nowSec);
    const body = Buffer.from('{"logs":[{"log_id":"abc"}]}', 'utf8');
    const sig = sign(SECRET, ts, body);
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: ts,
        nowMs,
      }),
    ).toBe(true);
  });

  it('accepts uppercase hex too (case-insensitive comparison)', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const ts = String(nowSec);
    const body = Buffer.from('hello', 'utf8');
    const sig = sign(SECRET, ts, body).toUpperCase();
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: ts,
        nowMs,
      }),
    ).toBe(true);
  });

  it('rejects when secret is unconfigured', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(null));
    const ts = String(nowSec);
    const body = Buffer.from('hello', 'utf8');
    const sig = sign(SECRET, ts, body);
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: ts,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects when signature header is missing', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    expect(
      svc.verify({
        rawBody: Buffer.from('x'),
        signatureHeader: undefined,
        timestampHeader: String(nowSec),
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects when timestamp is missing', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    expect(
      svc.verify({
        rawBody: Buffer.from('x'),
        signatureHeader: 'deadbeef',
        timestampHeader: undefined,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects when timestamp is not an integer', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    expect(
      svc.verify({
        rawBody: Buffer.from('x'),
        signatureHeader: 'a',
        timestampHeader: 'not-a-number',
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects on body tamper', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const ts = String(nowSec);
    const body = Buffer.from('original', 'utf8');
    const sig = sign(SECRET, ts, body);
    expect(
      svc.verify({
        rawBody: Buffer.from('tampered', 'utf8'),
        signatureHeader: sig,
        timestampHeader: ts,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects on wrong secret', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const ts = String(nowSec);
    const body = Buffer.from('x', 'utf8');
    const sig = sign('wrong_secret', ts, body);
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: ts,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects timestamps outside the replay window', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const oldTs = String(nowSec - 600); // 10 minutes ago, default window is 5
    const body = Buffer.from('x', 'utf8');
    const sig = sign(SECRET, oldTs, body);
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: oldTs,
        nowMs,
      }),
    ).toBe(false);
  });

  it('honors caller-provided replay window override', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    const oldTs = String(nowSec - 60);
    const body = Buffer.from('x', 'utf8');
    const sig = sign(SECRET, oldTs, body);
    // 30s window rejects a 60s-old timestamp.
    expect(
      svc.verify({
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: oldTs,
        replayWindowSeconds: 30,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects an obviously truncated signature gracefully', () => {
    const svc = new Auth0WebhookSignatureService(makeConfig(SECRET));
    expect(
      svc.verify({
        rawBody: Buffer.from('x'),
        signatureHeader: 'short',
        timestampHeader: String(nowSec),
        nowMs,
      }),
    ).toBe(false);
  });
});
