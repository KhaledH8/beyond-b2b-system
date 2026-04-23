import type { TenantContext } from '@bb/domain';
import type { AdapterHotel, AdapterHotelPage } from '@bb/supplier-contract';
import type { HotelbedsClient, HotelbedsHotelRaw } from './client';
import type {
  HotelContentPersistencePort,
  RawPayloadStoragePort,
} from './ports';
import { HOTELBEDS_SUPPLIER_ID } from './meta';

/**
 * Normalize a raw Hotelbeds hotel into the contract-level AdapterHotel.
 * Deliberately minimal: Hotelbeds exposes a wider blob (descriptions,
 * facility codes, image URLs) that the content pipeline merges into
 * `hotel_canonical.content` via `packages/content/` — that is NOT the
 * adapter's job. The adapter only commits to the fields declared on
 * `AdapterHotel` and preserves the rest inside `raw_content` on
 * `hotel_supplier`.
 */
export function normalizeHotel(raw: HotelbedsHotelRaw): AdapterHotel {
  return {
    supplierHotelId: raw.code,
    name: raw.name,
    address: {
      line1: raw.address.content,
      city: raw.city.content,
      countryCode: raw.countryCode,
      ...(raw.address.postalCode !== undefined
        ? { postalCode: raw.address.postalCode }
        : {}),
    },
    ...(raw.coordinates
      ? { lat: raw.coordinates.latitude, lng: raw.coordinates.longitude }
      : {}),
    ...(raw.categoryCode ? { starRating: parseStarRating(raw.categoryCode) } : {}),
    ...(raw.chainCode ? { chainCode: raw.chainCode } : {}),
  };
}

/**
 * Hotelbeds encodes star rating as e.g. `3EST`, `4EST`, `5EST`.
 * Return the integer when the code fits that shape; return undefined
 * for apartment / unrated / non-numeric codes rather than guessing.
 */
function parseStarRating(categoryCode: string): number | undefined {
  const match = /^(\d)EST/.exec(categoryCode);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

export interface ContentSyncRunInput {
  readonly ctx: TenantContext;
  readonly pageSize: number;
  /** Optional upper bound on pages to pull in one run (safety). */
  readonly maxPages?: number;
}

export interface ContentSyncRunOutput {
  readonly pagesFetched: number;
  readonly hotelsUpserted: number;
}

/**
 * Orchestrates a content-sync run end-to-end.
 *
 * Per page:
 *   1. fetch raw hotels from Hotelbeds
 *   2. store the raw payload in object storage (ADR-003)
 *   3. upsert `hotel_supplier` rows (idempotent on (supplier_id, code))
 *   4. continue to the next cursor
 *
 * No writes to `hotel_canonical`, `hotel_mapping`, or pricing state.
 * Mapping deterministic-match is a Phase 1 `packages/mapping/` task.
 * Static content merge into canonical is a `packages/content/` task.
 */
export async function runHotelContentSync(
  deps: {
    readonly client: HotelbedsClient;
    readonly rawStorage: RawPayloadStoragePort;
    readonly hotels: HotelContentPersistencePort;
  },
  input: ContentSyncRunInput,
): Promise<ContentSyncRunOutput> {
  const { client, rawStorage, hotels } = deps;
  const { ctx, pageSize, maxPages } = input;

  let cursor: string | undefined;
  let pagesFetched = 0;
  let hotelsUpserted = 0;

  while (maxPages === undefined || pagesFetched < maxPages) {
    const response = await client.listHotels({
      ...(cursor !== undefined ? { cursor } : {}),
      pageSize,
    });

    const rawPayload = await rawStorage.put({
      tenantId: ctx.tenantId,
      supplierId: HOTELBEDS_SUPPLIER_ID,
      purpose: 'HOTELS_PAGE',
      contentType: response.contentType,
      bytes: response.rawBytes,
    });

    const pageHotels: AdapterHotelPage = {
      hotels: response.parsed.hotels.map(normalizeHotel),
      ...(response.parsed.nextCursor !== undefined
        ? { nextCursor: response.parsed.nextCursor }
        : {}),
    };

    await hotels.upsertSupplierHotels(ctx, {
      hotels: pageHotels.hotels,
      rawPayload,
    });

    pagesFetched += 1;
    hotelsUpserted += pageHotels.hotels.length;

    if (!pageHotels.nextCursor) break;
    cursor = pageHotels.nextCursor;
  }

  return { pagesFetched, hotelsUpserted };
}
