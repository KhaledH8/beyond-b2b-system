import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Auth, type AuthContext } from '../auth-context';
import { JwtAuthGuard } from '../jwt/jwt-auth.guard';
import { RolesGuard } from '../permissions/roles.guard';
import { RequirePermission } from '../permissions/require-permission.decorator';
import { PERMISSIONS } from '../permissions/permissions';
import {
  ImpersonationService,
  type StartImpersonationResult,
} from './impersonation.service';
import type { ImpersonationGrantRecord } from './impersonation-grant.repository';

interface StartBody {
  targetAccountId: string;
  reasonText: string;
  ticketRef: string;
}

/**
 * ADR-027 D10 — impersonation session management endpoints.
 *
 * All endpoints require JwtAuthGuard + RolesGuard. The start/stop/active
 * trio requires IMPERSONATE_AGENCY_ACCOUNT (held by platform_admin and
 * ops_support).
 *
 * During an active impersonation session the resolver explicitly keeps
 * IMPERSONATE_AGENCY_ACCOUNT in the permission set so stop/active remain
 * reachable even while the operator's context is AGENCY-shaped.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('impersonation')
export class ImpersonationController {
  constructor(private readonly service: ImpersonationService) {}

  /**
   * POST /impersonation/start — begin impersonating an agency account.
   *
   * Requires IMPERSONATE_AGENCY_ACCOUNT. Rejects if the operator
   * already has an active session (caller must stop first).
   *
   * Returns 201 { grantId, expiresAt, target: { accountId, accountName } }.
   */
  @Post('start')
  @RequirePermission(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)
  async start(
    @Auth() auth: AuthContext,
    @Body() body: StartBody,
  ): Promise<StartImpersonationResult> {
    if (auth.impersonation) {
      throw new ConflictException(
        'Already impersonating. Call POST /impersonation/stop first.',
      );
    }
    return this.service.startImpersonation({
      actorUserId: auth.userId,
      actorAuth0Sub: auth.auth0Sub,
      actorTenantId: auth.tenantId,
      targetAccountId: body.targetAccountId ?? '',
      reasonText: body.reasonText ?? '',
      ticketRef: body.ticketRef ?? '',
    });
  }

  /**
   * POST /impersonation/stop — end the caller's active session.
   *
   * Idempotent: returns { ended: false } when no session is active.
   * Returns 200 (not 201) — this is a state transition, not a resource
   * creation.
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)
  async stop(@Auth() auth: AuthContext): Promise<{ ended: boolean }> {
    return this.service.stopImpersonation(auth.userId, auth.tenantId);
  }

  /**
   * GET /impersonation/active — return the caller's active grant or null.
   *
   * Used by the operator UI to decide whether to render the persistent
   * banner (ADR-027 D11). Safe to poll; returns null when no session is
   * active.
   */
  @Get('active')
  @RequirePermission(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)
  async active(
    @Auth() auth: AuthContext,
  ): Promise<ImpersonationGrantRecord | null> {
    return this.service.getActiveGrant(auth.userId);
  }
}
