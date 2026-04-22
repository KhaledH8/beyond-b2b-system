import type { Money } from './shared';
import type { MoneyMovementTriple } from './supplier';

export type BookingStatus =
  | 'DRAFT'
  | 'QUOTED'
  | 'PENDING_PAYMENT'
  | 'AUTHORISING'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'CANCELLATION_PENDING'
  | 'FAILED';

export interface GuestDetails {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone?: string;
}

export interface Occupancy {
  readonly adults: number;
  readonly children: number;
  readonly childAges?: number[];
}

export interface Booking {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly canonicalHotelId: string;
  readonly supplierId: string;
  readonly supplierHotelId: string;
  readonly supplierRateId: string;
  readonly supplierBookingRef?: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: Occupancy;
  readonly primaryGuest: GuestDetails;
  readonly status: BookingStatus;
  readonly sellAmount: Money;
  readonly sourceCost: Money;
  readonly moneyMovement: MoneyMovementTriple;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
