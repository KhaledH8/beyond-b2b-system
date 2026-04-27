import { BadRequestException } from '@nestjs/common';

// Re-export shared helpers from the admin validation module.
export {
  asObject,
  optionalString,
  optionalUlid,
  optionalIsoTimestamp,
  rejectExtraKeys,
  requireString,
  requireUlid,
  requireUlidQuery,
  requireEnum,
  optionalEnum,
  requireInt,
  optionalInt,
  requireIsoTimestamp,
  ENUM_STATUS,
} from '../admin/validation';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const ENUM_CONTRACT_PATCH_STATUS = new Set<'ACTIVE' | 'INACTIVE'>([
  'ACTIVE',
  'INACTIVE',
]);

export const ENUM_CONTRACT_LIST_STATUS = new Set<
  'DRAFT' | 'ACTIVE' | 'INACTIVE'
>(['DRAFT', 'ACTIVE', 'INACTIVE']);

export function requireIsoDate(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(`${key} must be an ISO 8601 date (YYYY-MM-DD)`);
  }
  return v;
}

export function optionalIsoDate(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new BadRequestException(`${key} must be a string when present`);
  }
  if (!ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(`${key} must be an ISO 8601 date (YYYY-MM-DD)`);
  }
  return v;
}

export function requireCurrency(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || !CURRENCY_RE.test(v)) {
    throw new BadRequestException(
      `${key} must be a 3-letter ISO 4217 currency code (e.g. USD)`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Restriction (ADR-023) — kind enum + per-kind params validators
// ---------------------------------------------------------------------------

export const RESTRICTION_KINDS = [
  'STOP_SELL',
  'CTA',
  'CTD',
  'MIN_LOS',
  'MAX_LOS',
  'ADVANCE_PURCHASE_MIN',
  'ADVANCE_PURCHASE_MAX',
  'RELEASE_HOURS',
  'CUTOFF_HOURS',
] as const;

export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const ENUM_RESTRICTION_KIND: ReadonlySet<RestrictionKind> =
  new Set<RestrictionKind>(RESTRICTION_KINDS);

/**
 * Kinds that may NOT be authored on a contract-scoped restriction in
 * Phase B. RELEASE_HOURS / CUTOFF_HOURS are channel-manager push
 * concepts (ADR-023 D3) and there is no real channel-manager use
 * case yet. Supplier-default writes accept them so the model stays
 * unified for the day a channel-manager adapter ships.
 */
export const RESTRICTION_KINDS_FORBIDDEN_FOR_CONTRACT_SCOPED: ReadonlySet<RestrictionKind> =
  new Set<RestrictionKind>(['RELEASE_HOURS', 'CUTOFF_HOURS']);

/**
 * Read `body.params` and require it be a JSON object (or absent →
 * empty object). Returns the raw params for downstream per-kind
 * structural validation.
 */
export function requireParamsObject(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const v = body['params'];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new BadRequestException('params must be a JSON object');
  }
  return v as Record<string, unknown>;
}

/**
 * Service-layer params shape validation for ADR-023 D3. The DB only
 * CHECKs the `restriction_kind` enum value; everything below is the
 * application's responsibility.
 *
 * - STOP_SELL / CTA / CTD: params must be `{}`.
 * - MIN_LOS:                 `{ min_los: <int >= 1> }`.
 * - MAX_LOS:                 `{ max_los: <int >= 1> }`.
 * - ADVANCE_PURCHASE_MIN/MAX: `{ days: <int >= 0> }`.
 * - RELEASE_HOURS / CUTOFF_HOURS: `{ hours: <int >= 0> }`.
 */
export function validateRestrictionParams(
  kind: RestrictionKind,
  params: Record<string, unknown>,
): void {
  switch (kind) {
    case 'STOP_SELL':
    case 'CTA':
    case 'CTD':
      assertEmptyParams(kind, params);
      return;
    case 'MIN_LOS':
      assertExactIntKey(kind, params, 'min_los', { min: 1 });
      return;
    case 'MAX_LOS':
      assertExactIntKey(kind, params, 'max_los', { min: 1 });
      return;
    case 'ADVANCE_PURCHASE_MIN':
    case 'ADVANCE_PURCHASE_MAX':
      assertExactIntKey(kind, params, 'days', { min: 0 });
      return;
    case 'RELEASE_HOURS':
    case 'CUTOFF_HOURS':
      assertExactIntKey(kind, params, 'hours', { min: 0 });
      return;
  }
}

function assertEmptyParams(
  kind: RestrictionKind,
  params: Record<string, unknown>,
): void {
  if (Object.keys(params).length > 0) {
    throw new BadRequestException(
      `params must be an empty object for restriction kind ${kind}`,
    );
  }
}

function assertExactIntKey(
  kind: RestrictionKind,
  params: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): void {
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== key) {
    throw new BadRequestException(
      `params for restriction kind ${kind} must contain exactly the key "${key}"`,
    );
  }
  const v = params[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BadRequestException(`params.${key} must be an integer`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new BadRequestException(`params.${key} must be ≥ ${opts.min}`);
  }
  if (opts.max !== undefined && v > opts.max) {
    throw new BadRequestException(`params.${key} must be ≤ ${opts.max}`);
  }
}

// ---------------------------------------------------------------------------
// Cancellation policy windows (ADR-023 D5)
// ---------------------------------------------------------------------------

export const CANCELLATION_FEE_TYPES = [
  'PERCENT_OF_TOTAL',
  'FLAT',
  'FIRST_NIGHT',
] as const;

export type CancellationFeeType = (typeof CANCELLATION_FEE_TYPES)[number];

const CANCELLATION_FEE_TYPE_SET: ReadonlySet<CancellationFeeType> =
  new Set<CancellationFeeType>(CANCELLATION_FEE_TYPES);

const CANCELLATION_WINDOW_KEYS: ReadonlyArray<string> = [
  'from_hours_before',
  'to_hours_before',
  'fee_type',
  'fee_value',
  'fee_currency',
];

/**
 * Service-layer structural validator for `windows_jsonb` (ADR-023 D5).
 * The DB stores the array as opaque JSONB; this is the single line of
 * defense against malformed entries reaching the resolver in B6.
 *
 * What this validates:
 *   - non-empty array
 *   - each window is a JSON object with only the allowed keys
 *   - `from_hours_before`: non-negative integer or null
 *     (null = "any time before the adjacent window" per ADR-023 D5)
 *   - `to_hours_before`: non-negative integer (required)
 *   - if `from_hours_before` is non-null, it must be ≥ `to_hours_before`
 *     (a window covers `[to, from]` hours-before-stay)
 *   - `fee_type`: enum {PERCENT_OF_TOTAL | FLAT | FIRST_NIGHT}
 *   - `fee_value`: non-negative number or null (null/0 = free per ADR D5)
 *   - `fee_currency`: 3-letter ISO 4217 string when present (only meaningful for FLAT)
 *
 * What this deliberately does NOT validate:
 *   - array ordering (the resolver in B6 owns ordering semantics)
 *   - window overlap or gap detection
 *   - fee_type-specific bounds (e.g., percent ≤ 100) — left to the
 *     resolver / fee engine when those land
 *   - fee_currency requirement-per-fee_type
 */
export function validateCancellationWindows(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('windows must be a non-empty JSON array');
  }
  for (let i = 0; i < value.length; i++) {
    const w = value[i];
    if (typeof w !== 'object' || w === null || Array.isArray(w)) {
      throw new BadRequestException(`windows[${i}] must be a JSON object`);
    }
    const obj = w as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
      if (!CANCELLATION_WINDOW_KEYS.includes(key)) {
        throw new BadRequestException(
          `windows[${i}]: unknown field "${key}". Allowed: ${CANCELLATION_WINDOW_KEYS.join(', ')}`,
        );
      }
    }

    const fromRaw = obj['from_hours_before'];
    let fromHours: number | null;
    if (fromRaw === null || fromRaw === undefined) {
      fromHours = null;
    } else if (typeof fromRaw === 'number' && Number.isInteger(fromRaw) && fromRaw >= 0) {
      fromHours = fromRaw;
    } else {
      throw new BadRequestException(
        `windows[${i}].from_hours_before must be a non-negative integer or null`,
      );
    }

    const toRaw = obj['to_hours_before'];
    if (typeof toRaw !== 'number' || !Number.isInteger(toRaw) || toRaw < 0) {
      throw new BadRequestException(
        `windows[${i}].to_hours_before must be a non-negative integer`,
      );
    }

    if (fromHours !== null && fromHours < toRaw) {
      throw new BadRequestException(
        `windows[${i}].from_hours_before must be ≥ to_hours_before`,
      );
    }

    const feeType = obj['fee_type'];
    if (
      typeof feeType !== 'string' ||
      !CANCELLATION_FEE_TYPE_SET.has(feeType as CancellationFeeType)
    ) {
      throw new BadRequestException(
        `windows[${i}].fee_type must be one of: ${CANCELLATION_FEE_TYPES.join(', ')}`,
      );
    }

    const feeValue = obj['fee_value'];
    if (feeValue !== null && feeValue !== undefined) {
      if (typeof feeValue !== 'number' || feeValue < 0) {
        throw new BadRequestException(
          `windows[${i}].fee_value must be a non-negative number or null`,
        );
      }
    }

    const feeCurrency = obj['fee_currency'];
    if (feeCurrency !== null && feeCurrency !== undefined) {
      if (typeof feeCurrency !== 'string' || !/^[A-Z]{3}$/.test(feeCurrency)) {
        throw new BadRequestException(
          `windows[${i}].fee_currency must be a 3-letter ISO 4217 currency code or null`,
        );
      }
    }
  }
}
