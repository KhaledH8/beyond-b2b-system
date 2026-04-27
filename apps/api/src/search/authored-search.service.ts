import { Inject, Injectable } from '@nestjs/common';
import {
  AUTHORED_OFFER_SHAPE,
  evaluateAuthoredOffer,
  evaluateRestrictions,
  toMinorUnits,
  type AuthoredNightLine,
  type PriceableAuthoredOffer,
} from '@bb/pricing';
import type {
  AccountContext,
  MarkupRuleSnapshot,
  SearchResultRate,
} from '@bb/domain';
import {
  PgAuthoredSearchRepository,
  type BaseRateAssemblyRow,
  type CanonicalHotelLookup,
  type ChildAgeBandRow,
  type DirectSupplierHotelMappingRow,
  type OccupancySupplementAssemblyRow,
  type SeasonRow,
} from './authored-search.repository';

/**
 * Authored search assembly (ADR-021 / ADR-022 Phase A · Slice 5).
 *
 * Given a search request and the canonical hotels it resolves to,
 * fan out across active direct contracts for the tenant, assemble
 * `PriceableAuthoredOffer` inputs from `rate_auth_*` rows, evaluate
 * them through the pure `evaluateAuthoredOffer` composer, and return
 * one `SearchResultRate` per matching (contract, base rate) tuple
 * along with the supplier identifiers the merge layer needs.
 *
 * Slice scope:
 *   - Single-season stays only. A stay that does not fit entirely
 *     within one season produces no offer for that contract — the
 *     multi-season stitch is deferred until a real paper contract
 *     requires it.
 *   - Meal supplements are NOT applied. The current `SearchRequest`
 *     does not carry a target meal plan; meal upgrades land when the
 *     request shape extends to choose one. Meal supplement rows are
 *     therefore not loaded in this slice.
 *   - Restrictions (ADR-023 Phase B Slice B5): consulted via the
 *     pure `evaluateRestrictions`. Offers whose `(contract, season,
 *     rate_plan, room_type, stay)` scope matches a blocking row are
 *     dropped from the candidate set BEFORE pricing per ADR-023 D6.
 *     Cancellation policy resolution (Slice B6) is still deferred.
 *
 * Provenance + shape labelling (ADR-021): every emitted
 * `SearchResultRate` carries `offerShape = AUTHORED_PRIMITIVES`,
 * `rateBreakdownGranularity = 'AUTHORED_PRIMITIVES'`, and
 * `moneyMovementProvenance = 'CONFIG_RESOLVED'` — authored offers
 * are configured, never derived from a payload, and never
 * `PROVISIONAL`.
 */

export interface PricedAuthoredEntry {
  readonly result: SearchResultRate;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly supplierHotelCode: string;
  readonly supplierHotelId: string;
  readonly canonicalHotelId: string;
  readonly sellMinor: bigint;
}

@Injectable()
export class AuthoredSearchService {
  constructor(
    @Inject(PgAuthoredSearchRepository)
    private readonly repo: PgAuthoredSearchRepository,
  ) {}

