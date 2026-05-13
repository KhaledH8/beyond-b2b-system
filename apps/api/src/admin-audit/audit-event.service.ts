import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  AuditEventRepository,
  type AuditEventRow,
} from './audit-event.repository';
import { decodeCursor, encodeCursor } from './cursor';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const VALID_CATEGORIES = new Set([
  'APP',
  'AUTH',
  'IMPERSONATION',
  'SENSITIVE_ACCESS',
  'SECURITY',
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

/**
 * Public response event shape returned by the LIST API. Camel-cased,
 * with timestamps as ISO-8601 strings (not Date objects) so the JSON
 * response is stable across deployments.
 */
export interface AuditEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly schemaVersion: number;
  readonly category: string;
  readonly kind: string;
  readonly tenantId: string;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly actorLabel: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly requestId: string | null;
  readonly impersonationGrantId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly payload: unknown;
}

/**
 * Filter shape echoed back to the audit-emission payload for
 * `AUDIT_QUERY_EXECUTED`. Mirrors the input filter values exactly
 * (post-validation), so the audit row records what was actually
 * applied to the query.
 */
export interface AuditQueryFilterEcho {
  readonly category?: string;
  readonly kind?: string;
  readonly actorUserId?: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly impersonationGrantId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ListAuditEventsInput {
  readonly tenantId: string;
  /** True iff the caller's resolved permission set includes `AUDIT_READ_SENSITIVE`. */
  readonly canViewSensitive: boolean;
  readonly category?: string;
  readonly kind?: string;
  readonly actorUserId?: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly impersonationGrantId?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListAuditEventsResult {
  readonly events: AuditEventView[];
  readonly nextCursor: string | null;
  /**
   * Filter shape after validation, suitable for echoing into the
   * `AUDIT_QUERY_EXECUTED` payload. Returned alongside the result so
   * the controller emits the same shape that was actually applied.
   */
  readonly appliedFilters: AuditQueryFilterEcho;
}

@Injectable()
export class AuditEventService {
  constructor(
    @Inject(AuditEventRepository)
    private readonly repo: AuditEventRepository,
  ) {}

  async listEvents(input: ListAuditEventsInput): Promise<ListAuditEventsResult> {
    const v = this.validate(input);

    const fetched = await this.repo.listEvents({
      tenantId: input.tenantId,
      category: v.category,
      kind: v.kind,
      actorUserId: v.actorUserId,
      targetKind: v.targetKind,
      targetId: v.targetId,
      requestId: v.requestId,
      impersonationGrantId: v.impersonationGrantId,
      occurredFrom: v.occurredFrom,
      occurredTo: v.occurredTo,
      includeSensitive: input.canViewSensitive,
      cursor: v.cursor,
      limit: v.limit + 1, // fetch one extra to detect "has more"
    });

    const hasMore = fetched.length > v.limit;
    const pageRows = hasMore ? fetched.slice(0, v.limit) : fetched;
    const events = pageRows.map(toView);

    const last = events[events.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor(last.occurredAt, last.id)
        : null;

    return {
      events,
      nextCursor,
      appliedFilters: v.echo,
    };
  }

  // ── Internal: input validation + cursor decode + limit clamping ─────

  private validate(input: ListAuditEventsInput): {
    category?: string;
    kind?: string;
    actorUserId?: string;
    targetKind?: string;
    targetId?: string;
    requestId?: string;
    impersonationGrantId?: string;
    occurredFrom?: Date;
    occurredTo?: Date;
    limit: number;
    cursor?: { occurredAt: Date; id: string };
    echo: AuditQueryFilterEcho;
  } {
    const out: ReturnType<AuditEventService['validate']> = {
      limit: clampLimit(input.limit),
      echo: {},
    };

    if (input.category !== undefined && input.category !== '') {
      if (!VALID_CATEGORIES.has(input.category)) {
        throw new BadRequestException(
          `category must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
        );
      }
      out.category = input.category;
      out.echo = { ...out.echo, category: input.category };
    }

    if (input.kind !== undefined && input.kind !== '') {
      const trimmed = input.kind.trim();
      if (trimmed === '') {
        throw new BadRequestException('kind must not be empty');
      }
      out.kind = trimmed;
      out.echo = { ...out.echo, kind: trimmed };
    }

    if (input.actorUserId !== undefined && input.actorUserId !== '') {
      assertUlid('actorUserId', input.actorUserId);
      out.actorUserId = input.actorUserId;
      out.echo = { ...out.echo, actorUserId: input.actorUserId };
    }

    if (input.targetKind !== undefined && input.targetKind !== '') {
      out.targetKind = input.targetKind;
      out.echo = { ...out.echo, targetKind: input.targetKind };
    }
    if (input.targetId !== undefined && input.targetId !== '') {
      out.targetId = input.targetId;
      out.echo = { ...out.echo, targetId: input.targetId };
    }

    if (input.requestId !== undefined && input.requestId !== '') {
      assertUlid('requestId', input.requestId);
      out.requestId = input.requestId;
      out.echo = { ...out.echo, requestId: input.requestId };
    }

    if (
      input.impersonationGrantId !== undefined &&
      input.impersonationGrantId !== ''
    ) {
      assertUlid('impersonationGrantId', input.impersonationGrantId);
      out.impersonationGrantId = input.impersonationGrantId;
      out.echo = {
        ...out.echo,
        impersonationGrantId: input.impersonationGrantId,
      };
    }

    if (input.occurredFrom !== undefined && input.occurredFrom !== '') {
      out.occurredFrom = parseIsoDate('occurredFrom', input.occurredFrom);
      out.echo = { ...out.echo, from: out.occurredFrom.toISOString() };
    }
    if (input.occurredTo !== undefined && input.occurredTo !== '') {
      out.occurredTo = parseIsoDate('occurredTo', input.occurredTo);
      out.echo = { ...out.echo, to: out.occurredTo.toISOString() };
    }
    if (
      out.occurredFrom !== undefined &&
      out.occurredTo !== undefined &&
      out.occurredFrom > out.occurredTo
    ) {
      throw new BadRequestException(
        'occurredFrom must be <= occurredTo',
      );
    }

    if (input.cursor !== undefined && input.cursor !== '') {
      const decoded = decodeCursor(input.cursor);
      if (decoded === null) {
        throw new BadRequestException('cursor is invalid');
      }
      out.cursor = decoded;
    }

    return out;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const floored = Math.floor(raw);
  if (floored < MIN_LIMIT) return MIN_LIMIT;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

function assertUlid(field: string, value: string): void {
  if (!ULID_PATTERN.test(value)) {
    throw new BadRequestException(
      `${field} must be a 26-character Crockford-base32 ULID`,
    );
  }
}

function parseIsoDate(field: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO-8601 datetime`);
  }
  return d;
}

function toIsoString(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    occurredAt: toIsoString(row.occurred_at),
    recordedAt: toIsoString(row.recorded_at),
    schemaVersion: row.schema_version,
    category: row.category,
    kind: row.kind,
    tenantId: row.tenant_id,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    actorApiKeyId: row.actor_api_key_id,
    actorLabel: row.actor_label,
    targetKind: row.target_kind,
    targetId: row.target_id,
    requestId: row.request_id,
    impersonationGrantId: row.impersonation_grant_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    payload: row.payload,
  };
}
