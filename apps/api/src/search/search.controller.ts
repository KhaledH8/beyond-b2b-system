import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
} from '@nestjs/common';
import type { SearchRequest, SearchResponse } from '@bb/domain';
import { SearchService } from './search.service';

/**
 * Public-shape search endpoint — channel-aware, sourced-only.
 *
 * The endpoint lives at `/search` rather than `/internal/...` because
 * its response IS the contract a downstream UI / API consumer renders
 * (B2B portal, B2C OTA, agency console). It does NOT yet authenticate
 * — that lands when the auth module ships and is intentionally
 * sequenced after the contract is stable.
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
@Controller('search')
export class SearchController {
  constructor(
    @Inject(SearchService)
    private readonly service: SearchService,
  ) {}

  @Post()
  async search(@Body() body: unknown): Promise<SearchResponse> {
    return this.service.search(parseRequest(body));
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled body validator (no class-validator dep)
// ---------------------------------------------------------------------------

function parseRequest(body: unknown): SearchRequest {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const o = body as Record<string, unknown>;
  return {
    tenantId: requireString(o, 'tenantId'),
    accountId: requireString(o, 'accountId'),
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

function requireCurrencyCode(v: string): string {
  if (!/^[A-Z]{3}$/.test(v)) {
    throw new BadRequestException(
      'displayCurrency must be a 3-letter uppercase ISO 4217 code',
    );
  }
  return v;
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new BadRequestException(`Missing required string field: ${key}`);
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