  /**
   * Run the authored fan-out for one search request.
   *
   * `canonicalLookups` lists the canonical hotel ids the request's
   * supplier hotel codes resolved to; if the list is empty, the
   * service returns an empty array without any DB calls.
   */
  async assemble(args: {
    readonly canonicalLookups: ReadonlyArray<CanonicalHotelLookup>;
    readonly tenantId: string;
    readonly checkIn: string;
    readonly checkOut: string;
    readonly adults: number;
    readonly children: number;
    readonly childAges: ReadonlyArray<number>;
    readonly rules: ReadonlyArray<MarkupRuleSnapshot>;
    readonly ctx: AccountContext;
    /**
     * Single request-time clock value. Used both as the `effective`
     * filter bound when loading restrictions and as the `now`
     * argument to `evaluateRestrictions` so the two views agree.
     */
    readonly now: Date;
  }): Promise<ReadonlyArray<PricedAuthoredEntry>> {
    if (args.canonicalLookups.length === 0) return [];

    const canonicalIds = uniq(args.canonicalLookups.map((l) => l.canonicalHotelId));
    const contracts = await this.repo.findActiveContracts({
      tenantId: args.tenantId,
      canonicalHotelIds: canonicalIds,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
    });
    if (contracts.length === 0) return [];

    const contractIds = contracts.map((c) => c.contractId);
    const supplierIds = uniq(contracts.map((c) => c.supplierId));

    const [seasons, ageBands, directMappings] = await Promise.all([
      this.repo.findOverlappingSeasons(contractIds, args.checkIn, args.checkOut),
      this.repo.findChildAgeBands(contractIds),
      this.repo.findDirectSupplierHotelMappings(supplierIds, canonicalIds),
    ]);

    const nights = stayLengthInNights(args.checkIn, args.checkOut);
    if (nights <= 0) return [];

    // Slice 5 single-season constraint: pick the season per contract
    // that fully covers the stay. Any contract without one is skipped.
    const seasonByContract = new Map<string, SeasonRow>();
    for (const s of seasons) {
      if (s.dateFrom <= args.checkIn && s.dateTo >= addDaysIso(args.checkOut, -1)) {
        seasonByContract.set(s.contractId, s);
      }
    }
    const usableContractIds = contracts
      .filter((c) => seasonByContract.has(c.contractId))
      .map((c) => c.contractId);
    if (usableContractIds.length === 0) return [];

    const seasonIds = Array.from(seasonByContract.values()).map((s) => s.id);
    const [baseRates, occupancySupplements, restrictions] = await Promise.all([
      this.repo.findBaseRates(usableContractIds, seasonIds),
      this.repo.findOccupancySupplements(usableContractIds, seasonIds),
      this.repo.findActiveRestrictions({
        tenantId: args.tenantId,
        supplierIds: uniq(
          contracts
            .filter((c) => seasonByContract.has(c.contractId))
            .map((c) => c.supplierId),
        ),
        canonicalHotelIds: canonicalIds,
        contractIds: usableContractIds,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        now: args.now,
      }),
    ]);

    const supplementsByContractSeason = indexBy(
      occupancySupplements,
      (s) => `${s.contractId}::${s.seasonId}::${s.roomTypeId}::${s.ratePlanId}`,
    );
    const ageBandsByContract = groupBy(ageBands, (b) => b.contractId);

    const childBandIds = matchChildAgesToBands(
      args.children,
      args.childAges,
      ageBandsByContract,
    );

    const mappingByPair = new Map<string, DirectSupplierHotelMappingRow>();
    for (const m of directMappings) {
      mappingByPair.set(pair(m.supplierId, m.canonicalHotelId), m);
    }

    const out: PricedAuthoredEntry[] = [];
    for (const contract of contracts) {
      const season = seasonByContract.get(contract.contractId);
      if (!season) continue;
      const mapping = mappingByPair.get(
        pair(contract.supplierId, contract.canonicalHotelId),
      );
      const supplierHotelId = mapping?.supplierHotelId ?? '';
      const supplierHotelCode = mapping?.supplierHotelCode ?? contract.canonicalHotelId;
      const contractBands = childBandIds.get(contract.contractId) ?? [];

      const contractBaseRates = baseRates.filter(
        (br) => br.contractId === contract.contractId && br.seasonId === season.id,
      );
      for (const br of contractBaseRates) {
        if (!fitsCapacity(br, args.adults, args.children)) continue;

        // ADR-023 D6: restrictions evaluate BEFORE the pricing chain.
        // Offers that come back unavailable are dropped from the
        // candidate set (preferred behavior per Slice B5 brief).
        const availability = evaluateRestrictions({
          stay: { checkIn: args.checkIn, checkOut: args.checkOut },
          now: args.now,
          contractId: contract.contractId,
          seasonId: season.id,
          ratePlanId: br.ratePlanId,
          roomTypeId: br.roomTypeId,
          restrictions,
        });
        if (!availability.available) continue;

        const occSupplements = supplementsByContractSeason.get(
          `${contract.contractId}::${season.id}::${br.roomTypeId}::${br.ratePlanId}`,
        ) ?? [];
        const occPerNight = computeOccupancySupplementPerNight(
          occSupplements,
          {
            extraAdults: Math.max(0, args.adults - br.baseAdults),
            childBandIds: contractBands,
          },
        );

        const offer: PriceableAuthoredOffer = {
          supplierHotelId,
          currency: br.currency,
          checkIn: args.checkIn,
          checkOut: args.checkOut,
          nights: buildNightLines(
            args.checkIn,
            nights,
            br.amountMinorUnits,
            occPerNight,
          ),
        };
        const evaluated = evaluateAuthoredOffer(offer, args.rules, args.ctx);

        const supplierRateId = `${contract.contractId}:${br.id}`;
        const result: SearchResultRate = {
          supplierRateId,
          roomType: br.roomTypeName,
          ratePlan: br.ratePlanName,
          priceQuote: evaluated.priceQuote,
          trace: evaluated.trace,
          moneyMovementProvenance: 'CONFIG_RESOLVED',
          isBookable: true,
          offerShape: AUTHORED_OFFER_SHAPE,
          rateBreakdownGranularity: 'AUTHORED_PRIMITIVES',
          supplierRawRef: supplierRateId,
        };
        const sellMinor = toMinorUnits(
          evaluated.priceQuote.sellingPrice.amount,
          evaluated.priceQuote.sellingPrice.currency,
        );
        out.push({
          result,
          supplierId: contract.supplierId,
          supplierCode: contract.supplierCode,
          supplierHotelCode,
          supplierHotelId,
          canonicalHotelId: contract.canonicalHotelId,
          sellMinor,
        });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers (file-local; no Nest decorators)
// ---------------------------------------------------------------------------

function uniq<T>(arr: ReadonlyArray<T>): T[] {
  return Array.from(new Set(arr));
}

function pair(a: string, b: string): string {
  return `${a}::${b}`;
}

function indexBy<T>(
  arr: ReadonlyArray<T>,
  key: (x: T) => string,
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    const bucket = m.get(k);
    if (bucket) bucket.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function groupBy<T>(
  arr: ReadonlyArray<T>,
  key: (x: T) => string,
): Map<string, T[]> {
  return indexBy(arr, key);
}

function stayLengthInNights(checkIn: string, checkOut: string): number {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysIso(s: string, n: number): string {
  const d = parseIsoDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fitsCapacity(
  br: BaseRateAssemblyRow,
  adults: number,
  children: number,
): boolean {
  if (adults > br.maxAdults) return false;
  if (children > br.maxChildren) return false;
  if (adults + children > br.maxTotal) return false;
  return true;
}

function matchChildAgesToBands(
  childCount: number,
  childAges: ReadonlyArray<number>,
  ageBandsByContract: ReadonlyMap<string, ReadonlyArray<ChildAgeBandRow>>,
): Map<string, ReadonlyArray<string>> {
  const out = new Map<string, ReadonlyArray<string>>();
  if (childCount === 0 || childAges.length === 0) {
    for (const contractId of ageBandsByContract.keys()) {
      out.set(contractId, []);
    }
    return out;
  }
  for (const [contractId, bands] of ageBandsByContract.entries()) {
    const matched: string[] = [];
    for (const age of childAges) {
      const band = bands.find((b) => age >= b.ageMin && age <= b.ageMax);
      if (band) matched.push(band.id);
    }
    out.set(contractId, matched);
  }
  return out;
}

function computeOccupancySupplementPerNight(
  rows: ReadonlyArray<OccupancySupplementAssemblyRow>,
  ctx: { extraAdults: number; childBandIds: ReadonlyArray<string> },
): bigint {
  let total = 0n;

  if (ctx.extraAdults > 0) {
    const adultRows = rows
      .filter((r) => r.occupantKind === 'EXTRA_ADULT')
      .sort((a, b) => a.slotIndex - b.slotIndex);
    let used = 0;
    for (const r of adultRows) {
      if (used >= ctx.extraAdults) break;
      total += r.amountMinorUnits;
      used += 1;
    }
  }

  if (ctx.childBandIds.length > 0) {
    const childRows = rows.filter((r) => r.occupantKind === 'EXTRA_CHILD');
    for (const bandId of ctx.childBandIds) {
      const matchingRows = childRows
        .filter((r) => r.childAgeBandId === bandId)
        .sort((a, b) => a.slotIndex - b.slotIndex);
      const first = matchingRows[0];
      if (first) total += first.amountMinorUnits;
    }
  }

  return total;
}

function buildNightLines(
  checkIn: string,
  nights: number,
  basePerNight: bigint,
  occPerNight: bigint,
): ReadonlyArray<AuthoredNightLine> {
  const out: AuthoredNightLine[] = [];
  for (let i = 0; i < nights; i++) {
    out.push({
      stayDate: addDaysIso(checkIn, i),
      baseRateMinorUnits: basePerNight,
      occupancySupplementMinorUnits: occPerNight,
      mealSupplementMinorUnits: 0n,
    });
  }
  return out;
}
