import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { INTERNAL_ACTOR_KEY, type InternalActor } from './internal-actor';

const KEY_HEADER = 'x-internal-key';
const ACTOR_ID_HEADER = 'x-actor-id';

/**
 * Guards all /internal/... routes with a shared API key.
 *
 * Reads INTERNAL_API_KEY once at construction (fail-fast if absent).
 * Checks X-Internal-Key on every request; rejects with 401 if missing
 * or wrong. Attaches InternalActor to the request so controllers can
 * retrieve it via the @Actor() decorator.
 *
 * Applied at the controller class level on MarkupRuleAdminController,
 * PromotionAdminController, and HotelbedsController.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly expectedKey: string;

  constructor() {
    const key = process.env['INTERNAL_API_KEY'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        'INTERNAL_API_KEY env var must be a non-empty string — set it before starting the server',
      );
    }
    this.expectedKey = key;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.headers[KEY_HEADER];
    if (typeof provided !== 'string' || provided !== this.expectedKey) {
      throw new UnauthorizedException(
        'Missing or invalid X-Internal-Key header',
      );
    }
    const actorId =
      typeof req.headers[ACTOR_ID_HEADER] === 'string'
        ? (req.headers[ACTOR_ID_HEADER] as string)
        : 'anonymous';
    const actor: InternalActor = { actorId, source: 'INTERNAL_API_KEY' };
    (req as unknown as Record<symbol, unknown>)[INTERNAL_ACTOR_KEY] = actor;
    return true;
  }
}
