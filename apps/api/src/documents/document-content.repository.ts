import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';

/**
 * Documents-owned reader over the booking truth tables (ADR-011:
 * `documents` must NOT import the `booking` module; reading
 * booking-owned tables by parameterised SQL is permitted for this
 * slice and noted in ADR-011 + ADR-016).
 *
 * Every read here is of an **immutable** booking-time row written at
 * CONFIRMED (Booking Truth Slice 2). The mutable live `offer_sourced_*`
 * / search tables are intentionally never read — a booking
 * confirmation must describe exactly what was sold, not what supply
 * looks like now.
 */

export interface BookingHeaderRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly reference: string;
  readonly status: string;
  readonly check_in: string;
  readonly check_out: string;
  readonly guest_first_name: string | null;
  readonly guest_last_name: string | null;
  readonly guest_email: string | null;
  readonly sell_amount_minor_units: string | null;
  readonly sell_currency: string | null;
  readonly supplier_ref: string | null;
  readonly supplier_raw_ref: string | null;
  readonly supplier_confirmation_ref: string | null;
  readonly supplier_booking_status: string | null;
}

export interface PinnedOfferRow {
  readonly id: string;
  readonly supplier_id: string;
  readonly supplier_hotel_code: string;
  readonly supplier_rate_key: string;
  readonly canonical_hotel_id: string | null;
  readonly check_in: string;
  readonly check_out: string;
  readonly occupancy_adults: number;
  readonly supplier_room_code: string;
  readonly supplier_rate_code: string;
  readonly supplier_meal_code: string | null;
  readonly total_amount_minor_units: string;
  readonly total_currency: string;
  readonly rate_breakdown_granularity: string;
}

export interface PinnedComponentRow {
  readonly component_kind: string;
  readonly description: string | null;
  readonly amount_minor_units: string;
  readonly currency: string;
  readonly applies_to_night_date: string | null;
  readonly applies_to_person_kind: string | null;
  readonly inclusive: boolean;
}

export interface PinnedCancellationPolicyRow {
  readonly windows_jsonb: unknown;
  readonly refundable: boolean;
  readonly source_verbatim_text: string | null;
  readonly parsed_with: string | null;
}

export interface PinnedTaxFeeRow {
  readonly kind: string;
  readonly description: string | null;
  readonly amount_minor_units: string;
  readonly currency: string;
  readonly inclusive: boolean;
  readonly applies_to_night_date: string | null;
}

@Injectable()
export class DocumentContentRepository {
  async loadBookingHeader(
    q: Queryable,
    bookingId: string,
  ): Promise<BookingHeaderRow | undefined> {
    const { rows } = await q.query<BookingHeaderRow>(
      `SELECT id, tenant_id, account_id, reference, status,
              to_char(check_in, 'YYYY-MM-DD')  AS check_in,
              to_char(check_out, 'YYYY-MM-DD') AS check_out,
              guest_details->'guest'->>'firstName' AS guest_first_name,
              guest_details->'guest'->>'lastName'  AS guest_last_name,
              guest_details->'guest'->>'email'     AS guest_email,
              sell_amount_minor_units, sell_currency,
              supplier_ref, supplier_raw_ref,
              supplier_confirmation_ref, supplier_booking_status
         FROM booking_booking
        WHERE id = $1`,
      [bookingId],
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  async loadPinnedOffer(
    q: Queryable,
    bookingId: string,
  ): Promise<PinnedOfferRow | undefined> {
    const { rows } = await q.query<PinnedOfferRow>(
      `SELECT id, supplier_id, supplier_hotel_code, supplier_rate_key,
              canonical_hotel_id,
              to_char(check_in, 'YYYY-MM-DD')  AS check_in,
              to_char(check_out, 'YYYY-MM-DD') AS check_out,
              occupancy_adults, supplier_room_code, supplier_rate_code,
              supplier_meal_code,
              total_amount_minor_units, total_currency,
              rate_breakdown_granularity
         FROM booking_sourced_offer_snapshot
        WHERE booking_id = $1`,
      [bookingId],
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  async loadPinnedComponents(
    q: Queryable,
    bookingId: string,
  ): Promise<PinnedComponentRow[]> {
    const { rows } = await q.query<PinnedComponentRow>(
      `SELECT component_kind, description,
              amount_minor_units, currency,
              to_char(applies_to_night_date, 'YYYY-MM-DD')
                AS applies_to_night_date,
              applies_to_person_kind, inclusive
         FROM booking_sourced_price_component_snapshot
        WHERE booking_id = $1
        ORDER BY id`,
      [bookingId],
    );
    return [...rows];
  }

  async loadPinnedCancellationPolicy(
    q: Queryable,
    bookingId: string,
  ): Promise<PinnedCancellationPolicyRow | undefined> {
    const { rows } = await q.query<PinnedCancellationPolicyRow>(
      `SELECT windows_jsonb, refundable,
              source_verbatim_text, parsed_with
         FROM booking_cancellation_policy_snapshot
        WHERE booking_id = $1`,
      [bookingId],
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  async loadPinnedTaxFees(
    q: Queryable,
    bookingId: string,
  ): Promise<PinnedTaxFeeRow[]> {
    const { rows } = await q.query<PinnedTaxFeeRow>(
      `SELECT kind, description, amount_minor_units, currency,
              inclusive,
              to_char(applies_to_night_date, 'YYYY-MM-DD')
                AS applies_to_night_date
         FROM booking_tax_fee_snapshot
        WHERE booking_id = $1
        ORDER BY id`,
      [bookingId],
    );
    return [...rows];
  }
}
