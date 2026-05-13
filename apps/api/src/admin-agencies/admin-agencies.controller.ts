import {
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../auth/permissions/roles.guard';
import { RequirePermission } from '../auth/permissions/require-permission.decorator';
import { PERMISSIONS } from '../auth/permissions/permissions';
import {
  AgencySelectorService,
  type ListAgenciesResult,
} from './agency-selector.service';

/**
 * `GET /admin/agencies` — operator-facing agency selector for the
 * impersonation start flow (ADR-027 V1.1).
 *
 * Auth + permission contract:
 *   - `JwtAuthGuard`: human-user JWT required (NOT `InternalAuthGuard`).
 *   - `RolesGuard`  : default-deny gate from ADR-026 E3.
 *   - `IMPERSONATE_AGENCY_ACCOUNT`: same permission that gates
 *      `POST /impersonation/start`. Reuses the existing capability —
 *      no new permission introduced for V1.
 *
 * Tenant scope is sourced from `AuthContext.tenantId`, never from a
 * query parameter — so a manipulated request body cannot leak
 * cross-tenant accounts.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/agencies')
export class AdminAgenciesController {
  constructor(
    @Inject(AgencySelectorService)
    private readonly service: AgencySelectorService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)
  async list(
    @Auth() auth: AuthContext,
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<ListAgenciesResult> {
    const limit =
      limitRaw !== undefined && limitRaw !== ''
        ? Number(limitRaw)
        : undefined;
    return this.service.listAgencies({
      tenantId: auth.tenantId,
      q,
      limit,
    });
  }
}
