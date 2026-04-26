import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
} from '@nestjs/common';
import type { AdapterSupplierRate } from '@bb/supplier-contract';
import { SupplierAdapterRegistry } from '../adapter-registry';
import {
  ProvisionalMoneyMovementError,
  assertRateBookable,
} from '../../booking/booking-guard';
import { HotelbedsContentSyncService } from './content-sync.service';
import {
  loadHotelbedsConfig,
  type HotelbedsClientKind,
} from './hotelbeds.config';

/**
 * Internal/dev API seam for the Hotelbeds adapter.
 *
 * Two endpoints, deliberately kept thin:
 *   - POST /internal/suppliers/hotelbeds/content-sync — runs one
 *     content-sync pass through `HotelbedsContentSyncService` and
 *     returns the upsert counts.
 *   - POST /internal/suppliers/hotelbeds/search — runs an
 *     availability search through the adapter registry and returns
 *     a projection of every rate plus its bookability decision.
 *
 * The endpoints are mounted under `/internal/...` because they are a
 * dev-time and ops trigger surface, not a public API. They do NOT
 * authenticate, do NOT rate-limit, and do NOT live behind the future
 * public B2C/B2B controllers — those will be separate seams. This
 * controller will be moved behind an internal-only auth guard once
 * the auth module lands.
 *
 * What these endpoints intentionally do NOT do:
 *   - Book a rate. Selecting a rate from `/search` and proceeding to
 *     a booking saga is a Phase 2+ task. The booking guard refuses
 *     every PROVISIONAL rate and that is reflected on every response
 *     row's `isBookable: false` so callers cannot confuse "search
 *     returned a rate" with "this rate is sellable".
 *   - Run any pricing logic. `grossAmount` is the supplier net
 *     converted only by adapter-side normalization; the pricing
 *     evaluator (account-aware markup, taxes, promotions) is a
 *     separate module and not on this seam.
 *   - Touch authored-rate state. The Hotelbeds adapter is a sourced
 *     supplier and only writes to `offer_sourced_*` tables.
 */
@Controller('internal/suppliers/hotelbeds')
export class HotelbedsController {
  constructor(
    @Inject(SupplierAdapterRegistry)
    private readonly registry: SupplierAdapterRegistry,
    @Inject(HotelbedsContentSyncService)
    private readonly contentSync: HotelbedsContentSyncService,
  ) {}

  @Post('content-sync')
  async triggerContentSync(
    @Body() body: ContentSyncRequestBody,
  ): Promise<ContentSyncResponse> {
    const tenantId = requireString(body, 'tenantId');
    const pageSize = optionalPositiveInt(body.pageSize) ?? 50;
    const maxPages = optionalPositiveInt(body.maxPages) ?? 1;

    const result = await this.contentSync.run({
      ctx: { tenantId },
      pageSize,
      maxPages,
    });

    return {
      supplier: 'hotelbeds',
      clientKind: loadHotelbedsConfig().kind,
      tenantId,
      pagesFetched: result.pagesFetched,
      hotelsUpserted: result.hotelsUpserted,
    };
  }

  @Post('search')
  async triggerSearch(
    @Body() body: SearchRequestBody,
  ): Promise<SearchResponse> {
    const tenantId = requireString(body, 'tenantId');
    const supplierHotelId = requireString(body, 'supplierHotelId');
    const checkIn = requireDateString(body, 'checkIn');
    const checkOut = requireDateString(body, 'checkOut');
    const occupancy = requireOccupancy(body.occupancy);
    const currency = optionalString(body.currency);

    const adapter = this.registry.get('hotelbeds');
    const rates = await adapter.fetchRates(
      { tenantId },
      {
        supplierHotelId,
        checkIn,
        checkOut,
        occupancy,
        ...(currency !== undefined ? { currency } : {}),
      },
    );

    return {
      supplier: 'hotelbeds',
      clientKind: loadHotelbedsConfig().kind,
      tenantId,
      rateCount: rates.length,
      rates: rates.map(projectRate),
    };
  }
}

// -------------------------------------------------------------------------
// Response shaping
// -------------------------------------------------------------------------

/**
 * Project an `AdapterSupplierRate` to a stable, controller-friendly
 * shape. We deliberately surface `isBookable` + `bookingRefusalReason`
 * derived from `assertRateBookable`, so the response is honest about
 * the PROVISIONAL safeguard without callers having to interpret
 * `moneyMovementProvenance` themselves.
 */
