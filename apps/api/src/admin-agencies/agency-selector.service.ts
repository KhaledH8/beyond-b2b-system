import { Inject, Injectable } from '@nestjs/common';
import {
  AgencySelectorRepository,
  type AgencySummaryRow,
} from './agency-selector.repository';

/**
 * Default page size when the caller does not pass `limit`.
 * ADR-027 V1.1 agency-selector: keep it small enough that the operator
 * always sees a manageable initial list without scrolling.
 */
const DEFAULT_LIMIT = 20;

/**
 * Hard ceiling. Larger limits get clamped here; the controller therefore
 * cannot accept a manipulated `?limit=1000` and DoS the DB.
 */
const MAX_LIMIT = 50;

export interface AgencySummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface ListAgenciesInput {
  /** The caller's tenant — sourced from `AuthContext.tenantId`. */
  readonly tenantId: string;
  /** Optional search string. The service trims; the repo treats `''` as "no filter". */
  readonly q?: string;
  /** Optional caller-supplied limit; clamped to 1..50 (default 20). */
  readonly limit?: number;
}

export interface ListAgenciesResult {
  readonly accounts: AgencySummary[];
}

@Injectable()
export class AgencySelectorService {
  constructor(
    @Inject(AgencySelectorRepository)
    private readonly repo: AgencySelectorRepository,
  ) {}

  async listAgencies(input: ListAgenciesInput): Promise<ListAgenciesResult> {
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    const limit = clampLimit(input.limit);

    const rows = await this.repo.listActiveAgencies({
      tenantId: input.tenantId,
      q,
      limit,
    });
    return { accounts: rows.map(toSummary) };
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

function toSummary(row: AgencySummaryRow): AgencySummary {
  return { id: row.id, name: row.name, status: row.status };
}
