import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { evaluateSourcedOffer, toMinorUnits } from '@bb/pricing';
import type {
  AccountContext,
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
 *      promotions).
 *   4. Load applicable markup rules + promotions from Postgres.
 *   5. Evaluate pricing per rate via the pure `@bb/pricing` evaluator.
 *      `createProvisionalResolver` is still in place upstream, so
 *      every rate carries `moneyMovementProvenance = PROVISIONAL`
 *      and the booking guard refuses it. The response surfaces this
 *      explicitly — pricing does not gate on it.
 *   6. Group rates by supplier hotel, attach promotion tag, sort
 *      hotels by their cheapest selling price (price-sort baseline).
 *
 * Pricing is the only step that mutates rate amounts. Merchandising
 * runs after and only attaches a tag — it never reorders past the
 * price-ascending baseline. CLAUDE.md invariant respected.
 *
 * Multi-supplier search lands in a later slice. For now the service
 * fans out to `'hotelbeds'` only; the registry already supports the
 * lookup pattern so adding a second supplier is additive (one more
 * `Promise.all` entry plus rule scoping).
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
  ) {}

  async search(req: SearchRequest): Promise<SearchResponse> {
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

    // Step 3 — code → hotel_supplier.id translation.
    const observedCodes = Array.from(
      new Set(allRates.map((r) => r.supplierHotelId)),
    );
    const codeToId = await this.hotelSuppliers.resolveCodes(
      'hotelbeds',
      observedCodes,
    );
    const supplierHotelIds = Array.from(codeToId.values());

    // Step 4 — rule + promotion fetch.
    const [rules, promotionsByHotelId] = await Promise.all([
      this.markupRules.findApplicable({
        tenantId: ctx.tenantId,
        accountId: ctx.accountId,
        accountType: ctx.accountType,
        supplierHotelIds,
      }),
      this.promotions.findApplicable({
        tenantId: ctx.tenantId,
        accountType: ctx.accountType,
        supplierHotelIds,
      }),
    ]);

    // Step 5 — price each rate.
    const priced = allRates.map((rate) =>
      this.priceOne(rate, codeToId, rules, ctx),
    );

    // Step 6 — group by hotel, attach promotion, sort by cheapest sell.
    const grouped = groupByHotel(priced);
    const results: SearchResultHotel[] = grouped.map((g) => {
      const tag = supplierHotelIdFor(g.supplierHotelCode, codeToId);
      const promo: PromotionTag | undefined =
        tag !== undefined ? promotionsByHotelId.get(tag) : undefined;
      return {
        supplierId: 'hotelbeds',
        supplierHotelCode: g.supplierHotelCode,
        rates: g.rates,
        ...(promo !== undefined ? { promotion: promo } : {}),
      };
    });

    // Sort hotels by their cheapest selling price (ascending). When
    // a hotel has zero priced rates (impossible today but defensive),
    // it sorts last. Promotion tags do NOT influence this ordering.
    results.sort((a, b) => cheapestSellMinor(a) - cheapestSellMinor(b));

    return {
      meta: {
        searchId: newUlid(),
        generatedAt: new Date().toISOString(),
        accountContext: ctx,
        currency: req.currency ?? allRates[0]?.grossAmount.currency ?? 'USD',
        resultCount: results.length,
      },
      results,
    };
  }

  private priceOne(
    rate: AdapterSupplierRate,
    codeToId: ReadonlyMap<string, string>,
    rules: ReadonlyArray<Parameters<typeof evaluateSourcedOffer>[1][number]>,
    ctx: AccountContext,
  ): { result: SearchResultRate; supplierHotelCode: string; sellMinor: bigint } {
    const supplierHotelId = codeToId.get(rate.supplierHotelId) ?? '';
    const netMinor = toMinorUnits(
      rate.grossAmount.amount,
      rate.grossAmount.currency,
    );
    const evaluated = evaluateSourcedOffer(
      {
        supplierHotelId,
        netAmountMinorUnits: netMinor,
        currency: rate.grossAmount.currency,
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
      supplierHotelCode: rate.supplierHotelId,
      sellMinor,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (file-local; no need to widen the service surface)
// ---------------------------------------------------------------------------

interface PricedEntry {
  result: SearchResultRate;
  supplierHotelCode: string;
  sellMinor: bigint;
}

function groupByHotel(rows: ReadonlyArray<PricedEntry>): Array<{
  supplierHotelCode: string;
  rates: SearchResultRate[];
  cheapestSellMinor: bigint;
}> {
  const map = new Map<
    string,
    { rates: SearchResultRate[]; cheapestSellMinor: bigint }
  >();
  for (const row of rows) {
    const entry = map.get(row.supplierHotelCode);
    if (!entry) {
      map.set(row.supplierHotelCode, {
        rates: [row.result],
        cheapestSellMinor: row.sellMinor,
      });
    } else {
      entry.rates.push(row.result);
      if (row.sellMinor < entry.cheapestSellMinor) {
        entry.cheapestSellMinor = row.sellMinor;
      }
    }
  }
  // Sort each hotel's rates by selling price ascending.
  const out: Array<{
    supplierHotelCode: string;
    rates: SearchResultRate[];
    cheapestSellMinor: bigint;
  }> = [];
  for (const [supplierHotelCode, value] of map.entries()) {
    value.rates.sort((a, b) =>
      compareSellingPriceAsc(a.priceQuote.sellingPrice, b.priceQuote.sellingPrice),
    );
    out.push({ supplierHotelCode, ...value });
  }
  return out;
}

function compareSellingPriceAsc(
  a: { amount: string; currency: string },
  b: { amount: string; currency: string },
): number {
  // Comparing within a single response uses a single currency in
  // this slice (no cross-currency conversion yet). Compare as
  // BigInt minor units to avoid float drift.
  const am = toMinorUnits(a.amount, a.currency);
  const bm = toMinorUnits(b.amount, b.currency);
  return am < bm ? -1 : am > bm ? 1 : 0;
}

function cheapestSellMinor(hotel: SearchResultHotel): number {
  if (hotel.rates.length === 0) return Number.MAX_SAFE_INTEGER;
  let cheapest = toMinorUnits(
    hotel.rates[0]!.priceQuote.sellingPrice.amount,
    hotel.rates[0]!.priceQuote.sellingPrice.currency,
  );
  for (const r of hotel.rates) {
    const m = toMinorUnits(
      r.priceQuote.sellingPrice.amount,
      r.priceQuote.sellingPrice.currency,
    );
    if (m < cheapest) cheapest = m;
  }
  // Number conversion is only used to feed Array.sort(); minor-unit
  // values fit comfortably in MAX_SAFE_INTEGER for any realistic
  // hotel rate.
  return Number(cheapest);
}

function supplierHotelIdFor(
  code: string,
  codeToId: ReadonlyMap<string, string>,
): string | undefined {
  return codeToId.get(code);
}
