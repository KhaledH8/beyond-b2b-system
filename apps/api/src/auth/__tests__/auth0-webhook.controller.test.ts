import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Auth0WebhookController } from '../webhook/auth0-webhook.controller';
import type { Auth0WebhookSignatureService } from '../webhook/auth0-webhook-signature.service';
import type { Auth0EventHandlerService } from '../webhook/auth0-event-handler.service';

/**
 * Verifies the controller's policy:
 *
 *   - Missing rawBody → 401 (deployment misconfig).
 *   - Signature service rejects → 401, handler not invoked.
 *   - Signature OK → handler called with parsed payload, summary
 *     returned with HTTP 200.
 *   - Body that passes signature but is non-JSON → returns a
 *     "malformed: 1" summary, no exception, no handler call.
 */

function makeReq(opts: {
  rawBody?: Buffer;
  signature?: string;
  timestamp?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined) {
    headers['x-auth0-webhook-signature'] = opts.signature;
  }
  if (opts.timestamp !== undefined) {
    headers['x-auth0-webhook-timestamp'] = opts.timestamp;
  }
  const req = { headers } as Request;
  if (opts.rawBody !== undefined) {
    (req as unknown as { rawBody: Buffer }).rawBody = opts.rawBody;
  }
  return req;
}

function makeSignatures(verifyResult: boolean): {
  svc: Auth0WebhookSignatureService;
  verify: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(() => verifyResult);
  return {
    svc: { verify } as unknown as Auth0WebhookSignatureService,
    verify,
  };
}

function makeHandler(): {
  svc: Auth0EventHandlerService;
  handleBatch: ReturnType<typeof vi.fn>;
} {
  const handleBatch = vi.fn(async () => ({
    received: 1,
    applied: 1,
    duplicates: 0,
    skipped: 0,
    malformed: 0,
  }));
  return {
    svc: { handleBatch } as unknown as Auth0EventHandlerService,
    handleBatch,
  };
}

describe('Auth0WebhookController.ingest', () => {
  it('throws Unauthorized when rawBody is missing', async () => {
    const sigs = makeSignatures(true);
    const handler = makeHandler();
    const ctl = new Auth0WebhookController(sigs.svc, handler.svc);
    const req = makeReq({ signature: 'a', timestamp: '1' });
    await expect(ctl.ingest(req)).rejects.toThrow(UnauthorizedException);
    expect(sigs.verify).not.toHaveBeenCalled();
    expect(handler.handleBatch).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when signature verification fails', async () => {
    const sigs = makeSignatures(false);
    const handler = makeHandler();
    const ctl = new Auth0WebhookController(sigs.svc, handler.svc);
    const req = makeReq({
      rawBody: Buffer.from('{}', 'utf8'),
      signature: 'bad',
      timestamp: '1',
    });
    await expect(ctl.ingest(req)).rejects.toThrow(UnauthorizedException);
    expect(handler.handleBatch).not.toHaveBeenCalled();
  });

  it('parses body and dispatches when signature is valid', async () => {
    const sigs = makeSignatures(true);
    const handler = makeHandler();
    const ctl = new Auth0WebhookController(sigs.svc, handler.svc);
    const body = Buffer.from('{"logs":[{"log_id":"x","type":"sd"}]}', 'utf8');
    const req = makeReq({
      rawBody: body,
      signature: 'sig',
      timestamp: '1762556400',
    });
    const summary = await ctl.ingest(req);
    expect(summary.applied).toBe(1);
    expect(handler.handleBatch).toHaveBeenCalledWith({
      logs: [{ log_id: 'x', type: 'sd' }],
    });
  });

  it('returns malformed: 1 when body parses fail post-signature', async () => {
    const sigs = makeSignatures(true);
    const handler = makeHandler();
    const ctl = new Auth0WebhookController(sigs.svc, handler.svc);
    const req = makeReq({
      rawBody: Buffer.from('not-json', 'utf8'),
      signature: 'sig',
      timestamp: '1',
    });
    const summary = await ctl.ingest(req);
    expect(summary.malformed).toBe(1);
    expect(handler.handleBatch).not.toHaveBeenCalled();
  });
});
