import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type {
  CancellationPolicySnapshot,
  RestrictionKind,
  RestrictionSnapshot,
} from '@bb/pricing';
import { PG_POOL } from '../database/database.module';

/**
 * Read-only DB reads that feed the authored search assembly layer
 * (ADR-021 / ADR-022). All queries are scoped by tenant + canonical
 * hotel and pull only what the composer needs to assemble a
 * `PriceableAuthoredOffer`.
 *
 * The repository deliberately stays SQL-flat (no in-memory joins,
 * no transactions). Joining `rate_auth_*` rows with the canonical
 * product dimensions (`hotel_room_type`, `hotel_rate_plan`, etc.)
 * is the assembly service's job — the repository returns plain rows
 * the service can compose without further DB calls.
 */

export interface CanonicalHotelLookup {
  /** Supplier hotel code as supplied in the request (e.g. "1000073"). */
  readonly supplierHotelCode: string;
  /** `hotel_supplier.id` of the row that produced the lookup. */
  readonly supplierHotelId: string;
  /** `hotel_canonical.id` the supplier hotel maps to, when an active mapping exists. */
  readonly canonicalHotelId: string;
}

export interface ActiveDirectContractRow {
  readonly contractId: string;
  readonly tenantId: string;
  readonly canonicalHotelId: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly contractCode: string;
  readonly currency: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface SeasonRow {
  readonly id: string;
  readonly contractId: string;
  readonly dateFrom: string;
  readonly dateTo: string;
}

export interface BaseRateAssemblyRow {
  readonly id: string;
  readonly contractId: string;
  readonly seasonId: string;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly ratePlanId: string;
  readonly ratePlanName: string;
  readonly occupancyTemplateId: string;
  readonly baseAdults: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
  readonly maxTotal: number;
  readonly includedMealPlanId: string;
  readonly amountMinorUnits: bigint;
  readonly currency: string;
}

export interface OccupancySupplementAssemblyRow {
  readonly id: string;
  readonly contractId: string;
  readonly seasonId: string;
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly occupantKind: 'EXTRA_ADULT' | 'EXTRA_CHILD';
  readonly childAgeBandId: string | null;
  readonly slotIndex: number;
  readonly amountMinorUnits: bigint;
}

export interface ChildAgeBandRow {
  readonly id: string;
  readonly contractId: string;
  readonly ageMin: number;
  readonly ageMax: number;
}

export interface DirectSupplierHotelMappingRow {
  readonly supplierId: string;
  readonly canonicalHotelId: string;
  readonly supplierHotelId: string;
  readonly supplierHotelCode: string;
}

@Injectable()
export class PgAuthoredSearchRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Resolve `(supplierCode, supplierHotelCode)` → canonical hotel id
   * via `hotel_supplier` + `hotel_mapping`. Returns one row per
   * requested code that has both a `hotel_supplier` entry and an
   * active `hotel_mapping`. Codes without an active mapping are
   * absent from the result — callers degrade gracefully.
   */
  async resolveCanonicalForSupplierCodes(
    supplierCode: string,
    supplierHotelCodes: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CanonicalHotelLookup>> {
    if (supplierHotelCodes.length === 0) return [];
    const { rows } = await this.pool.query<{
      supplier_hotel_code: string;
      hotel_supplier_id: string;
      canonical_hotel_id: string;
    }>(
      `
      SELECT hs.supplier_hotel_code,
             hs.id AS hotel_supplier_id,
             hm.canonical_hotel_id
        FROM hotel_supplier hs
        JOIN supply_supplier s ON s.id = hs.supplier_id
        JOIN hotel_mapping hm ON hm.hotel_supplier_id = hs.id
       WHERE s.code = $1
         AND hs.supplier_hotel_code = ANY($2::text[])
         AND hm.mapping_status NOT IN ('REJECTED', 'SUPERSEDED')
      `,
      [supplierCode, supplierHotelCodes as readonly string[]],
    );
    return rows.map((r) => ({
      supplierHotelCode: r.supplier_hotel_code,
      supplierHotelId: r.hotel_supplier_id,
      canonicalHotelId: r.canonical_hotel_id,
    }));
  }

  /**
   * Active direct contracts for the tenant on the given canonical
   * hotels. Filters on `status = 'ACTIVE'` and (when present) the
   * contract's `valid_from`/`valid_to` window covering the stay.
   */
  async findActiveContracts(args: {
    readonly tenantId: string;
    readonly canonicalHotelIds: ReadonlyArray<string>;
    readonly checkIn: string;
    readonly checkOut: string;
  }): Promise<ReadonlyArray<ActiveDirectContractRow>> {
    if (args.canonicalHotelIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      id: string;
      tenant_id: string;
      canonical_hotel_id: string;
      supplier_id: string;
      supplier_code: string;
      contract_code: string;
      currency: string;
      valid_from: string | null;
      valid_to: string | null;
    }>(
      `
      SELECT c.id, c.tenant_id, c.canonical_hotel_id, c.supplier_id,
             s.code AS supplier_code,
             c.contract_code, c.currency, c.valid_from, c.valid_to
        FROM rate_auth_contract c
        JOIN supply_supplier s ON s.id = c.supplier_id
       WHERE c.tenant_id = $1
         AND c.canonical_hotel_id = ANY($2::char(26)[])
         AND c.status = 'ACTIVE'
         AND (c.valid_from IS NULL OR c.valid_from <= $3::date)
         AND (c.valid_to   IS NULL OR c.valid_to   >= $4::date)
      `,
      [
        args.tenantId,
        args.canonicalHotelIds as readonly string[],
        args.checkIn,
        args.checkOut,
      ],
    );
    return rows.map((r) => ({
      contractId: r.id,
      tenantId: r.tenant_id,
      canonicalHotelId: r.canonical_hotel_id,
      supplierId: r.supplier_id,
      supplierCode: r.supplier_code,
      contractCode: r.contract_code,
      currency: r.currency,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
  }

  /**
   * Seasons in the given contracts whose date range overlaps the stay
   * window. Slice 5 only consumes seasons that fully cover the stay
   * (single-season constraint), but the repository returns all
   * overlaps so the assembly layer can decide.
   */
  async findOverlappingSeasons(
    contractIds: ReadonlyArray<string>,
    checkIn: string,
    checkOut: string,
  ): Promise<ReadonlyArray<SeasonRow>> {
    if (contractIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string;
      date_from: string;
      date_to: string;
    }>(
      `
      SELECT id, contract_id, date_from, date_to
        FROM rate_auth_season
       WHERE contract_id = ANY($1::char(26)[])
         AND date_from <= $3::date
         AND date_to   >= $2::date
      `,
      [contractIds as readonly string[], checkIn, checkOut],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      dateFrom: r.date_from,
      dateTo: r.date_to,
    }));
  }

  /**
   * Base rates for the given (contract, season) pairs joined with
   * room type, rate plan, and occupancy template names/limits the
   * search response surfaces. Returns one row per base rate.
   */
  async findBaseRates(
    contractIds: ReadonlyArray<string>,
    seasonIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<BaseRateAssemblyRow>> {
    if (contractIds.length === 0 || seasonIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string;
      season_id: string;
      room_type_id: string;
      room_type_name: string;
      rate_plan_id: string;
      rate_plan_name: string;
      occupancy_template_id: string;
      base_adults: number;
      max_adults: number;
      max_children: number;
      max_total: number;
      included_meal_plan_id: string;
      amount_minor_units: string;
      currency: string;
    }>(
      `
      SELECT br.id, br.contract_id, br.season_id,
             br.room_type_id, rt.name AS room_type_name,
             br.rate_plan_id, rp.name AS rate_plan_name,
             br.occupancy_template_id,
             ot.base_adults, ot.max_adults, ot.max_children, ot.max_total,
             br.included_meal_plan_id,
             br.amount_minor_units, br.currency
        FROM rate_auth_base_rate br
        JOIN hotel_room_type           rt ON rt.id = br.room_type_id
        JOIN hotel_rate_plan           rp ON rp.id = br.rate_plan_id
        JOIN hotel_occupancy_template  ot ON ot.id = br.occupancy_template_id
       WHERE br.contract_id = ANY($1::char(26)[])
         AND br.season_id   = ANY($2::char(26)[])
      `,
      [contractIds as readonly string[], seasonIds as readonly string[]],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      seasonId: r.season_id,
      roomTypeId: r.room_type_id,
      roomTypeName: r.room_type_name,
      ratePlanId: r.rate_plan_id,
      ratePlanName: r.rate_plan_name,
      occupancyTemplateId: r.occupancy_template_id,
      baseAdults: r.base_adults,
      maxAdults: r.max_adults,
      maxChildren: r.max_children,
      maxTotal: r.max_total,
      includedMealPlanId: r.included_meal_plan_id,
      amountMinorUnits: BigInt(r.amount_minor_units),
      currency: r.currency,
    }));
  }

  /**
   * Occupancy supplements for the given (contract, season) pairs.
   * The assembly layer filters by (room_type_id, rate_plan_id, slot,
   * age band) per offer. Meal supplements are deliberately NOT
   * loaded — Slice 5 does not surface meal upgrades.
   */
  async findOccupancySupplements(
    contractIds: ReadonlyArray<string>,
    seasonIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<OccupancySupplementAssemblyRow>> {
    if (contractIds.length === 0 || seasonIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string;
      season_id: string;
      room_type_id: string;
      rate_plan_id: string;
      occupant_kind: string;
      child_age_band_id: string | null;
      slot_index: number;
      amount_minor_units: string;
    }>(
      `
      SELECT id, contract_id, season_id, room_type_id, rate_plan_id,
             occupant_kind, child_age_band_id, slot_index,
             amount_minor_units
        FROM rate_auth_occupancy_supplement
       WHERE contract_id = ANY($1::char(26)[])
         AND season_id   = ANY($2::char(26)[])
      `,
      [contractIds as readonly string[], seasonIds as readonly string[]],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      seasonId: r.season_id,
      roomTypeId: r.room_type_id,
      ratePlanId: r.rate_plan_id,
      occupantKind: r.occupant_kind as 'EXTRA_ADULT' | 'EXTRA_CHILD',
      childAgeBandId: r.child_age_band_id,
      slotIndex: r.slot_index,
      amountMinorUnits: BigInt(r.amount_minor_units),
    }));
  }

