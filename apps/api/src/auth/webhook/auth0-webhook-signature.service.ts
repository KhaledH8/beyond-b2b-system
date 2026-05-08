import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';

/**
 * Verifies the HMAC-SHA256 signature on Auth0 Log Streams webhook
 * deliveries (Slice E2-B).
 *
 * Auth0's "Custom Webhook" log stream supports user-defined headers
 * but does not natively HMAC-sign the body. The deployment runbook
 * configures an Auth0 Action (or a thin proxy) that adds two headers
 * before forwarding the payload to us:
 *
 *   X-Auth0-Webhook-Timestamp: <unix-seconds>
 *   X-Auth0-Webhook-Signature: <hex hmac-sha256(secret, "${ts}.${rawBody}")>
 *
 * Properties this gives us:
 *
 *   - **Tamper-evidence on the body.** A flipped bit in `rawBody`
 *     invalidates the signature.
 *
 *   - **Replay window.** The timestamp prefix means a stale-but-valid
 *     payload can still be rejected by the controller if the clock
 *     is too far off (default 5 min) — without that prefix an
 *     attacker who captures a single signed body can replay it
 *     forever.
 *
 *   - **Secret never leaves the server.** Comparison is timing-safe
 *     so an attacker probing the endpoint cannot recover the secret
 *     via byte-by-byte timing.
 *
 * Outside the happy path, every distinct failure mode (missing
 * headers, malformed signature, mismatch) returns the same `false`.
 * The controller maps all of them to a uniform 401 — leaking the
 * exact reason gives an attacker information they shouldn't have.
 */
@Injectable()
export class Auth0WebhookSignatureService {
  /** Default replay window. The controller may override at call time. */
  static readonly DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60;

  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /**
   * Returns true iff the signature header matches the body under the
   * configured secret AND the timestamp is within the replay window.
   * Returns false on any verification failure or missing config.
   */
  verify(input: VerifyInput): boolean {
    const secret = this.config.webhookSecret;
    if (!secret) return false;

    const { rawBody, signatureHeader, timestampHeader } = input;
    if (
      typeof signatureHeader !== 'string' ||
      signatureHeader.length === 0 ||
      typeof timestampHeader !== 'string' ||
      timestampHeader.length === 0
    ) {
      return false;
    }

    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
      return false;
    }
    const window =
      input.replayWindowSeconds ??
      Auth0WebhookSignatureService.DEFAULT_REPLAY_WINDOW_SECONDS;
    const nowSec = input.nowMs !== undefined
      ? Math.floor(input.nowMs / 1000)
      : Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > window) return false;

    const expectedHex = createHmac('sha256', secret)
      .update(`${timestampHeader}.`)
      .update(rawBody)
      .digest('hex');
    return safeHexEqual(signatureHeader.toLowerCase(), expectedHex);
  }
}

export interface VerifyInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  /** Override for tests; defaults to `Date.now()`. */
  readonly nowMs?: number;
  /** Override for tests; defaults to DEFAULT_REPLAY_WINDOW_SECONDS. */
  readonly replayWindowSeconds?: number;
}

function safeHexEqual(a: string, b: string): boolean {
  // Both inputs are hex strings; their byte representations are the
  // same length only when the underlying digests match. timingSafeEqual
  // throws on length mismatch, so we guard explicitly first to keep
  // the false return path constant-time relative to the secret.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}
