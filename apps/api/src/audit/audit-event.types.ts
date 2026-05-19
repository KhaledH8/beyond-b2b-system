/**
 * ADR-028 D4 / D7 — audit event type system.
 *
 * Every event written to audit_event must be expressed as one of the
 * variants below. Adding a new kind requires:
 *   1. A new union member here.
 *   2. A payload interface below (even if the payload is empty — use {}).
 *   3. Bump AUDIT_SCHEMA_VERSION for that kind in the comment next to
 *      its declaration if the shape changes in a breaking way.
 *
 * The AuditEventInputBackground type is the compile-time enforcement
 * of the ADR-028 D7 emission rule: background emit() is permissible
 * only for APP and SECURITY. Calling emit() with AUTH, IMPERSONATION,
 * or SENSITIVE_ACCESS is a TypeScript type error. The runtime guard in
 * AuditService is a second layer of defence for misuse via type casts.
 *
 * SENSITIVE_ACCESS kinds are V1.1 and not yet defined here; the
 * category partition tree exists in the migration. When V1.1 lands,
 * add kinds to this file and they will automatically be excluded from
 * AuditEventInputBackground (the Extract picks only APP | SECURITY).
 */

// ── Schema version ────────────────────────────────────────────────────
// Increment when any kind's payload shape changes in a breaking way.
// Old rows at prior schema_version are never migrated; readers handle
// multiple versions per kind.
export const AUDIT_SCHEMA_VERSION = 1 as const;

// ── Payload types ─────────────────────────────────────────────────────

// APP
export interface BookingCreatedPayload {
  readonly bookingId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly bookingReference: string;
  readonly sourceOfferSnapshotId: string | null;
  readonly supplier: string;
  readonly supplierRawRef: string;
  readonly sellAmountMinorUnits: string;
  readonly sellCurrency: string;
  readonly status: 'INITIATED';
}
export interface BookingSupplierBookedPayload {
  readonly bookingId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly bookingReference: string;
  readonly supplierRef: string;
  readonly supplierBookingRef: string;
  readonly supplierStatus: 'CONFIRMED' | 'ON_REQUEST';
  readonly mode: 'FIXTURE';
}
export interface BookingDocumentCreatedPayload {
  readonly documentId: string;
  readonly bookingId: string;
  readonly tenantId: string;
  readonly documentType: 'BB_BOOKING_CONFIRMATION';
  readonly documentNumber: string;
  readonly status: 'ISSUED';
  readonly contentHash: string;
  readonly objectStorageKey: string;
  readonly sequenceId: string;
  readonly allocatedNumber: string;
}
export interface BookingConfirmedPayload {
  readonly bookingId: string;
  /**
   * Retained for backward compatibility. Populated from the booking's
   * `supplier_ref` (the supplier identifier selected at intake);
   * `supplier` below carries the same value with a clearer name.
   */
  readonly supplierId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly bookingReference: string;
  readonly sourceOfferSnapshotId: string | null;
  readonly supplier: string;
  readonly supplierRawRef: string;
  readonly sellAmountMinorUnits: string;
  readonly sellCurrency: string;
  /** FX-lock row id when one was written this confirm; null otherwise. */
  readonly fxLockId: string | null;
  readonly status: 'CONFIRMED';
}
export interface BookingCancelledPayload {
  readonly bookingId: string;
  readonly reason?: string;
}
export interface LedgerEntryPostedPayload {
  readonly entryId: string;
  readonly amount: string;
  readonly currency: string;
}
export interface MarkupRuleEditedPayload {
  readonly ruleId: string;
  readonly changeKind: 'CREATE' | 'PATCH' | 'SOFT_DELETE';
}

// AUTH
export interface UserProvisionedPayload {
  readonly auth0Sub: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  readonly email: string;
}
export interface UserDeactivatedPayload {
  readonly auth0Sub: string;
  readonly reason?: string;
}
export interface RoleGrantedPayload {
  readonly roleId: string;
  readonly roleName: string;
  readonly grantedToUserId: string;
}
export interface RoleRevokedPayload {
  readonly roleId: string;
  readonly roleName: string;
  readonly revokedFromUserId: string;
}
export interface MembershipChangedPayload {
  readonly previousAccountId?: string;
  readonly newAccountId?: string;
}
export interface ApiKeyIssuedPayload {
  readonly keyId: string;
  readonly label?: string;
}
export interface ApiKeyRevokedPayload {
  readonly keyId: string;
  readonly reason?: string;
}

// IMPERSONATION
export interface ImpersonationStartedPayload {
  readonly grantId: string;
  readonly targetAccountId: string;
  readonly targetAccountName: string;
  readonly targetAccountType: string;
  readonly ticketRef: string;
  readonly reason?: string;
}
export interface ImpersonationEndedPayload {
  readonly grantId: string;
  readonly endReason: 'MANUAL' | 'TTL_EXPIRED' | 'REQUEST_END';
}
export interface ImpersonationStartRejectedPayload {
  readonly targetAccountId: string;
  readonly rejectReason: string;
  readonly denyListEntry?: string;
}

