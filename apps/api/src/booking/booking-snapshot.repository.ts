import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';
import { newUlid } from '../common/ulid';

/**
 * Booking-time snapshot repository (ADR-021, Booking Truth Slice 2).
 *
 * Reads the live `offer_sourced_*` rows and writes immutable
 * booking-time copies into the `booking_*_snapshot` tables. Every
 * method takes a `Queryable` so the caller (the confirm transaction)
 * passes the checked-out client; all writes therefore commit or roll
 * back as one unit with the booking status flip and the FX lock.
 *
 * Parameterised SQL only — no value is interpolated into statement
 * text. Source reads are tenant-scoped on the offer snapshot.
 */

// ── Source read shapes ────────────────────────────────────────────────

export interface SourceOfferSnapshotRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly supplier_id: string;
  readonly canonical_hotel_id: string | null;
  readonly supplier_hotel_code: string;
  readonly supplier_rate_key: string;
  readonly check_in: string;
  readonly check_out: string;
  readonly occupancy_adults: number;
  readonly occupancy_children_ages_jsonb: unknown;
  readonly supplier_room_code: string;
  readonly canonical_room_type_id: string | null;
  readonly supplier_rate_code: string;
  readonly canonical_rate_plan_id: string | null;
  readonly supplier_meal_code: string | null;
  readonly canonical_meal_plan_id: string | null;
  readonly total_amount_minor_units: string;
  readonly total_currency: string;
  readonly rate_breakdown_granularity: string;
  readonly raw_payload_hash: string;
  readonly raw_payload_storage_ref: string;
  readonly received_at: string;
  readonly valid_until: string;
}

export interface SourceComponentRow {
  readonly id: string;
  readonly component_kind: string;
  readonly description: string | null;
  readonly amount_minor_units: string;
  readonly currency: string;
  readonly applies_to_night_date: string | null;
  readonly applies_to_person_kind: string | null;
  readonly inclusive: boolean;
}

export interface SourceCancellationPolicyRow {
  readonly id: string;
  readonly windows_jsonb: unknown;
  readonly refundable: boolean;
  readonly source_verbatim_text: string | null;
  readonly parsed_with: string | null;
}

