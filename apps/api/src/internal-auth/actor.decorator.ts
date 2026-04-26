import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { INTERNAL_ACTOR_KEY, type InternalActor } from './internal-actor';

/**
 * Extracts the InternalActor from the current request.
 * Only defined on requests that passed InternalAuthGuard.
 *
 * Usage:
 *   async myHandler(@Actor() actor: InternalActor) { ... }
 */
export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): InternalActor => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req as unknown as Record<symbol, unknown>)[INTERNAL_ACTOR_KEY] as InternalActor;
  },
);
