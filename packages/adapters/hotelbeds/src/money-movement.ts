import type { MoneyMovementTriple } from '@bb/domain';
import type { HotelbedsAvailabilityRate, HotelbedsAvailabilityHotel } from './client';

/**
 * Hotelbeds money-movement resolution (ADR-020 per-rate triple).
 *
 * Hotelbeds' availability payload does NOT reliably commit the
 * collection / supplier-settlement / payment-cost model per rate.
 * The Booking API exposes `paymentType` (`AT_HOTEL` vs `AT_WEB`) on
 * some responses, but it is not universal across contracts, rate
 * classes, or markets, and it does not cover supplier settlement or
 * payment-cost ownership at all. ADR-020 forbids hardcoding a single
 * triple at the supplier level — the triple is declared per rate, per
 * commercial agreement.
 *
 * This module is the single normalization point where the adapter
 * decides, for each rate, which of the three outcomes applies:
 *
 *   1. `PAYLOAD_DERIVED`  — the payload itself gave us enough signal
 *      (e.g. an explicit `paymentType`) that we can pin the triple.
 *   2. `CONFIG_RESOLVED`  — the operator has a known commercial
 *      agreement for this supplier / contract / market and has
 *      injected a resolver that returns the agreed triple.
 *   3. `PROVISIONAL`      — neither of the above. The rate carries a
 *      safe fallback so the snapshot still has a valid shape, but the
 *      provenance flag tells downstream booking code to refuse the
 *      rate until a human has resolved it.
 *
 * Writing a composed rate to `offer_sourced_snapshot` with a
 * `PROVISIONAL` triple is explicitly allowed — snapshots are
 * observations. Booking a `PROVISIONAL` rate is NOT allowed; the
 * booking saga must inspect `moneyMovementProvenance` before calling
 * `adapter.book(...)`.
 */

/**
 * What the resolver sees per rate. The rate + its parent hotel cover
 * everything Hotelbeds actually commits in the availability envelope.
 * Keep this narrow — widen deliberately once a real fixture shows
 * another signal is load-bearing.
 */
export interface HotelbedsMoneyMovementInput {
  readonly tenantId: string;
  readonly supplierHotelCode: string;
  readonly rate: HotelbedsAvailabilityRate;
  readonly hotel: HotelbedsAvailabilityHotel;
}

export type HotelbedsMoneyMovementResolution =
  | {
      readonly status: 'RESOLVED';
      readonly triple: MoneyMovementTriple;
      readonly source: 'PAYLOAD_DERIVED' | 'CONFIG_RESOLVED';
    }
  | {
      readonly status: 'PROVISIONAL';
      readonly fallbackTriple: MoneyMovementTriple;
      readonly reason: string;
    };

export interface HotelbedsMoneyMovementResolver {
  resolve(input: HotelbedsMoneyMovementInput): HotelbedsMoneyMovementResolution;
}

/**
 * Default factory for Phase 1 / scaffold wiring.
 *
 * Returns `PROVISIONAL` for every rate and carries the operator-
 * supplied fallback triple. Picking this resolver is how the
 * composition root says: "I have not yet configured Hotelbeds' money
 * movement for this tenant; persist the observation but do not let
 * anything book these rates."
 *
 * The fallback is mandatory so the projected `AdapterSupplierRate`
 * still satisfies the contract invariant (`moneyMovement` is required).
 * The provenance flag is the loud signal that it is not trustworthy.
 */
export function createProvisionalResolver(args: {
  readonly fallbackTriple: MoneyMovementTriple;
  readonly reason: string;
}): HotelbedsMoneyMovementResolver {
  return {
    resolve() {
      return {
        status: 'PROVISIONAL',
        fallbackTriple: args.fallbackTriple,
        reason: args.reason,
      };
    },
  };
}

/**
 * Factory for tenants where the commercial agreement with Hotelbeds
 * is known and uniform: the operator declares the triple explicitly
 * and every rate is tagged `CONFIG_RESOLVED`. Use this when ops has
 * confirmed the contract model out-of-band.
 *
 * This is the direct replacement for the old hardcoded constant, but
 * it is now an explicit choice made at composition-root wiring time,
 * not a silent default baked into the adapter.
 */
export function createStaticResolver(
  triple: MoneyMovementTriple,
): HotelbedsMoneyMovementResolver {
  return {
    resolve() {
      return { status: 'RESOLVED', triple, source: 'CONFIG_RESOLVED' };
    },
  };
}

/**
 * Factory for the case where a future fixture confirms Hotelbeds
 * does expose a per-rate signal we can map. Composition-root passes
 * a `mapPayload` function that returns a triple if the payload
 * commits it; the resolver falls back to the provided `fallback`
 * resolver otherwise. Kept as a thin combinator so adapter internals
 * do not hardcode "which field" the payload mapping reads — that
 * decision belongs to whoever reviews the live response.
 */
export function createPayloadFirstResolver(args: {
  readonly mapPayload: (
    input: HotelbedsMoneyMovementInput,
  ) => MoneyMovementTriple | undefined;
  readonly fallback: HotelbedsMoneyMovementResolver;
}): HotelbedsMoneyMovementResolver {
  return {
    resolve(input) {
      const mapped = args.mapPayload(input);
      if (mapped !== undefined) {
        return { status: 'RESOLVED', triple: mapped, source: 'PAYLOAD_DERIVED' };
      }
      return args.fallback.resolve(input);
    },
  };
}
