import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { SearchRequest, SearchResponse } from '@bb/domain';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../auth/permissions/roles.guard';
import { RequirePermission } from '../auth/permissions/require-permission.decorator';
import { PERMISSIONS } from '../auth/permissions/permissions';
import { Auth, type AuthContext } from '../auth/auth-context';
import { SearchService } from './search.service';

/**
 * Public-shape search endpoint — channel-aware, sourced-only.
 *
 * The endpoint lives at `/search` rather than `/internal/...` because
 * its response IS the contract a downstream UI / API consumer renders
 * (B2B portal, B2C OTA, agency console).
 *
 * **Auth (ADR-026 Slices E4-A + E4-B).**
 *
 *   `@UseGuards(JwtAuthGuard, RolesGuard)` + `@RequirePermission(...)`
 *
 *   - `JwtAuthGuard` runs first to validate the bearer token, sync
 *     the user, and attach `AuthContext` to the request.
 *   - `RolesGuard` runs second, reads `AuthContext`, resolves roles
 *     from the DB, and checks the required permission — default-deny.
 *
 *   This is the canonical retrofit pattern for human-user endpoints.
 *   `/internal/*` routes continue to use `InternalAuthGuard` and are
 *   not part of this pattern.
 *
 * Permission rationale: `search.execute` is the agency-side gate
 * (held by `account_admin`, `booker`, `finance`). Operator users do
 * not have it on the role matrix; `platform_admin` holds every
 * permission per the locked D8 rule and would otherwise pass the
 * `RolesGuard` check — but the body-reconciliation gate below denies
 * operator-as-self search regardless. An operator who needs to inspect
 * search results uses the future impersonation flow (E8).
 *
 * **Body reconciliation (ADR-026 Slice E4-B):**
 *
 *   `tenantId` and `accountId` are derived from `AuthContext`, NOT
 *   trusted from the body. The body fields are accepted as legacy
 *   inputs and validated for equality:
 *
 *     - AGENCY user: `body.tenantId` (if present) must equal
 *       `auth.tenantId`; `body.accountId` (if present) must equal
 *       `auth.accountId`. Mismatch → 403, no detail body, reason
 *       logged at warn.
 *     - OPERATOR user: 403 with a policy message ("operator search
 *       requires impersonation; not supported in V1"). Even when the
 *       operator role holds `SEARCH_EXECUTE` (`platform_admin`), they
 *       cannot search as themselves — they have no `accountId`, and
 *       the search engine is account-scoped.
 *
 *   Failure mode is uniformly 403, never 400. A foreign `accountId`
 *   in a well-formed body is an authorization concern (this identity
 *   cannot search that account), not a body-shape concern. Returning
 *   400 would mislead clients into "fix the body" when the right fix
 *   is "use a different identity."
 *
 *   Body fields are now optional. A future SDK / UI client should
 *   simply omit `tenantId` and `accountId` and let the server fill
 *   them from the JWT.
 *
 * Body shape mirrors `SearchRequest` from `@bb/domain` so any future
 * SDK / type-share stays single-sourced. Validation is hand-rolled
 * to avoid a class-validator runtime dependency for what is a small,
 * well-typed surface.
 *
 * Booking, payment, and authored-rate concerns are out of scope here.
 * Every priced rate carries an honest `isBookable`/`bookingRefusalReason`
 * derived from the booking guard so callers cannot conflate "search
 * returned a price" with "this rate is sellable now."
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('search')
export class SearchController {
  private readonly logger = new Logger(SearchController.name);

  constructor(
    @Inject(SearchService)
    private readonly service: SearchService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.SEARCH_EXECUTE)
  async search(
    @Body() body: unknown,
    @Auth() auth: AuthContext,
  ): Promise<SearchResponse> {
    if (auth.userClass === 'OPERATOR') {
      // The role matrix lets `platform_admin` pass `SEARCH_EXECUTE`,
      // but operator-as-self search is unsupported in V1. The
      // impersonation flow (E8) will produce a synthetic AGENCY-shaped
      // AuthContext and this branch will then be skipped naturally.
      this.logger.warn(
        `Operator search blocked: userId=${auth.userId} (impersonation not yet supported)`,
      );
      throw new ForbiddenException(
        'Operator search requires impersonation; not supported in V1 (ADR-026 E8)',
      );
    }

    // Defensive: AuthContext invariants (E2-A + E3-A) say AGENCY users
    // always carry a non-empty accountId once PermissionResolverService
    // has run. The check is cheap and turns a Nest internal 500 into a
    // clean 403 if some future code path produces a malformed
    // AuthContext.
    if (
      typeof auth.accountId !== 'string' ||
      auth.accountId.length === 0
    ) {
      this.logger.warn(
        `AGENCY AuthContext missing accountId: userId=${auth.userId}`,
      );
      throw new ForbiddenException();
    }

    const parsed = parseSearchBody(body);
    if (
      parsed.bodyTenantId !== null &&
      parsed.bodyTenantId !== auth.tenantId
    ) {
      this.logger.warn(
        `tenantId mismatch on /search: userId=${auth.userId} body=${parsed.bodyTenantId} auth=${auth.tenantId}`,
      );
      throw new ForbiddenException();
    }
    if (
      parsed.bodyAccountId !== null &&
      parsed.bodyAccountId !== auth.accountId
    ) {
      this.logger.warn(
        `accountId mismatch on /search: userId=${auth.userId} body=${parsed.bodyAccountId} auth=${auth.accountId}`,
      );
      throw new ForbiddenException();
    }

    const request: SearchRequest = {
      tenantId: auth.tenantId,
      accountId: auth.accountId,
      supplierHotelIds: parsed.supplierHotelIds,
      checkIn: parsed.checkIn,
      checkOut: parsed.checkOut,
      occupancy: parsed.occupancy,
      ...(parsed.currency !== undefined ? { currency: parsed.currency } : {}),
      ...(parsed.displayCurrency !== undefined
        ? { displayCurrency: parsed.displayCurrency }
        : {}),
    };
    return this.service.search(request);
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled body validator (no class-validator dep)
// ---------------------------------------------------------------------------

interface ParsedSearchBody {
  /**
   * Optional legacy `body.tenantId`. The controller validates this
   * against `AuthContext.tenantId`; the search engine receives the
   * AuthContext value, never the body value.
   */
  readonly bodyTenantId: string | null;
  readonly bodyAccountId: string | null;
  readonly supplierHotelIds: ReadonlyArray<string>;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: SearchRequest['occupancy'];
  readonly currency?: string;
  readonly displayCurrency?: string;
}

