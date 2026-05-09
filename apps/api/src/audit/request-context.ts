import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request audit context, propagated via AsyncLocalStorage.
 *
 * Lifecycle:
 *   1. RequestIdMiddleware initialises the context at the HTTP entry
 *      layer with a fresh ULID request_id and ANONYMOUS actor kind.
 *   2. JwtAuthGuard calls setRequestActor() after a successful token
 *      validation + user sync to fill in the authenticated actor.
 *      (Step 6 wiring — not yet called in V1 skeleton; the guard will
 *      be retrofitted in the impersonation slice.)
 *   3. The impersonation guard (ADR-027) calls setImpersonationGrantId()
 *      when an active grant is present, so all audit events emitted
 *      during an impersonated request carry the grant reference.
 *
 * The stored object is mutable. Each middleware/guard layer may update
 * fields in-place. AuditService reads the store on every emit() /
 * emitInTransaction() call and stamps whatever is present at that
 * moment onto the event row.
 */
export interface RequestAuditContext {
  requestId: string;
  actorKind: 'USER' | 'API_CONSUMER' | 'INTERNAL' | 'ANONYMOUS';
  actorUserId?: string;
  actorApiKeyId?: string;
  actorLabel?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
  impersonationGrantId?: string;
}

export const requestContextStore =
  new AsyncLocalStorage<RequestAuditContext>();

/**
 * Returns the audit context for the current request, or undefined
 * when called outside the HTTP request lifecycle (cron, CLI, tests).
 */
export function getRequestContext(): RequestAuditContext | undefined {
  return requestContextStore.getStore();
}

/**
 * Updates actor fields on the current request's audit context.
 *
 * Called by JwtAuthGuard after successful authentication. No-op when
 * there is no active context (public endpoints without auth, calls
 * made outside the request lifecycle).
 */
export function setRequestActor(actor: {
  actorKind: 'USER' | 'API_CONSUMER' | 'INTERNAL' | 'ANONYMOUS';
  actorUserId?: string;
  actorApiKeyId?: string;
  actorLabel?: string;
  tenantId?: string;
}): void {
  const ctx = requestContextStore.getStore();
  if (!ctx) return;
  ctx.actorKind = actor.actorKind;
  if (actor.actorUserId !== undefined) ctx.actorUserId = actor.actorUserId;
  if (actor.actorApiKeyId !== undefined) ctx.actorApiKeyId = actor.actorApiKeyId;
  if (actor.actorLabel !== undefined) ctx.actorLabel = actor.actorLabel;
  if (actor.tenantId !== undefined) ctx.tenantId = actor.tenantId;
}

/**
 * Sets the impersonation grant ID on the current request's context.
 *
 * Called by the impersonation guard (ADR-027) when an active grant is
 * resolved for the request. All audit events emitted after this call
 * will carry the grant reference.
 */
export function setImpersonationGrantId(grantId: string): void {
  const ctx = requestContextStore.getStore();
  if (!ctx) return;
  ctx.impersonationGrantId = grantId;
}
