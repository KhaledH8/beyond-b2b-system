import type { PaginationCursor, TenantContext } from '@bb/domain';
import type {
  AdapterHotelPage,
  AdapterSupplierRate,
  BookConfirmation,
  BookRequest,
  CancelConfirmation,
  CancelRequest,
  RateRequest,
  SupplierAdapter,
} from '@bb/supplier-contract';
import type { HotelbedsClient } from './client';
import { HOTELBEDS_META } from './meta';
import { normalizeHotel } from './content-sync';
import { runSourcedSearchAndPersist } from './search';
import { HotelbedsNotImplementedError } from './errors';
import type {
  MappingPersistencePort,
  RawPayloadStoragePort,
  SourcedOfferPersistencePort,
  SupplierRegistrationPort,
  HotelContentPersistencePort,
} from './ports';
import type { HotelbedsMoneyMovementResolver } from './money-movement';

/**
 * Full Phase 1 dependency set for the Hotelbeds adapter.
 *
 * `registration` is called once at startup (`ensureRegistered`) and
 * writes the `supply_supplier` row. The other ports are side-effect
 * seams consumed on every search / content-sync run.
 *
 * `newSnapshotId` is injected because the adapter package has no
 * ULID/UUID dependency of its own (ADR-011: adapters depend only on
 * `@bb/domain` + `@bb/supplier-contract` + their provider SDK).
 */
export interface HotelbedsAdapterDeps {
  readonly client: HotelbedsClient;
  readonly registration: SupplierRegistrationPort;
  readonly rawStorage: RawPayloadStoragePort;
  readonly hotels: HotelContentPersistencePort;
  readonly offers: SourcedOfferPersistencePort;
  readonly mappings: MappingPersistencePort;
  /**
   * ADR-020: Hotelbeds-specific resolver for the per-rate money-
   * movement triple. Mandatory at composition-root wiring: the
   * operator must explicitly pick a resolver (provisional, static, or
   * payload-first). No silent default — leaving this unset would
   * force us back to the hardcoded-triple anti-pattern. See
   * `money-movement.ts` for the available factories.
   */
  readonly moneyMovementResolver: HotelbedsMoneyMovementResolver;
  readonly newSnapshotId: () => string;
  readonly newSearchSessionId: () => string;
}

/**
 * HotelbedsAdapter implements the ADR-003 `SupplierAdapter` contract.
 *
 * Phase 1 scope (this file):
 *   - fetchHotels: pure projection of Hotelbeds content API into
 *     `AdapterHotelPage`. Content-sync orchestration (writes to
 *     `hotel_supplier`) lives in `content-sync.ts` and is invoked
 *     by a worker, not by the contract caller.
 *   - fetchRates: orchestrates the full ADR-021 sourced-search write
 *     path: raw payload → `offer_sourced_snapshot` + children →
 *     mapping observation rows → flat rate projection.
 *   - book / cancel: not implemented in Phase 1. They throw
 *     `HotelbedsNotImplementedError`.
 *
 * Booking confirmation, payment orchestration, and the booking saga
 * are explicitly out of scope for this scaffold (see TASKS.md and the
 * amending message that defined this step's boundaries).
 */
export class HotelbedsAdapter implements SupplierAdapter {
  readonly meta = HOTELBEDS_META;

  constructor(private readonly deps: HotelbedsAdapterDeps) {}

  /**
   * Idempotent bootstrap. Call from the composition root on startup
   * so `supply_supplier` has a row to reference before any FK writes.
   */
  async ensureRegistered(): Promise<void> {
    await this.deps.registration.upsertSupplier({
      supplierId: this.meta.supplierId,
      displayName: this.meta.displayName,
      ingestionMode: this.meta.ingestionMode,
    });
  }

  async fetchHotels(
    _ctx: TenantContext,
    page: PaginationCursor,
  ): Promise<AdapterHotelPage> {
    const response = await this.deps.client.listHotels({
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      pageSize: page.pageSize ?? 100,
    });

    return {
      hotels: response.parsed.hotels.map(normalizeHotel),
      ...(response.parsed.nextCursor !== undefined
        ? { nextCursor: response.parsed.nextCursor }
        : {}),
    };
  }

  async fetchRates(
    ctx: TenantContext,
    req: RateRequest,
  ): Promise<ReadonlyArray<AdapterSupplierRate>> {
    const { rates } = await runSourcedSearchAndPersist(
      {
        client: this.deps.client,
        rawStorage: this.deps.rawStorage,
        offers: this.deps.offers,
        mappings: this.deps.mappings,
        moneyMovementResolver: this.deps.moneyMovementResolver,
      },
      {
        ctx,
        searchSessionId: this.deps.newSearchSessionId(),
        request: req,
        newSnapshotId: this.deps.newSnapshotId,
      },
    );
    return rates;
  }

  book(_ctx: TenantContext, _req: BookRequest): Promise<BookConfirmation> {
    return Promise.reject(new HotelbedsNotImplementedError('book'));
  }

  cancel(_ctx: TenantContext, _req: CancelRequest): Promise<CancelConfirmation> {
    return Promise.reject(new HotelbedsNotImplementedError('cancel'));
  }
}
