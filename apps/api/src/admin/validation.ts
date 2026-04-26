import { BadRequestException } from '@nestjs/common';
import type { AccountType } from '@bb/domain';

/**
 * Hand-rolled validators shared by the admin controllers.
 *
 * The admin surface is small and deliberately type-precise about
 * primitives (ULIDs, decimal strings, ISO timestamps, enums). We
 * avoid `class-validator` here for the same reasons as the rest of
 * the API — minimal runtime deps, validation co-located with each
 * controller's request shape.
 */

const ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'B2C',
  'AGENCY',
  'SUBSCRIBER',
  'CORPORATE',
]);

const PROMOTION_KINDS: ReadonlySet<'PROMOTED' | 'RECOMMENDED' | 'FEATURED'> =
  new Set<'PROMOTED' | 'RECOMMENDED' | 'FEATURED'>([
    'PROMOTED',
    'RECOMMENDED',
    'FEATURED',
  ]);

const STATUS_VALUES: ReadonlySet<'ACTIVE' | 'INACTIVE'> = new Set<
  'ACTIVE' | 'INACTIVE'
>(['ACTIVE', 'INACTIVE']);

const SCOPE_VALUES: ReadonlySet<'ACCOUNT' | 'HOTEL' | 'CHANNEL'> = new Set<
  'ACCOUNT' | 'HOTEL' | 'CHANNEL'
>(['ACCOUNT', 'HOTEL', 'CHANNEL']);

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;

export function asObject(value: unknown, label = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new BadRequestException(`Missing required string: ${key}`);
  }
  return v;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new BadRequestException(`${key} must be a string when present`);
  }
  return v;
}

export function requireUlid(obj: Record<string, unknown>, key: string): string {
  const v = requireString(obj, key);
  if (!ULID_RE.test(v)) {
    throw new BadRequestException(
      `${key} must be a 26-char Crockford-base32 ULID`,
    );
  }
  return v;
}

export function optionalUlid(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = optionalString(obj, key);
  if (v === undefined) return undefined;
  if (!ULID_RE.test(v)) {
    throw new BadRequestException(
      `${key} must be a 26-char Crockford-base32 ULID`,
    );
  }
  return v;
}

/**
 * Validates a raw query-param string (already extracted from `@Query`)
 * as a ULID. Distinct from `requireUlid` which reads from an object key.
 */
export function requireUlidQuery(
  raw: string | undefined,
  key: string,
): string {
  if (typeof raw !== 'string' || !ULID_RE.test(raw)) {
    throw new BadRequestException(
      `${key} query param must be a 26-char Crockford-base32 ULID`,
    );
  }
  return raw;
}

export function requireDecimalString(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): string {
  const v = requireString(obj, key);
  if (!DECIMAL_RE.test(v)) {
    throw new BadRequestException(
      `${key} must be a decimal string with up to 4 fractional digits`,
    );
  }
  const num = Number.parseFloat(v);
  if (opts.min !== undefined && num < opts.min) {
    throw new BadRequestException(`${key} must be ≥ ${opts.min}`);
  }
  if (opts.max !== undefined && num > opts.max) {
    throw new BadRequestException(`${key} must be ≤ ${opts.max}`);
  }
  return v;
}

export function optionalDecimalString(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): string | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return requireDecimalString(obj, key, opts);
}

export function optionalIsoTimestamp(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = optionalString(obj, key);
  if (v === undefined) return undefined;
  if (!ISO_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(`${key} must be an ISO 8601 timestamp`);
  }
  return v;
}

export function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T {
  const v = requireString(obj, key);
  if (!allowed.has(v as T)) {
    throw new BadRequestException(
      `${key} must be one of: ${Array.from(allowed).join(', ')}`,
    );
  }
  return v as T;
}

export function optionalEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return requireEnum(obj, key, allowed);
}

export function requireInt(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BadRequestException(`${key} must be an integer`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new BadRequestException(`${key} must be ≥ ${opts.min}`);
  }
  if (opts.max !== undefined && v > opts.max) {
    throw new BadRequestException(`${key} must be ≤ ${opts.max}`);
  }
  return v;
}

export function optionalInt(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return requireInt(obj, key, opts);
}

export function rejectExtraKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label = 'body',
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new BadRequestException(
        `${label}: unknown field "${key}". Allowed: ${allowed.join(', ')}`,
      );
    }
  }
}

export function ensureValidityWindow(
  validFrom: string | undefined,
  validTo: string | undefined,
): void {
  if (validFrom && validTo) {
    if (Date.parse(validTo) <= Date.parse(validFrom)) {
      throw new BadRequestException('validTo must be strictly after validFrom');
    }
  }
}

export const ENUM_ACCOUNT_TYPE = ACCOUNT_TYPES;
export const ENUM_PROMOTION_KIND = PROMOTION_KINDS;
export const ENUM_STATUS = STATUS_VALUES;
export const ENUM_SCOPE = SCOPE_VALUES;
