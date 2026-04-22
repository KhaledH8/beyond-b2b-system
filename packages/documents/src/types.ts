/**
 * ADR-016 + ADR-020 amendment.
 * COMMISSION_INVOICE: BB → supplier/upstream, monotonic per
 * (tenant, supplier_id, fiscal_year), separate from gapless legal-tax sequences.
 */
export type DocumentType =
  | 'TAX_INVOICE'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE'
  | 'BB_BOOKING_CONFIRMATION'
  | 'BB_VOUCHER'
  | 'RESELLER_GUEST_CONFIRMATION'
  | 'RESELLER_GUEST_VOUCHER'
  | 'COMMISSION_INVOICE';

export type DocumentStatus = 'DRAFT' | 'ISSUED' | 'DELIVERED' | 'FAILED';

export type DeliveryChannel = 'EMAIL' | 'WEBHOOK' | 'DOWNLOAD';
export type DeliveryStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface LegalEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly legalName: string;
  readonly taxId?: string;
  readonly jurisdictionCode: string;
  readonly isActive: boolean;
}

/**
 * Gapless counter for legal tax documents (TAX_INVOICE, CREDIT_NOTE, DEBIT_NOTE).
 * Monotonic counter for COMMISSION_INVOICE (keyed by supplierId instead of legalEntityId).
 */
export interface DocumentNumberSequence {
  readonly id: string;
  readonly tenantId: string;
  readonly documentType: DocumentType;
  readonly scopeKey: string;
  readonly jurisdictionCode: string;
  readonly fiscalYear: number;
  readonly lastIssuedNumber: number;
  readonly prefix: string;
}

export interface BookingDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly bookingId: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly status: DocumentStatus;
  readonly objectStorageKey?: string;
  readonly contentHash?: string;
  readonly issuedAt?: Date;
  readonly createdAt: Date;
}

export interface DeliveryAttempt {
  readonly id: string;
  readonly documentId: string;
  readonly channel: DeliveryChannel;
  readonly status: DeliveryStatus;
  readonly attemptedAt: Date;
  readonly errorMessage?: string;
}
