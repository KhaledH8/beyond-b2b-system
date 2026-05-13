import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../auth/permissions/roles.guard';
import { RequirePermission } from '../auth/permissions/require-permission.decorator';
import { PERMISSIONS } from '../auth/permissions/permissions';
import { PermissionResolverService } from '../auth/permissions/permission-resolver.service';
import { AuditService } from '../audit/audit.service';
import {
  AuditEventService,
  type AuditEventView,
} from './audit-event.service';

interface ListResponse {
  readonly events: AuditEventView[];
  readonly nextCursor: string | null;
}

/**
 * `GET /admin/audit/events` — operator-facing audit-log LIST (ADR-028
 * D9, V1.0).
 *
 * Auth + permission contract:
 *   - `JwtAuthGuard`: human-user JWT required (NOT `InternalAuthGuard`).
 *   - `RolesGuard`  : default-deny gate from ADR-026 E3.
 *   - `AUDIT_READ`  : base permission required by every call.
 *   - `AUDIT_READ_SENSITIVE`: additionally required if the caller is
 *      explicitly filtering for `SENSITIVE_ACCESS` rows, OR — when the
 *      caller is reading without that filter — silently scopes the
 *      query to non-sensitive rows.
 *
 * Tenant scope is sourced from `AuthContext.tenantId`, never from a
 * query parameter — so a manipulated request body cannot leak
 * cross-tenant audit events.
 *
 * Every successful call emits a `SECURITY.AUDIT_QUERY_EXECUTED` audit
 * event via the background-queue path. Best-effort: the emission
 * itself never blocks the response. Per ADR-028 D9 we do NOT emit on
 * 4xx (rejected) calls.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/audit/events')
export class AdminAuditController {
  private readonly logger = new Logger(AdminAuditController.name);

  constructor(
    @Inject(AuditEventService)
    private readonly service: AuditEventService,
    @Inject(PermissionResolverService)
    private readonly resolver: PermissionResolverService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.AUDIT_READ)
  async list(
    @Auth() auth: AuthContext,
    @Query('category') category?: string,
    @Query('kind') kind?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('targetKind') targetKind?: string,
    @Query('targetId') targetId?: string,
    @Query('requestId') requestId?: string,
    @Query('impersonationGrantId') impersonationGrantId?: string,
    @Query('occurredFrom') occurredFrom?: string,
    @Query('occurredTo') occurredTo?: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListResponse> {
    const resolved = await this.resolver.resolve(auth);
    const canViewSensitive = resolved.permissions.has(
      PERMISSIONS.AUDIT_READ_SENSITIVE,
    );

    // Explicit sensitive-category request without the sensitive
    // permission is a privilege-escalation attempt — 403 before any DB
    // work and before the self-audit emission.
    if (category === 'SENSITIVE_ACCESS' && !canViewSensitive) {
      throw new ForbiddenException();
    }

    const limit =
      limitRaw !== undefined && limitRaw !== ''
        ? Number(limitRaw)
        : undefined;

    const result = await this.service.listEvents({
      tenantId: auth.tenantId,
      canViewSensitive,
      category,
      kind,
      actorUserId,
      targetKind,
      targetId,
      requestId,
      impersonationGrantId,
      occurredFrom,
      occurredTo,
      limit,
      cursor,
    });

    // Self-audit. Best-effort; failures must not affect the response.
    try {
      this.auditService.emit({
        category: 'SECURITY',
        kind: 'AUDIT_QUERY_EXECUTED',
        tenantId: auth.tenantId,
        payload: {
          endpoint: 'LIST',
          filters: result.appliedFilters,
          resultCount: result.events.length,
          requiredPermission: canViewSensitive
            ? 'AUDIT_READ_SENSITIVE'
            : 'AUDIT_READ',
        },
      });
    } catch (err) {
      // Defensive — emit() is already best-effort internally, but if
      // a synchronous misuse of the API throws, we still respond.
      this.logger.warn(
        `AUDIT_QUERY_EXECUTED emit failed: ${(err as Error).message ?? 'unknown'}`,
      );
    }

    return { events: result.events, nextCursor: result.nextCursor };
  }
}
