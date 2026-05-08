import {
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Auth0WebhookSignatureService } from './auth0-webhook-signature.service';
import {
  Auth0EventHandlerService,
  type HandleBatchSummary,
} from './auth0-event-handler.service';

/**
 * `POST /webhooks/auth0` — receives Auth0 Log Streams deliveries
 * (Slice E2-B).
 *
 * Locked behavior:
 *
 *   - **HMAC signature required.** Every delivery must carry
 *     `X-Auth0-Webhook-Signature` and `X-Auth0-Webhook-Timestamp`,
 *     verified by `Auth0WebhookSignatureService`. Any failure is a
 *     uniform 401 with no body — leaking the failure reason gives an
 *     attacker information about the verification logic.
 *
 *   - **Raw body required.** The HMAC is computed over the byte-exact
 *     request body, so the route relies on the raw-body capture
 *     installed in `main.ts` (Express `verify` callback into
 *     `req.rawBody`). If the raw body is missing — i.e., a deployment
 *     misconfigured the body parser — we fail the request closed.
 *
 *   - **Always return 200 on accepted delivery.** Auth0 retries on
 *     non-2xx; once the signature is verified and the batch has been
 *     handed to the handler, we return 200 even if individual entries
 *     were malformed. The handler logs and counts those internally
 *     (`summary.malformed`). This keeps Auth0 from retrying the whole
 *     batch on a single bad entry.
 *
 *   - **Not guarded by `JwtAuthGuard`.** The HMAC is the auth
 *     primitive for this endpoint. We do NOT also require a bearer
 *     token — Auth0's webhook side cannot mint one for us.
 */
@Controller('webhooks')
export class Auth0WebhookController {
  private readonly logger = new Logger(Auth0WebhookController.name);

  constructor(
    @Inject(Auth0WebhookSignatureService)
    private readonly signatures: Auth0WebhookSignatureService,
    @Inject(Auth0EventHandlerService)
    private readonly handler: Auth0EventHandlerService,
  ) {}

  @Post('auth0')
  @HttpCode(200)
  async ingest(@Req() req: Request): Promise<HandleBatchSummary> {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      this.logger.warn('Auth0 webhook delivered without raw body');
      throw new UnauthorizedException();
    }
    const sigHeader = headerString(req, 'x-auth0-webhook-signature');
    const tsHeader = headerString(req, 'x-auth0-webhook-timestamp');
    const ok = this.signatures.verify({
      rawBody,
      signatureHeader: sigHeader,
      timestampHeader: tsHeader,
    });
    if (!ok) {
      // Generic 401, no body, no detail. Auth0 will not retry on a
      // 401 (which is what we want when the secret is wrong) but
      // will retry on 5xx.
      throw new UnauthorizedException();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Malformed JSON post-signature is suspicious (the sender had
      // the secret) but not actionable. Accept and skip.
      this.logger.warn('Auth0 webhook signature OK but body is not JSON');
      return { received: 0, applied: 0, duplicates: 0, skipped: 0, malformed: 1 };
    }
    const summary = await this.handler.handleBatch(payload);
    this.logger.log(
      `Auth0 webhook batch: received=${summary.received} applied=${summary.applied} dup=${summary.duplicates} skip=${summary.skipped} bad=${summary.malformed}`,
    );
    return summary;
  }
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
