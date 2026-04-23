import type { AdapterSupplierRate } from '@bb/supplier-contract';

/**
 * Thrown when a caller attempts to proceed to booking against a rate
 * whose money-movement triple has not been confirmed. Carries the
 * supplier + rate identifiers so the operator has enough to chase
 * the underlying commercial question.
 *
 * This is explicitly a defensive guard, not an ADR-020 workaround.
 * The fix for a `PROVISIONAL` rate is ops confirming the contract
 * model and the adapter module swapping to a resolver that returns
 * `RESOLVED` — not suppressing this error.
 */
export class ProvisionalMoneyMovementError extends Error {
  readonly supplierId: string;
  readonly supplierRateId: string;

  constructor(rate: AdapterSupplierRate) {
    super(
      `Refusing to book rate ${rate.supplierRateId} from supplier ` +
        `${rate.supplierId}: moneyMovementProvenance is PROVISIONAL. ` +
        `Confirm Hotelbeds commercial agreement, then swap the ` +
        `money-movement resolver in apps/api/src/adapters/hotelbeds/ ` +
        `from createProvisionalResolver to createStaticResolver or ` +
        `createPayloadFirstResolver.`,
    );
    this.name = 'ProvisionalMoneyMovementError';
    this.supplierId = rate.supplierId;
    this.supplierRateId = rate.supplierRateId;
  }
}

/**
 * Booking-flow guard (ADR-020). Call immediately before dispatching
 * an `AdapterSupplierRate` to any `SupplierAdapter.book(...)` or any
 * saga step that treats the rate as ready to charge.
 *
 * Intentionally synchronous and pure: no IO, no allocation beyond
 * the thrown error on the failure path. Wire into the booking saga
 * in Phase 2 at the exact point where a selected rate transitions
 * from "displayed / snapshotted" to "about to move money."
 */
export function assertRateBookable(rate: AdapterSupplierRate): void {
  if (rate.moneyMovementProvenance === 'PROVISIONAL') {
    throw new ProvisionalMoneyMovementError(rate);
  }
}
