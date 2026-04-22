import type { Money } from '@bb/domain';

export type PaymentIntentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'CANCELLED'
  | 'FAILED';

export interface CreatePaymentIntentRequest {
  readonly amount: Money;
  readonly customerId?: string;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, string>;
}

export interface PaymentIntent {
  readonly id: string;
  readonly status: PaymentIntentStatus;
  readonly amount: Money;
  readonly externalRef?: string;
  readonly createdAt: Date;
}

export interface RefundRequest {
  readonly paymentIntentId: string;
  readonly amount?: Money;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface Refund {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly amount: Money;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  readonly externalRef?: string;
}

export interface WebhookEvent {
  readonly type: string;
  readonly externalId: string;
  readonly data: Record<string, unknown>;
  readonly receivedAt: Date;
}

/**
 * Port interface for the payment rail (Stripe in MVP).
 * ADR-012: BB never uses Stripe Customer Balance or Treasury as the wallet;
 * this port handles only PaymentIntent lifecycle and refunds.
 * PROPERTY_COLLECT / UPSTREAM_PLATFORM_COLLECT bookings skip this port
 * entirely — no PaymentIntent is created for money BB never touched (ADR-020).
 */
export interface PaymentPort {
  createIntent(req: CreatePaymentIntentRequest): Promise<PaymentIntent>;
  authorizeIntent(intentId: string, idempotencyKey: string): Promise<PaymentIntent>;
  captureIntent(intentId: string, idempotencyKey: string): Promise<PaymentIntent>;
  cancelIntent(intentId: string, idempotencyKey: string): Promise<PaymentIntent>;
  refund(req: RefundRequest): Promise<Refund>;
  handleWebhookEvent(rawBody: string, signature: string): Promise<WebhookEvent>;
}