@Injectable()
export class BookingSnapshotRepository {
  /**
   * Loads the live sourced offer snapshot, tenant-scoped. Returns
   * `undefined` when it does not exist (expired/pruned/wrong tenant) —
   * the caller turns that into a hard confirm failure so a booking can
   * never reach CONFIRMED without pinned truth.
   */
  async loadSourceOfferSnapshot(
    q: Queryable,
    tenantId: string,
    sourceOfferSnapshotId: string,
  ): Promise<SourceOfferSnapshotRow | undefined> {
    const { rows } = await q.query<SourceOfferSnapshotRow>(
      `SELECT id, tenant_id, supplier_id, canonical_hotel_id,
              supplier_hotel_code, supplier_rate_key,
              to_char(check_in, 'YYYY-MM-DD')  AS check_in,
              to_char(check_out, 'YYYY-MM-DD') AS check_out,
              occupancy_adults, occupancy_children_ages_jsonb,
              supplier_room_code, canonical_room_type_id,
              supplier_rate_code, canonical_rate_plan_id,
              supplier_meal_code, canonical_meal_plan_id,
              total_amount_minor_units, total_currency,
              rate_breakdown_granularity,
              raw_payload_hash, raw_payload_storage_ref,
              received_at, valid_until
         FROM offer_sourced_snapshot
        WHERE id = $1 AND tenant_id = $2`,
      [sourceOfferSnapshotId, tenantId],
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  async loadSourceComponents(
    q: Queryable,
    sourceOfferSnapshotId: string,
  ): Promise<SourceComponentRow[]> {
    const { rows } = await q.query<SourceComponentRow>(
      `SELECT id, component_kind, description,
              amount_minor_units, currency,
              to_char(applies_to_night_date, 'YYYY-MM-DD')
                AS applies_to_night_date,
              applies_to_person_kind, inclusive
         FROM offer_sourced_component
        WHERE offer_snapshot_id = $1
        ORDER BY id`,
      [sourceOfferSnapshotId],
    );
    return [...rows];
  }

  async loadSourceCancellationPolicy(
    q: Queryable,
    sourceOfferSnapshotId: string,
  ): Promise<SourceCancellationPolicyRow | undefined> {
    const { rows } = await q.query<SourceCancellationPolicyRow>(
      `SELECT id, windows_jsonb, refundable,
              source_verbatim_text, parsed_with
         FROM offer_sourced_cancellation_policy
        WHERE offer_snapshot_id = $1`,
      [sourceOfferSnapshotId],
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  // ── Booking-time writes (immutable rows) ────────────────────────────

  /**
   * Inserts the 1:1 booking-time offer snapshot, copying the source
   * row's values. Returns the new row id so component / policy / tax
   * rows can reference it. The `booking_sourced_offer_snapshot_booking_uq`
   * unique constraint is the hard backstop against double-pinning.
   */
  async insertBookingSourcedOfferSnapshot(
    q: Queryable,
    args: {
      readonly bookingId: string;
      readonly tenantId: string;
      readonly sourceOfferSnapshotId: string;
      readonly source: SourceOfferSnapshotRow;
    },
  ): Promise<string> {
    const id = newUlid();
    const s = args.source;
    await q.query(
      `INSERT INTO booking_sourced_offer_snapshot (
         id, booking_id, tenant_id, source_offer_snapshot_id, supplier_id,
         supplier_hotel_code, supplier_rate_key, canonical_hotel_id,
         check_in, check_out, occupancy_adults, occupancy_children_ages_jsonb,
         supplier_room_code, canonical_room_type_id,
         supplier_rate_code, canonical_rate_plan_id,
         supplier_meal_code, canonical_meal_plan_id,
         total_amount_minor_units, total_currency, rate_breakdown_granularity,
         raw_payload_hash, raw_payload_storage_ref,
         source_received_at, source_valid_until
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9::date, $10::date, $11, $12::jsonb,
         $13, $14,
         $15, $16,
         $17, $18,
         $19, $20, $21,
         $22, $23,
         $24::timestamptz, $25::timestamptz
       )`,
      [
        id,
        args.bookingId,
        args.tenantId,
        args.sourceOfferSnapshotId,
        s.supplier_id,
        s.supplier_hotel_code,
        s.supplier_rate_key,
        s.canonical_hotel_id,
        s.check_in,
        s.check_out,
        s.occupancy_adults,
        JSON.stringify(s.occupancy_children_ages_jsonb ?? []),
        s.supplier_room_code,
        s.canonical_room_type_id,
        s.supplier_rate_code,
        s.canonical_rate_plan_id,
        s.supplier_meal_code,
        s.canonical_meal_plan_id,
        s.total_amount_minor_units,
        s.total_currency,
        s.rate_breakdown_granularity,
        s.raw_payload_hash,
        s.raw_payload_storage_ref,
        s.received_at,
        s.valid_until,
      ],
    );
    return id;
  }

  async insertBookingPriceComponentSnapshots(
    q: Queryable,
    args: {
      readonly bookingId: string;
      readonly bookingOfferSnapshotId: string;
      readonly components: readonly SourceComponentRow[];
    },
  ): Promise<number> {
    for (const c of args.components) {
      await q.query(
        `INSERT INTO booking_sourced_price_component_snapshot (
           id, booking_id, booking_sourced_offer_snapshot_id,
           source_component_id, component_kind, description,
           amount_minor_units, currency,
           applies_to_night_date, applies_to_person_kind, inclusive
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8,
           $9::date, $10, $11
         )`,
        [
          newUlid(),
          args.bookingId,
          args.bookingOfferSnapshotId,
          c.id,
          c.component_kind,
          c.description,
          c.amount_minor_units,
          c.currency,
          c.applies_to_night_date,
          c.applies_to_person_kind,
          c.inclusive,
        ],
      );
    }
    return args.components.length;
  }

  /**
   * Denormalised TAX/FEE view (CLAUDE.md §12 named `booking_tax_fee_
   * snapshot`). Source has no dedicated tax/fee table; tax and fee are
   * `offer_sourced_component` rows of `component_kind` TAX / FEE. We
   * pin them a second time here so reconciliation / documents can read
   * tax-fee truth without re-deriving from the component set.
   */
  async insertBookingTaxFeeSnapshots(
    q: Queryable,
    args: {
      readonly bookingId: string;
      readonly bookingOfferSnapshotId: string;
      readonly components: readonly SourceComponentRow[];
    },
  ): Promise<number> {
    const taxFee = args.components.filter(
      (c) => c.component_kind === 'TAX' || c.component_kind === 'FEE',
    );
    for (const c of taxFee) {
      await q.query(
        `INSERT INTO booking_tax_fee_snapshot (
           id, booking_id, booking_sourced_offer_snapshot_id,
           source_component_id, kind, description,
           amount_minor_units, currency, inclusive, applies_to_night_date
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8, $9, $10::date
         )`,
        [
          newUlid(),
          args.bookingId,
          args.bookingOfferSnapshotId,
          c.id,
          c.component_kind,
          c.description,
          c.amount_minor_units,
          c.currency,
          c.inclusive,
          c.applies_to_night_date,
        ],
      );
    }
    return taxFee.length;
  }

  async insertBookingCancellationPolicySnapshot(
    q: Queryable,
    args: {
      readonly bookingId: string;
      readonly bookingOfferSnapshotId: string;
      readonly source: SourceCancellationPolicyRow;
    },
  ): Promise<string> {
    const id = newUlid();
    const p = args.source;
    await q.query(
      `INSERT INTO booking_cancellation_policy_snapshot (
         id, booking_id, booking_sourced_offer_snapshot_id,
         source_cancellation_policy_id, windows_jsonb, refundable,
         source_verbatim_text, parsed_with
       ) VALUES (
         $1, $2, $3,
         $4, $5::jsonb, $6,
         $7, $8
       )`,
      [
        id,
        args.bookingId,
        args.bookingOfferSnapshotId,
        p.id,
        JSON.stringify(p.windows_jsonb ?? []),
        p.refundable,
        p.source_verbatim_text,
        p.parsed_with,
      ],
    );
    return id;
  }

  /**
   * True when a booking already has its 1:1 booking-time offer
   * snapshot. Used as a defensive idempotency check; the real
   * idempotency lever is the confirm fast-path + the
   * `booking_sourced_offer_snapshot_booking_uq` constraint.
   */
  async snapshotExistsForBooking(
    q: Queryable,
    bookingId: string,
  ): Promise<boolean> {
    const { rows } = await q.query<{ one: number }>(
      `SELECT 1 AS one
         FROM booking_sourced_offer_snapshot
        WHERE booking_id = $1
        LIMIT 1`,
      [bookingId],
    );
    return rows.length > 0;
  }
}