  /**
   * Per-contract child age bands. The assembly layer matches each
   * requested child age to the band whose `[ageMin, ageMax]` covers
   * it, then looks up matching `EXTRA_CHILD` supplements.
   */
  async findChildAgeBands(
    contractIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<ChildAgeBandRow>> {
    if (contractIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string;
      age_min: number;
      age_max: number;
    }>(
      `
      SELECT id, contract_id, age_min, age_max
        FROM rate_auth_child_age_band
       WHERE contract_id = ANY($1::char(26)[])
      `,
      [contractIds as readonly string[]],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      ageMin: r.age_min,
      ageMax: r.age_max,
    }));
  }

  /**
   * Active restrictions for the request's authored scope (ADR-023).
   *
   * Pulls both supplier-default rows (`contract_id IS NULL`) and
   * rows tied to any of the request's active contracts. The
   * `effective_from` / `effective_to` filter and the
   * `superseded_by_id IS NULL` filter share the same `now` value the
   * caller passes to the evaluator, so the loaded set is exactly the
   * "active right now" view of the table.
   *
   * `stay_date BETWEEN checkIn AND checkOut` covers every date the
   * evaluator will consult — stay nights for STOP_SELL, the check-in
   * date for CTA / LOS / advance-purchase / cutoff, and the actual
   * checkout date for CTD. The evaluator does the per-`(kind,
   * stay_date)` precedence picking; this query just delivers the
   * candidate set.
   */
  async findActiveRestrictions(args: {
    readonly tenantId: string;
    readonly supplierIds: ReadonlyArray<string>;
    readonly canonicalHotelIds: ReadonlyArray<string>;
    readonly contractIds: ReadonlyArray<string>;
    readonly checkIn: string;
    readonly checkOut: string;
    readonly now: Date;
  }): Promise<ReadonlyArray<RestrictionSnapshot>> {
    if (
      args.supplierIds.length === 0 ||
      args.canonicalHotelIds.length === 0
    ) {
      return [];
    }
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string | null;
      season_id: string | null;
      rate_plan_id: string | null;
      room_type_id: string | null;
      stay_date: string;
      restriction_kind: string;
      params: Record<string, unknown>;
      effective_from: Date;
      effective_to: Date | null;
      superseded_by_id: string | null;
    }>(
      `
      SELECT id, contract_id, season_id, rate_plan_id, room_type_id,
             stay_date, restriction_kind, params,
             effective_from, effective_to, superseded_by_id
        FROM rate_auth_restriction
       WHERE tenant_id = $1
         AND supplier_id = ANY($2::char(26)[])
         AND canonical_hotel_id = ANY($3::char(26)[])
         AND stay_date BETWEEN $4::date AND $5::date
         AND superseded_by_id IS NULL
         AND effective_from <= $6::timestamptz
         AND (effective_to IS NULL OR effective_to >= $6::timestamptz)
         AND (contract_id IS NULL OR contract_id = ANY($7::char(26)[]))
      `,
      [
        args.tenantId,
        args.supplierIds as readonly string[],
        args.canonicalHotelIds as readonly string[],
        args.checkIn,
        args.checkOut,
        args.now,
        args.contractIds as readonly string[],
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      seasonId: r.season_id,
      ratePlanId: r.rate_plan_id,
      roomTypeId: r.room_type_id,
      stayDate: r.stay_date,
      restrictionKind: r.restriction_kind as RestrictionKind,
      params: r.params,
      effectiveFrom: r.effective_from.toISOString(),
      effectiveTo: r.effective_to ? r.effective_to.toISOString() : null,
      supersededById: r.superseded_by_id,
    }));
  }

  /**
   * Active cancellation policies (ADR-023 D5) for the request's
   * authored scope. Pulls supplier-default rows (`contract_id IS
   * NULL`) and rows tied to any of the request's active contracts in
   * one round-trip. Filters at the SQL layer:
   *
   *   - `superseded_by_id IS NULL` — the resolver rejects superseded
   *     rows anyway; pre-filtering keeps the result set small.
   *   - `effective_from <= now AND (effective_to IS NULL OR
   *     effective_to >= now)` — same `now` the resolver uses.
   *
   * Per-`(contract, rate_plan)` precedence and the highest-version
   * pick are owned by `resolveCancellationPolicy`; this repository
   * just delivers the candidate set.
   */
  async findActiveCancellationPolicies(args: {
    readonly tenantId: string;
    readonly supplierIds: ReadonlyArray<string>;
    readonly canonicalHotelIds: ReadonlyArray<string>;
    readonly contractIds: ReadonlyArray<string>;
    readonly now: Date;
  }): Promise<ReadonlyArray<CancellationPolicySnapshot>> {
    if (
      args.supplierIds.length === 0 ||
      args.canonicalHotelIds.length === 0
    ) {
      return [];
    }
    const { rows } = await this.pool.query<{
      id: string;
      contract_id: string | null;
      rate_plan_id: string | null;
      policy_version: number;
      windows_jsonb: ReadonlyArray<unknown>;
      refundable: boolean;
      effective_from: Date;
      effective_to: Date | null;
      superseded_by_id: string | null;
    }>(
      `
      SELECT id, contract_id, rate_plan_id, policy_version,
             windows_jsonb, refundable,
             effective_from, effective_to, superseded_by_id
        FROM rate_auth_cancellation_policy
       WHERE tenant_id = $1
         AND supplier_id = ANY($2::char(26)[])
         AND canonical_hotel_id = ANY($3::char(26)[])
         AND superseded_by_id IS NULL
         AND effective_from <= $4::timestamptz
         AND (effective_to IS NULL OR effective_to >= $4::timestamptz)
         AND (contract_id IS NULL OR contract_id = ANY($5::char(26)[]))
      `,
      [
        args.tenantId,
        args.supplierIds as readonly string[],
        args.canonicalHotelIds as readonly string[],
        args.now,
        args.contractIds as readonly string[],
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      contractId: r.contract_id,
      ratePlanId: r.rate_plan_id,
      policyVersion: r.policy_version,
      windowsJsonb: r.windows_jsonb,
      refundable: r.refundable,
      effectiveFrom: r.effective_from.toISOString(),
      effectiveTo: r.effective_to ? r.effective_to.toISOString() : null,
      supersededById: r.superseded_by_id,
    }));
  }

  /**
   * Resolve the DIRECT supplier's per-property identifier
   * (`hotel_supplier.id` + `supplier_hotel_code`) via the canonical
   * hotel mapping. Used as the HOTEL-scope match key for markup rules
   * targeting authored offers, and as the response's
   * `supplierHotelCode` for the direct supplier's result group.
   */
  async findDirectSupplierHotelMappings(
    supplierIds: ReadonlyArray<string>,
    canonicalHotelIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<DirectSupplierHotelMappingRow>> {
    if (supplierIds.length === 0 || canonicalHotelIds.length === 0) return [];
    const { rows } = await this.pool.query<{
      supplier_id: string;
      canonical_hotel_id: string;
      hotel_supplier_id: string;
      supplier_hotel_code: string;
    }>(
      `
      SELECT hs.supplier_id,
             hm.canonical_hotel_id,
             hs.id AS hotel_supplier_id,
             hs.supplier_hotel_code
        FROM hotel_supplier hs
        JOIN hotel_mapping hm ON hm.hotel_supplier_id = hs.id
       WHERE hs.supplier_id = ANY($1::char(26)[])
         AND hm.canonical_hotel_id = ANY($2::char(26)[])
         AND hm.mapping_status NOT IN ('REJECTED', 'SUPERSEDED')
      `,
      [
        supplierIds as readonly string[],
        canonicalHotelIds as readonly string[],
      ],
    );
    return rows.map((r) => ({
      supplierId: r.supplier_id,
      canonicalHotelId: r.canonical_hotel_id,
      supplierHotelId: r.hotel_supplier_id,
      supplierHotelCode: r.supplier_hotel_code,
    }));
  }
}
