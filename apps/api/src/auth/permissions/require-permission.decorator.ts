import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

/**
 * Marks a route handler with the permission(s) the caller must hold.
 *
 * Single permission:
 *   @RequirePermission(PERMISSIONS.BOOKING_CONFIRM_MANUAL)
 *
 * Multiple permissions (AND semantics — caller must hold every one):
 *   @RequirePermission(
 *     PERMISSIONS.LEDGER_READ,
 *     PERMISSIONS.LEDGER_ADJUST,
 *   )
 *
 * V1 supports only AND semantics. OR-style decorators ("either A or
 * B") are not used by ADR-026 D8's matrix and are deferred — adding
 * them later is a typesafe extension, not a breaking change.
 *
 * RolesGuard reads this metadata. An endpoint that uses RolesGuard
 * without `@RequirePermission` is treated as a misconfiguration and
 * rejected: ADR-026 D8 default-deny means "no declared permission =
 * 403" is the safer failure mode than silent allow.
 */
export const REQUIRE_PERMISSION_KEY = 'auth:require-permission' as const;

export const RequirePermission = (
  ...permissions: readonly Permission[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permissions);
