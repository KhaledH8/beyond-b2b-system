import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContextStore, type RequestAuditContext } from './request-context';
import { newUlid } from '../common/ulid';

/**
 * ADR-028 D6 / Step 5 — request-id middleware.
 *
 * Runs on every route before any guard or handler.
 *
 * Behaviour:
 *   1. Reads X-Request-Id from the incoming request header.
 *   2. Accepts the header value as the request_id ONLY if it is a
 *      valid 26-character Crockford base32 string (ULID format).
 *      Invalid or missing values are silently replaced with a freshly
 *      minted ULID. This prevents callers from injecting arbitrary
 *      strings into the audit log's request_id column.
 *   3. Writes X-Request-Id onto the response so callers can correlate
 *      their request with audit log entries.
 *   4. Initialises a per-request RequestAuditContext in AsyncLocalStorage
 *      with the resolved request_id, the anonymous actor kind (overwritten
 *      by JwtAuthGuard after authentication), IP, and user-agent.
 *   5. Calls next() inside AsyncLocalStorage.run() so the context is
 *      available to all downstream code on the same call stack —
 *      guards, interceptors, services, repositories.
 *
 * IP EXTRACTION:
 *   Prefers X-Forwarded-For when present (trusts the first entry in a
 *   comma-separated list as the originating client IP). Falls back to
 *   Express's req.ip and then the raw socket address. V1 does not
 *   validate that the proxy is trusted; that is a deployment-time
 *   concern (reverse proxy configuration).
 */

// Crockford base32 alphabet: 0–9, A–Z excluding I, L, O, U.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidUlidString(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function extractClientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') {
    const first = fwd.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  // Express sets req.ip from the socket or trust-proxy config.
  if (req.ip && req.ip.length > 0) return req.ip;
  return req.socket?.remoteAddress;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && isValidUlidString(incoming)
        ? incoming
        : newUlid();

    res.setHeader('X-Request-Id', requestId);

    const ctx: RequestAuditContext = {
      requestId,
      actorKind: 'ANONYMOUS',
      ipAddress: extractClientIp(req),
      userAgent:
        typeof req.headers['user-agent'] === 'string'
          ? req.headers['user-agent']
          : undefined,
    };

    requestContextStore.run(ctx, () => next());
  }
}
