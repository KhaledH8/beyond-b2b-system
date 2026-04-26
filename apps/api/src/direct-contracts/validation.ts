import { BadRequestException } from '@nestjs/common';

// Re-export shared helpers from the admin validation module.
export {
  asObject,
  optionalString,
  optionalUlid,
  rejectExtraKeys,
  requireString,
  requireUlid,
  requireUlidQuery,
  requireEnum,
  optionalEnum,
  requireInt,
  optionalInt,
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
