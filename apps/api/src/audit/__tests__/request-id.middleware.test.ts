import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { RequestIdMiddleware } from '../request-id.middleware';
import { getRequestContext } from '../request-context';

/**
 * Unit tests for RequestIdMiddleware (ADR-028 D6 / Step 5).
 *
 * Verifies:
 *   A) ULID generation — minted when header absent or invalid.
 *   B) Header pass-through — valid ULID in X-Request-Id is accepted.
 *   C) Response header — X-Request-Id is echoed on the response.
 *   D) AsyncLocalStorage — requestId is visible inside next().
 *   E) IP and user-agent extraction.
 */

// Valid 26-char Crockford base32 string (all-zeros ULID is technically
// valid in our format check — it satisfies the alphabet and length).
const VALID_REQUEST_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
// Invalid: contains 'I' which is excluded from Crockford base32.
const INVALID_REQUEST_ID = 'IIIIIIIIIIIIIIIIIIIIIIIII1';
// Too short.
const SHORT_REQUEST_ID = 'TOOSHORT';

function makeReq(opts: {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  xForwardedFor?: string;
} = {}): Request {
  return {
    headers: {
      ...(opts.requestId !== undefined ? { 'x-request-id': opts.requestId } : {}),
      ...(opts.userAgent !== undefined ? { 'user-agent': opts.userAgent } : {}),
      ...(opts.xForwardedFor !== undefined ? { 'x-forwarded-for': opts.xForwardedFor } : {}),
    },
    ip: opts.ip,
    socket: { remoteAddress: opts.ip },
  } as unknown as Request;
}

function makeRes(): { setHeader: ReturnType<typeof vi.fn>; _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  const setHeader = vi.fn((name: string, value: string) => { _headers[name] = value; });
  return { setHeader, _headers } as unknown as ReturnType<typeof makeRes>;
}

// ── A) ULID generation ────────────────────────────────────────────────

describe('RequestIdMiddleware — ULID generation', () => {
  const mw = new RequestIdMiddleware();
  const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  it('mints a new ULID when X-Request-Id header is absent', () => {
    const req = makeReq();
    const res = makeRes();
    let capturedId: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      capturedId = getRequestContext()?.requestId;
    });

    expect(capturedId).toBeDefined();
    expect(ULID_RE.test(capturedId!)).toBe(true);
  });

  it('mints a new ULID when X-Request-Id contains invalid characters', () => {
    const req = makeReq({ requestId: INVALID_REQUEST_ID });
    const res = makeRes();
    let capturedId: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      capturedId = getRequestContext()?.requestId;
    });

    expect(capturedId).not.toBe(INVALID_REQUEST_ID);
    expect(ULID_RE.test(capturedId!)).toBe(true);
  });

  it('mints a new ULID when X-Request-Id is too short', () => {
    const req = makeReq({ requestId: SHORT_REQUEST_ID });
    const res = makeRes();
    let capturedId: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      capturedId = getRequestContext()?.requestId;
    });

    expect(capturedId).not.toBe(SHORT_REQUEST_ID);
    expect(ULID_RE.test(capturedId!)).toBe(true);
  });
});

// ── B) Header pass-through ────────────────────────────────────────────

describe('RequestIdMiddleware — valid header pass-through', () => {
  it('accepts a valid 26-char Crockford base32 X-Request-Id', () => {
    const mw = new RequestIdMiddleware();
    const req = makeReq({ requestId: VALID_REQUEST_ID });
    const res = makeRes();
    let capturedId: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      capturedId = getRequestContext()?.requestId;
    });

    expect(capturedId).toBe(VALID_REQUEST_ID);
  });
});

// ── C) Response header ────────────────────────────────────────────────

describe('RequestIdMiddleware — response X-Request-Id header', () => {
  const mw = new RequestIdMiddleware();

  it('sets X-Request-Id on the response for a minted id', () => {
    const req = makeReq();
    const res = makeRes();
    let capturedId: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      capturedId = getRequestContext()?.requestId;
    });

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', capturedId);
  });

  it('echoes the passed-through id on the response', () => {
    const req = makeReq({ requestId: VALID_REQUEST_ID });
    const res = makeRes();

    mw.use(req, res as unknown as Response, () => { /* noop */ });

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', VALID_REQUEST_ID);
  });
});

// ── D) AsyncLocalStorage context ──────────────────────────────────────

describe('RequestIdMiddleware — AsyncLocalStorage context', () => {
  const mw = new RequestIdMiddleware();

  it('context is available inside next() and unavailable outside', () => {
    const req = makeReq();
    const res = makeRes();
    let insideCtx: ReturnType<typeof getRequestContext> = undefined;

    const outsideCtxBefore = getRequestContext();
    mw.use(req, res as unknown as Response, () => {
      insideCtx = getRequestContext();
    });
    const outsideCtxAfter = getRequestContext();

    expect(outsideCtxBefore).toBeUndefined();
    expect(insideCtx).toBeDefined();
    expect(insideCtx!.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Outside the run() callback the store has no entry for this "thread".
    expect(outsideCtxAfter).toBeUndefined();
  });

  it('initialises actorKind as ANONYMOUS', () => {
    const req = makeReq();
    const res = makeRes();
    let actorKind: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      actorKind = getRequestContext()?.actorKind;
    });

    expect(actorKind).toBe('ANONYMOUS');
  });
});

// ── E) IP and user-agent extraction ───────────────────────────────────

describe('RequestIdMiddleware — IP and user-agent', () => {
  const mw = new RequestIdMiddleware();

  it('extracts IP from X-Forwarded-For (first entry)', () => {
    const req = makeReq({ xForwardedFor: '203.0.113.5, 10.0.0.1' });
    const res = makeRes();
    let ip: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      ip = getRequestContext()?.ipAddress;
    });

    expect(ip).toBe('203.0.113.5');
  });

  it('falls back to req.ip when X-Forwarded-For absent', () => {
    const req = makeReq({ ip: '10.0.0.42' });
    const res = makeRes();
    let ip: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      ip = getRequestContext()?.ipAddress;
    });

    expect(ip).toBe('10.0.0.42');
  });

  it('captures user-agent from request header', () => {
    const req = makeReq({ userAgent: 'MyClient/2.0' });
    const res = makeRes();
    let ua: string | undefined;

    mw.use(req, res as unknown as Response, () => {
      ua = getRequestContext()?.userAgent;
    });

    expect(ua).toBe('MyClient/2.0');
  });
});
