/**
 * Identity record attached to every authenticated internal request.
 * Written by InternalAuthGuard; read via the @Actor() param decorator.
 */
export interface InternalActor {
  /** Value of the X-Actor-Id header, or 'anonymous' when absent. */
  readonly actorId: string;
  readonly source: 'INTERNAL_API_KEY';
}

/** Symbol used to stash the actor on the Express request object. */
export const INTERNAL_ACTOR_KEY = Symbol('internalActor');
