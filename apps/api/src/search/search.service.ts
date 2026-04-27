import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { evaluateSourcedOffer, toMinorUnits } from '@bb/pricing';
import type {
  AccountContext,
  MarkupRuleSnapshot,
  PromotionTag,
  SearchRequest,
  SearchResponse,
  SearchResultHotel,
  SearchResultRate,
} from '@bb/domain';
import type { AdapterSupplierRate } from '@bb/supplier-contract';
import { SupplierAdapterRegistry } from '../adapters/adapter-registry';
import { newUlid } from '../common/ulid';
import {
  ProvisionalMoneyMovementError,
  assertRateBookable,
} from '../booking/booking-guard';
import { PgAccountRepository } from './account.repository';
import { PgHotelSupplierRepository } from './hotel-supplier.repository';
import { PgMarkupRuleRepository } from './markup-rule.repository';
import { PgPromotionRepository } from './promotion.repository';
import { PgAuthoredSearchRepository } from './authored-search.repository';
import {
  AuthoredSearchService,
  type PricedAuthoredEntry,
} from './authored-search.service';

/**
 * Channel-aware search orchestrator.
 *
 * Pipeline per request:
 *   1. Resolve `accountId` → `(tenantId, accountType)`.
 *   2. Trigger the supplier adapter (Hotelbeds for now) which
 *      returns `AdapterSupplierRate[]` AND persists the underlying
 *      `offer_sourced_snapshot` rows.
 *   3. Translate the supplier hotel codes the adapter returned into
 *      `hotel_supplier.id` ULIDs (used by HOTEL-scope rules and
 *      promotions); separately resolve canonical hotel ids via
 *      `hotel_mapping` for authored fan-out + cross-supplier
 *      correlation in the response.
 *   4. Load applicable markup rules + promotions from Postgres.
 *   5. Evaluate sourced rates via the pure `@bb/pricing`
 *      `evaluateSourcedOffer`. `createProvisionalResolver` is still
 *      in place upstream, so every sourced rate carries
 *      `moneyMovementProvenance = PROVISIONAL` and the booking guard
 *      refuses it. The response surfaces this explicitly.
 *   6. Run the authored fan-out (`AuthoredSearchService`) for the
 *      same canonical hotels. Authored offers are non-provisional
 *      (`CONFIG_RESOLVED`) and bookable; ADR-023 restrictions and
 *      cancellation policies are deferred to Phase B and are NOT
 *      consulted here.
 *   7. Merge sourced + authored entries, group by
 *      `(supplierId, supplierHotelCode)`, attach promotion tags,
 *      sort by cheapest selling price. When multiple currencies are
 *      present (e.g. sourced in EUR + authored in AED), rates sort
 *      alphabetically by currency code first — no FX conversion is
 *      performed. `meta.currencies` reports the full observed set.
 *
 * Pricing is the only step that mutates rate amounts. Merchandising
 * runs after and only attaches a tag — it never reorders past the
 * price-ascending baseline. CLAUDE.md invariant respected.
 *
 * Sourced rates retain their existing PROVISIONAL guarantee; authored
 * rates are added as additional results, never overwriting or
 * replacing sourced ones for the same hotel.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(SupplierAdapterRegistry)
    private readonly registry: SupplierAdapterRegistry,
    @Inject(PgAccountRepository)
    private readonly accounts: PgAccountRepository,
    @Inject(PgHotelSupplierRepository)
    private readonly hotelSuppliers: PgHotelSupplierRepository,
    @Inject(PgMarkupRuleRepository)
    private readonly markupRules: PgMarkupRuleRepository,
    @Inject(PgPromotionRepository)
    private readonly promotions: PgPromotionRepository,
    @Inject(PgAuthoredSearchRepository)
    private readonly authoredRepo: PgAuthoredSearchRepository,
    @Inject(AuthoredSearchService)
    private readonly authoredService: AuthoredSearchService,
  ) {}

  async search(req: SearchRequest): Promise<SearchResponse> {
    // Single request-time clock value used by every now-sensitive
    // step downstream (today: restriction loading + restriction
    // evaluation in the authored fan-out). Capturing once at the
    // entry point guarantees the SQL filter and the in-memory
    // evaluator agree on "now" for this request.
    const now = new Date();

    const account = await this.accounts.resolveActive(req.accountId);
    if (account.tenantId !== req.tenantId) {
      // Cross-tenant guard: an account never participates in a
      // search outside its own tenant. The request claimed one
      // tenant; the account lives in another. Refuse loudly.
      throw new ForbiddenException(
        `accountId=${req.accountId} does not belong to tenantId=${req.tenantId}`,
      );
    }

    const ctx: AccountContext = {
      tenantId: account.tenantId,
      accountId: account.accountId,
      accountType: account.accountType,
    };

    // Step 2 — adapter call (one supplier in this slice).
    const adapter = this.registry.get('hotelbeds');
    const rates = await adapter.fetchRates(
      { tenantId: ctx.tenantId },
      {
        supplierHotelId: req.supplierHotelIds[0]!,
        // Adapter contract takes one hotel per request today; multi-
        // hotel fan-out lands when the adapter signature widens. For
        // now we call once per requested hotel and concatenate.
        checkIn: req.checkIn,
        checkOut: req.checkOut,
        occupancy: {
          adults: req.occupancy.adults,
          children: req.occupancy.children,
          ...(req.occupancy.childAges
            ? { childAges: [...req.occupancy.childAges] }
            : {}),
        },
        ...(req.currency !== undefined ? { currency: req.currency } : {}),
      },
    );
    const allRates: AdapterSupplierRate[] = [...rates];
    for (let i = 1; i < req.supplierHotelIds.length; i += 1) {
      const next = await adapter.fetchRates(
        { tenantId: ctx.tenantId },
        {
          supplierHotelId: req.supplierHotelIds[i]!,
          checkIn: req.checkIn,
          checkOut: req.checkOut,
          occupancy: {
            adults: req.occupancy.adults,
            children: req.occupancy.children,
            ...(req.occupancy.childAges
              ? { childAges: [...req.occupancy.childAges] }
              : {}),
          },
          ...(req.currency !== undefined ? { currency: req.currency } : {}),
        },
      );
      allRates.push(...next);
    }

    // Step 3 — code → hotel_supplier.id translation (sourced HOTEL
    // scope), and canonical-hotel resolution (authored fan-out +
    // cross-supplier correlation in the response).
    const observedCodes = uniq(allRates.map((r) => r.supplierHotelId));
    const requestedCodes = uniq([...req.supplierHotelIds, ...observedCodes]);
    const [codeToId, canonicalLookups] = await Promise.all([
      this.hotelSuppliers.resolveCodes('hotelbeds', observedCodes),
      this.authoredRepo.resolveCanonicalForSupplierCodes(
        'hotelbeds',
        requestedCodes,
      ),
    ]);
    const codeToCanonical = new Map<string, string>();
    for (const l of canonicalLookups) {
      codeToCanonical.set(l.supplierHotelCode, l.canonicalHotelId);
    }

    // Step 4 — rule + promotion fetch. Rules already cover any
    // supplier_hotel_id observed via either path; we union the
    // sourced + authored ULIDs we'll evaluate against.
    const sourcedSupplierHotelIds = Array.from(codeToId.values());
    const authoredCanonicalIds = uniq(
      canonicalLookups.map((l) => l.canonicalHotelId),
    );
    // Authored offers may key HOTEL-scope rules off the DIRECT
    // supplier's `hotel_supplier.id`. Pre-resolve those too so the
    // single rule fetch covers both paths.
    const authoredContracts = authoredCanonicalIds.length
      ? await this.authoredRepo.findActiveContracts({
          tenantId: ctx.tenantId,
          canonicalHotelIds: authoredCanonicalIds,
          checkIn: req.checkIn,
          checkOut: req.checkOut,
        })
      : [];
    const authoredSupplierIds = uniq(authoredContracts.map((c) => c.supplierId));
    const authoredMappings = authoredSupplierIds.length
      ? await this.authoredRepo.findDirectSupplierHotelMappings(
          authoredSupplierIds,
          authoredCanonicalIds,
        )
      : [];
    const ruleSupplierHotelIds = uniq([
      ...sourcedSupplierHotelIds,
      ...authoredMappings.map((m) => m.supplierHotelId),
    ]);

    const [rules, promotionsByHotelId] = await Promise.all([
      this.markupRules.findApplicable({
        tenantId: ctx.tenantId,
        accountId: ctx.accountId,
        accountType: ctx.accountType,
        supplierHotelIds: ruleSupplierHotelIds,
      }),
      this.promotions.findApplicable({
        tenantId: ctx.tenantId,
        accountType: ctx.accountType,
        supplierHotelIds: ruleSupplierHotelIds,
      }),
    ]);

    // Step 5 — price each sourced rate.
    const sourcedPriced: PricedEntry[] = allRates.map((rate) =>
      this.priceSourced(rate, codeToId, codeToCanonical, rules, ctx),
    );

    // Step 6 — authored fan-out (re-uses the canonical lookups so
    // it does not pay another resolver round-trip).
    const authoredPriced = canonicalLookups.length
      ? await this.authoredService.assemble({
          canonicalLookups,
          tenantId: ctx.tenantId,
          checkIn: req.checkIn,
          checkOut: req.checkOut,
          adults: req.occupancy.adults,
          children: req.occupancy.children,
          childAges: req.occupancy.childAges ?? [],
          rules,
          ctx,
          now,
        })
      : ([] as ReadonlyArray<PricedAuthoredEntry>);
    const authoredEntries: PricedEntry[] = authoredPriced.map(toPricedEntry);

    // Step 7 — merge, group, attach promotions, sort.
    const merged: PricedEntry[] = [...sourcedPriced, ...authoredEntries];
    const grouped = groupByHotel(merged);
    const results: SearchResultHotel[] = grouped.map((g) => {
      const promo: PromotionTag | undefined = g.supplierHotelId
        ? promotionsByHotelId.get(g.supplierHotelId)
        : undefined;
      return {
        supplierId: g.supplierId,
        supplierHotelCode: g.supplierHotelCode,
        ...(g.canonicalHotelId !== undefined
          ? { canonicalHotelId: g.canonicalHotelId }
          : {}),
        rates: g.rates,
        ...(promo !== undefined ? { promotion: promo } : {}),
      };
    });

    // Sort hotels by their cheapest selling price ascending. Hotels with
    // zero rates (impossible today but defensive) sort last. When hotels
    // have rates in different currencies, the alphabetical-currency sort
    // from compareSellingPriceAsc provides a deterministic ordering
    // without requiring FX conversion.
    // Promotion tags do NOT influence this ordering.
    results.sort(compareHotelsByPrice);

    return {
      meta: {
        searchId: newUlid(),
        generatedAt: new Date().toISOString(),
        accountContext: ctx,
        currency: req.currency ?? allRates[0]?.grossAmount.currency ?? 'USD',
        currencies: collectCurrencies(results),
        resultCount: results.length,
      },
      results,
    };
  }

  private priceSourced(
    rate: AdapterSupplierRate,
    codeToId: ReadonlyMap<string, string>,
    codeToCanonical: ReadonlyMap<string, string>,
    rules: ReadonlyArray<MarkupRuleSnapshot>,
    ctx: AccountContext,
  ): PricedEntry {
    const supplierHotelId = codeToId.get(rate.supplierHotelId) ?? '';
    const canonicalHotelId = codeToCanonical.get(rate.supplierHotelId);
    const netMinor = toMinorUnits(
      rate.grossAmount.amount,
      rate.grossAmount.currency,
    );
    const evaluated = evaluateSourcedOffer(
      {
        supplierHotelId,
        netAmountMinorUnits: netMinor,
        currency: rate.grossAmount.currency,
        moneyMovement: rate.moneyMovement,
        grossCurrencySemantics: rate.grossCurrencySemantics,
      },
      rules,
      ctx,
    );

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

    const result: SearchResultRate = {
      supplierRateId: rate.supplierRateId,
      roomType: rate.roomType,
      ratePlan: rate.ratePlan,
      priceQuote: evaluated.priceQuote,
      trace: evaluated.trace,
      moneyMovementProvenance: rate.moneyMovementProvenance ?? 'PROVISIONAL',
      isBookable,
      ...(bookingRefusalReason !== undefined ? { bookingRefusalReason } : {}),
      offerShape: rate.offerShape,
      rateBreakdownGranularity: rate.rateBreakdownGranularity,
      supplierRawRef: rate.supplierRawRef,
    };
    const sellMinor = toMinorUnits(
      evaluated.priceQuote.sellingPrice.amount,
      evaluated.priceQuote.sellingPrice.currency,
    );
    return {
      result,
      supplierId: 'hotelbeds',
      supplierHotelCode: rate.supplierHotelId,
      supplierHotelId,
      ...(canonicalHotelId !== undefined ? { canonicalHotelId } : {}),
      sellMinor,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (file-local; no need to widen the service surface)
// ---------------------------------------------------------------------------

interface PricedEntry {
  readonly result: SearchResultRate;
  readonly supplierId: string;
  readonly supplierHotelCode: string;
  readonly supplierHotelId: string;
  readonly canonicalHotelId?: string;
  readonly sellMinor: bigint;
}

function toPricedEntry(e: PricedAuthoredEntry): PricedEntry {
  return {
    result: e.result,
    supplierId: e.supplierCode,
    supplierHotelCode: e.supplierHotelCode,
    supplierHotelId: e.supplierHotelId,
    canonicalHotelId: e.canonicalHotelId,
    sellMinor: e.sellMinor,
  };
}

function uniq<T>(arr: ReadonlyArray<T>): T[] {
  return Array.from(new Set(arr));
}

function groupByHotel(rows: ReadonlyArray<PricedEntry>): Array<{
  supplierId: string;
  supplierHotelCode: string;
  supplierHotelId: string;
  canonicalHotelId: string | undefined;
  rates: SearchResultRate[];
}> {
  const map = new Map<
    string,
    {
      supplierId: string;
      supplierHotelCode: string;
      supplierHotelId: string;
      canonicalHotelId: string | undefined;
      rates: SearchResultRate[];
    }
  >();
  for (const row of rows) {
    const key = `${row.supplierId}::${row.supplierHotelCode}`;
    const entry = map.get(key);
    if (!entry) {
      map.set(key, {
        supplierId: row.supplierId,
        supplierHotelCode: row.supplierHotelCode,
        supplierHotelId: row.supplierHotelId,
        canonicalHotelId: row.canonicalHotelId,
        rates: [row.result],
      });
    } else {
      entry.rates.push(row.result);
      if (entry.canonicalHotelId === undefined && row.canonicalHotelId !== undefined) {
        entry.canonicalHotelId = row.canonicalHotelId;
      }
    }
  }
  // Sort each hotel's rates by selling price ascending. When rates span
  // multiple currencies the alphabetical-currency tie-break in
  // compareSellingPriceAsc makes the order deterministic.
  const out: Array<{
    supplierId: string;
    supplierHotelCode: string;
    supplierHotelId: string;
    canonicalHotelId: string | undefined;
    rates: SearchResultRate[];
  }> = [];
  for (const value of map.values()) {
    value.rates.sort((a, b) =>
      compareSellingPriceAsc(a.priceQuote.sellingPrice, b.priceQuote.sellingPrice),
    );
    out.push(value);
  }
  return out;
}

function compareSellingPriceAsc(
  a: { amount: string; currency: string },
  b: { amount: string; currency: string },
): number {
  // Cross-currency comparison is not meaningful without FX conversion,
  // which this service does not perform. Fall back to alphabetical
  // currency code so the sort is deterministic rather than silently wrong.
  if (a.currency !== b.currency) {
    return a.currency < b.currency ? -1 : 1;
  }
  const am = toMinorUnits(a.amount, a.currency);
  const bm = toMinorUnits(b.amount, b.currency);
  return am < bm ? -1 : am > bm ? 1 : 0;
}

function compareHotelsByPrice(
  a: SearchResultHotel,
  b: SearchResultHotel,
): number {
  // rates[0] is the cheapest after groupByHotel's within-hotel sort.
  const aRate = a.rates[0];
  const bRate = b.rates[0];
  if (!aRate && !bRate) return 0;
  if (!aRate) return 1;
  if (!bRate) return -1;
  return compareSellingPriceAsc(
    aRate.priceQuote.sellingPrice,
    bRate.priceQuote.sellingPrice,
  );
}

function collectCurrencies(
  hotels: ReadonlyArray<SearchResultHotel>,
): string[] {
  const set = new Set<string>();
  for (const h of hotels) {
    for (const r of h.rates) {
      set.add(r.priceQuote.sellingPrice.currency);
    }
  }
  return Array.from(set).sort();
}
