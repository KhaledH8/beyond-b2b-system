import 'server-only';
import { apiFetch } from './api-client';

/**
 * ADR-027 Slice 3 — typed client for the impersonation HTTP surface.
 *
 * Three functions, each wrapping `apiFetch` (which owns bearer
 * attachment, `cache: 'no-store'`, request-id propagation, and the
 * typed error hierarchy). Callers in this app (server actions and
 * server components) never touch tokens — this module is server-only
 * by fence and consumes `apiFetch` only.
 *
 * Shapes mirror `apps/api/src/auth/impersonation/`:
 *   GET    /impersonation/active — `{ grant, target: { accountId, accountName } } | null`
 *   POST   /impersonation/start  — `{ targetAccountId, reasonText, ticketRef }`
 *                                  → `{ grantId, expiresAt, target: { accountId, accountName } }`
 *   POST   /impersonation/stop   — body `{}` → `{ ended: boolean }`
 */

// ── Wire types (must match the API exactly) ────────────────────────────

export interface ActiveImpersonationGrant {
  readonly id: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetAccountId: string;
  readonly reasonText: string;
  readonly ticketRef: string;
  readonly scope: 'READ_ONLY';
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endedReason: 'OPERATOR_ENDED' | 'EXPIRED' | 'ADMIN_REVOKED' | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface ActiveImpersonationResponse {
  readonly grant: ActiveImpersonationGrant;
  readonly target: {
    readonly accountId: string;
    readonly accountName: string;
  };
}

export interface StartImpersonationInput {
  readonly targetAccountId: string;
  readonly reasonText: string;
  readonly ticketRef: string;
}

export interface StartImpersonationResponse {
  readonly grantId: string;
  readonly expiresAt: string;
  readonly target: {
    readonly accountId: string;
    readonly accountName: string;
  };
}

export interface StopImpersonationResponse {
  readonly ended: boolean;
}

export interface AgencySummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface ListAgenciesResponse {
  readonly accounts: ReadonlyArray<AgencySummary>;
}

// ── Functions ──────────────────────────────────────────────────────────

/**
 * GET /impersonation/active.
 *
 * Returns the active grant joined to its target account name, or null
 * when no session is active. Used by the layout banner and the
 * `/impersonation` page. Safe to call on every render — `apiFetch`
 * hard-codes `cache: 'no-store'`.
 */
export async function getActiveImpersonation(): Promise<ActiveImpersonationResponse | null> {
  const body = await apiFetch<ActiveImpersonationResponse | null>(
    'GET',
    '/impersonation/active',
  );
  return body ?? null;
}

/**
 * POST /impersonation/start.
 *
 * Backend validates `ticketRef` and `reasonText` non-empty, target
 * existence + AGENCY + same tenant, and absence of an existing active
 * grant for this operator. Throws `ApiValidationError` (400),
 * `ApiForbiddenError` (403), `ApiConflictError` (409), etc., per the
 * typed hierarchy in `api-client.ts`.
 */
export async function startImpersonation(
  input: StartImpersonationInput,
): Promise<StartImpersonationResponse> {
  return apiFetch<StartImpersonationResponse>(
    'POST',
    '/impersonation/start',
    { body: input },
  );
}

/**
 * POST /impersonation/stop.
 *
 * Idempotent on the backend: returns `{ ended: false }` when no grant
 * was active. Body is the empty object to satisfy the server's JSON
 * content-type expectations.
 */
export async function stopImpersonation(): Promise<StopImpersonationResponse> {
  return apiFetch<StopImpersonationResponse>(
    'POST',
    '/impersonation/stop',
    { body: {} },
  );
}

/**
 * GET /admin/agencies — operator-only agency selector (ADR-027 V1.1).
 *
 * Tenant-scoped on the backend (sourced from AuthContext, never from
 * query params). Returns only AGENCY accounts with status='ACTIVE'.
 * The backend caps `limit` at 50; values above that are silently
 * clamped.
 */
export async function listAgencies(
  q?: string,
  limit?: number,
): Promise<ListAgenciesResponse> {
  const params = new URLSearchParams();
  const trimmed = typeof q === 'string' ? q.trim() : '';
  if (trimmed !== '') params.set('q', trimmed);
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    params.set('limit', String(Math.floor(limit)));
  }
  const qs = params.toString();
  const path = qs ? `/admin/agencies?${qs}` : '/admin/agencies';
  const body = await apiFetch<ListAgenciesResponse>('GET', path);
  return body ?? { accounts: [] };
}