function parseSearchBody(body: unknown): ParsedSearchBody {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const o = body as Record<string, unknown>;
  return {
    bodyTenantId: optionalNonEmptyString(o, 'tenantId'),
    bodyAccountId: optionalNonEmptyString(o, 'accountId'),
    supplierHotelIds: requireStringArray(o, 'supplierHotelIds', 1, 50),
    checkIn: requireDateString(o, 'checkIn'),
    checkOut: requireDateString(o, 'checkOut'),
    occupancy: requireOccupancy(o['occupancy']),
    ...(typeof o['currency'] === 'string'
      ? { currency: o['currency'] }
      : {}),
    ...(typeof o['displayCurrency'] === 'string'
      ? { displayCurrency: requireCurrencyCode(o['displayCurrency']) }
      : {}),
  };
}

function optionalNonEmptyString(
  o: Record<string, unknown>,
  key: string,
): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length === 0) {
    throw new BadRequestException(
      `${key} must be a non-empty string when present`,
    );
  }
  return v;
}

function requireCurrencyCode(v: string): string {
  if (!/^[A-Z]{3}$/.test(v)) {
    throw new BadRequestException(
      'displayCurrency must be a 3-letter uppercase ISO 4217 code',
    );
  }
  return v;
}

function requireStringArray(
  o: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): ReadonlyArray<string> {
  const v = o[key];
  if (
    !Array.isArray(v) ||
    v.length < min ||
    v.length > max ||
    !v.every((x) => typeof x === 'string' && x.length > 0)
  ) {
    throw new BadRequestException(
      `${key} must be a non-empty array (size ${min}..${max}) of non-empty strings`,
    );
  }
  return v as string[];
}

function requireDateString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException(`${key} must be a YYYY-MM-DD string`);
  }
  return v;
}

function requireOccupancy(v: unknown): SearchRequest['occupancy'] {
  if (typeof v !== 'object' || v === null) {
    throw new BadRequestException('occupancy must be an object');
  }
  const o = v as Record<string, unknown>;
  const adults = o['adults'];
  const children = o['children'];
  if (
    typeof adults !== 'number' ||
    !Number.isInteger(adults) ||
    adults < 1 ||
    adults > 10
  ) {
    throw new BadRequestException('occupancy.adults must be an integer 1..10');
  }
  if (
    typeof children !== 'number' ||
    !Number.isInteger(children) ||
    children < 0 ||
    children > 10
  ) {
    throw new BadRequestException('occupancy.children must be an integer 0..10');
  }
  const childAgesRaw = o['childAges'];
  if (childAgesRaw === undefined || childAgesRaw === null) {
    return { adults, children };
  }
  if (!Array.isArray(childAgesRaw)) {
    throw new BadRequestException('occupancy.childAges must be an array of integers');
  }
  if (childAgesRaw.length !== children) {
    throw new BadRequestException(
      `occupancy.childAges length (${childAgesRaw.length}) must equal occupancy.children (${children})`,
    );
  }
  const childAges = childAgesRaw.map((age, i) => {
    if (typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 17) {
      throw new BadRequestException(
        `occupancy.childAges[${i}] must be an integer 0..17`,
      );
    }
    return age;
  });
  return { adults, children, childAges };
}