function projectRate(rate: AdapterSupplierRate): SearchRateProjection {
  let isBookable = true;
  let bookingRefusalReason: string | undefined;
  try {
    assertRateBookable(rate);
  } catch (err) {
    if (err instanceof ProvisionalMoneyMovementError) {
      isBookable = false;
      bookingRefusalReason = err.message;
    } else {
      throw err;
    }
  }

  const projection: SearchRateProjection = {
    supplierRateId: rate.supplierRateId,
    supplierHotelId: rate.supplierHotelId,
    roomType: rate.roomType,
    ratePlan: rate.ratePlan,
    grossAmount: rate.grossAmount,
    grossCurrencySemantics: rate.grossCurrencySemantics,
    moneyMovement: rate.moneyMovement,
    moneyMovementProvenance: rate.moneyMovementProvenance,
    offerShape: rate.offerShape,
    rateBreakdownGranularity: rate.rateBreakdownGranularity,
    isBookable,
  };
  if (bookingRefusalReason !== undefined) {
    projection.bookingRefusalReason = bookingRefusalReason;
  }
  return projection;
}

// -------------------------------------------------------------------------
// Request DTOs
// -------------------------------------------------------------------------

interface ContentSyncRequestBody {
  readonly tenantId?: unknown;
  readonly pageSize?: unknown;
  readonly maxPages?: unknown;
}

interface SearchRequestBody {
  readonly tenantId?: unknown;
  readonly supplierHotelId?: unknown;
  readonly checkIn?: unknown;
  readonly checkOut?: unknown;
  readonly occupancy?: unknown;
  readonly currency?: unknown;
}

// -------------------------------------------------------------------------
// Response DTOs
// -------------------------------------------------------------------------

interface ContentSyncResponse {
  readonly supplier: 'hotelbeds';
  readonly clientKind: HotelbedsClientKind;
  readonly tenantId: string;
  readonly pagesFetched: number;
  readonly hotelsUpserted: number;
}

interface SearchResponse {
  readonly supplier: 'hotelbeds';
  readonly clientKind: HotelbedsClientKind;
  readonly tenantId: string;
  readonly rateCount: number;
  readonly rates: ReadonlyArray<SearchRateProjection>;
}

interface SearchRateProjection {
  readonly supplierRateId: string;
  readonly supplierHotelId: string;
  readonly roomType: string;
  readonly ratePlan: string;
  readonly grossAmount: AdapterSupplierRate['grossAmount'];
  readonly grossCurrencySemantics: AdapterSupplierRate['grossCurrencySemantics'];
  readonly moneyMovement: AdapterSupplierRate['moneyMovement'];
  readonly moneyMovementProvenance: AdapterSupplierRate['moneyMovementProvenance'];
  readonly offerShape: AdapterSupplierRate['offerShape'];
  readonly rateBreakdownGranularity: AdapterSupplierRate['rateBreakdownGranularity'];
  readonly isBookable: boolean;
  bookingRefusalReason?: string;
}

// -------------------------------------------------------------------------
// Hand-rolled validators (no class-validator dep — stays minimal).
// -------------------------------------------------------------------------

function requireString(obj: object, key: string): string {
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new BadRequestException(`Missing required string field: ${key}`);
  }
  return v;
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new BadRequestException(`Expected string, got ${typeof v}`);
  }
  return v;
}

function optionalPositiveInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new BadRequestException(`Expected positive integer, got ${String(v)}`);
  }
  return v;
}

function requireDateString(obj: object, key: string): string {
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException(`${key} must be a YYYY-MM-DD string`);
  }
  return v;
}

function requireOccupancy(v: unknown): {
  adults: number;
  children: number;
  childAges?: number[];
} {
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
  const childAges = childAgesRaw.map((age, i) => {
    if (typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 17) {
      throw new BadRequestException(
        `occupancy.childAges[${i}] must be an integer 0..17`,
      );
    }
    return age;
  });
  if (childAges.length !== children) {
    throw new BadRequestException(
      `occupancy.childAges length (${childAges.length}) must equal occupancy.children (${children})`,
    );
  }
  return { adults, children, childAges };
}