// SECURITY
export interface WebhookSignatureFailedPayload {
  readonly source: string;
  readonly headerPresent: boolean;
}
export interface InternalKeyRejectedPayload {
  readonly endpoint: string;
}
export interface AuditQueryExecutedPayload {
  readonly endpoint: 'LIST' | 'DETAIL';
  readonly filters?: {
    readonly actorUserId?: string;
    readonly targetKind?: string;
    readonly targetId?: string;
    readonly requestId?: string;
    readonly impersonationGrantId?: string;
    readonly category?: string;
    readonly kind?: string;
    readonly from?: string;
    readonly to?: string;
  };
  readonly fetchedEventId?: string;
  readonly resultCount?: number;
  readonly requiredPermission: 'AUDIT_READ' | 'AUDIT_READ_SENSITIVE';
}
export interface AuditPartitionDroppedPayload {
  readonly partitionName: string;
  readonly category: string;
  readonly partitionMonth: string;
  readonly rowCountEst?: number;
  readonly retentionRule: string;
}

// ── Discriminated union ───────────────────────────────────────────────

export type AuditEventInput =
  // ── APP — background emission permissible ─────────────────────────
  | { category: 'APP'; kind: 'BOOKING_CREATED';     tenantId: string; targetId: string; payload: BookingCreatedPayload }
  | { category: 'APP'; kind: 'BOOKING_SUPPLIER_BOOKED'; tenantId: string; targetId: string; payload: BookingSupplierBookedPayload }
  | { category: 'APP'; kind: 'BOOKING_CONFIRMED';   tenantId: string; targetId: string; payload: BookingConfirmedPayload }
  | { category: 'APP'; kind: 'BOOKING_DOCUMENT_CREATED'; tenantId: string; targetId: string; payload: BookingDocumentCreatedPayload }
  | { category: 'APP'; kind: 'BOOKING_CANCELLED';   tenantId: string; targetId: string; payload: BookingCancelledPayload }
  | { category: 'APP'; kind: 'LEDGER_ENTRY_POSTED'; tenantId: string; targetId: string; payload: LedgerEntryPostedPayload }
  | { category: 'APP'; kind: 'MARKUP_RULE_EDITED';  tenantId: string; targetId: string; payload: MarkupRuleEditedPayload }

  // ── AUTH — emitInTransaction REQUIRED ─────────────────────────────
  | { category: 'AUTH'; kind: 'USER_PROVISIONED';   tenantId: string; targetId: string; payload: UserProvisionedPayload }
  | { category: 'AUTH'; kind: 'USER_DEACTIVATED';   tenantId: string; targetId: string; payload: UserDeactivatedPayload }
  | { category: 'AUTH'; kind: 'ROLE_GRANTED';        tenantId: string; targetId: string; payload: RoleGrantedPayload }
  | { category: 'AUTH'; kind: 'ROLE_REVOKED';        tenantId: string; targetId: string; payload: RoleRevokedPayload }
  | { category: 'AUTH'; kind: 'MEMBERSHIP_CHANGED'; tenantId: string; targetId: string; payload: MembershipChangedPayload }
  | { category: 'AUTH'; kind: 'API_KEY_ISSUED';     tenantId: string; targetId: string; payload: ApiKeyIssuedPayload }
  | { category: 'AUTH'; kind: 'API_KEY_REVOKED';    tenantId: string; targetId: string; payload: ApiKeyRevokedPayload }

  // ── IMPERSONATION — emitInTransaction REQUIRED ────────────────────
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_STARTED';        tenantId: string; targetId: string; payload: ImpersonationStartedPayload }
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_ENDED';          tenantId: string; targetId: string; payload: ImpersonationEndedPayload }
  | { category: 'IMPERSONATION'; kind: 'IMPERSONATION_START_REJECTED'; tenantId: string; targetId: string; payload: ImpersonationStartRejectedPayload }

  // ── SECURITY — background emission permissible ────────────────────
  | { category: 'SECURITY'; kind: 'WEBHOOK_SIGNATURE_FAILED';       tenantId: string; payload: WebhookSignatureFailedPayload }
  | { category: 'SECURITY'; kind: 'INTERNAL_KEY_REJECTED';          tenantId: string; payload: InternalKeyRejectedPayload }
  | { category: 'SECURITY'; kind: 'AUDIT_QUERY_EXECUTED';           tenantId: string; payload: AuditQueryExecutedPayload }
  | { category: 'SECURITY'; kind: 'AUDIT_QUERY_EXECUTED_SENSITIVE'; tenantId: string; payload: AuditQueryExecutedPayload }
  | { category: 'SECURITY'; kind: 'AUDIT_PARTITION_DROPPED';        tenantId: string; payload: AuditPartitionDroppedPayload };

/**
 * The subset of AuditEventInput that may be emitted via the background
 * queue (AuditService.emit). Restricted to APP and SECURITY categories.
 *
 * AUTH, IMPERSONATION, and SENSITIVE_ACCESS (V1.1) are excluded:
 * calling emit() with those categories is a compile-time TypeScript
 * error. A runtime guard in AuditService provides a second layer of
 * defence for callers that bypass the type system via casts.
 */
export type AuditEventInputBackground = Extract<
  AuditEventInput,
  { category: 'APP' | 'SECURITY' }
>;
