import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import { CoreUserRepository } from '../user-sync/user.repository';
import { Auth0EventIngestionRepository } from './auth0-event-ingestion.repository';

/**
 * Processes Auth0 Log Streams webhook payloads (Slice E2-B).
 *
 * A delivery is an array of log entries; each entry has its own
 * `log_id` and `type` short-code. We dedupe per `log_id` using the
 * ingestion ledger and apply known event types' side-effects to the
 * `core_user` mirror. Unknown types are recorded in the ledger but
 * have no side-effects — that way Auth0 does not retry indefinitely
 * for events we do not care about.
 *
 * Recognised types (V1 — additive list, see ADR-026 D9):
 *
 *   - `sce` Successful Change Email   → update `core_user.email`
 *   - `scu` Successful Change Username → update `core_user.email`
 *           (Auth0 emits `scu` on email-as-username flows; we treat
 *            both forms as an email refresh)
 *   - `scn` Successful Change Name    → update `core_user.display_name`
 *   - `sd`  Successful User Delete    → set status = DEACTIVATED
 *   - `sapi` admin actions on users
 *           with `description` containing 'Block User' / 'Unblock User'
 *           → set status accordingly
 *
 * Anything else: record in ledger, log at debug, skip.
 *
 * Side-effects are idempotent at the SQL level: a re-applied profile
 * update lands the same value; a re-applied `setStatus` is a no-op
 * if the column already holds it. The ledger is the protection
 * against multiple deliveries; the SQL semantics are the protection
 * against partial transactional failure.
 *
 * Per-entry isolation: each log entry runs in its own transaction so
 * a malformed entry in the middle of a batch does not roll back the
 * preceding entries.
 */
@Injectable()
export class Auth0EventHandlerService {
  private readonly logger = new Logger(Auth0EventHandlerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CoreUserRepository) private readonly users: CoreUserRepository,
    @Inject(Auth0EventIngestionRepository)
    private readonly ledger: Auth0EventIngestionRepository,
  ) {}

  async handleBatch(payload: unknown): Promise<HandleBatchSummary> {
    const entries = extractLogEntries(payload);
    const summary: HandleBatchSummary = {
      received: entries.length,
      applied: 0,
      duplicates: 0,
      skipped: 0,
      malformed: 0,
    };
    for (const entry of entries) {
      try {
        const outcome = await this.handleOne(entry);
        if (outcome === 'APPLIED') summary.applied += 1;
        else if (outcome === 'DUPLICATE') summary.duplicates += 1;
        else summary.skipped += 1;
      } catch (err) {
        // Malformed or processing error on a single entry: record in
        // the summary, log, and keep going. Throwing here would force
        // Auth0 to retry the *whole batch*; that punishes well-formed
        // entries that already succeeded.
        summary.malformed += 1;
        this.logger.warn(
          `Auth0 event entry failed: ${(err as Error).message}`,
        );
      }
    }
    return summary;
  }

  private async handleOne(entry: Record<string, unknown>): Promise<EntryOutcome> {
    const logId = readString(entry, 'log_id');
    const type = readString(entry, 'type');
    if (!logId) throw new Error('log entry missing log_id');
    if (!type) throw new Error('log entry missing type');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await this.ledger.tryRecord(client, logId, type);
      if (!inserted) {
        await client.query('COMMIT');
        return 'DUPLICATE';
      }
      const sub = readEventSub(entry);
      let applied = false;
      switch (type) {
        case 'sce':
        case 'scu': {
          const newEmail = readEventDetail(entry, 'newEmail') ??
            readEventDetail(entry, 'new_email');
          if (sub && typeof newEmail === 'string' && newEmail.length > 0) {
            await this.users.updateProfile(client, sub, { email: newEmail });
            applied = true;
          }
          break;
        }
        case 'scn': {
          const newName = readEventDetail(entry, 'newName') ??
            readEventDetail(entry, 'new_name');
          if (sub && typeof newName === 'string') {
            await this.users.updateProfile(client, sub, {
              displayName: newName.length === 0 ? null : newName,
            });
            applied = true;
          }
          break;
        }
        case 'sd': {
          if (sub) {
            await this.users.setStatus(client, sub, 'DEACTIVATED');
            applied = true;
          }
          break;
        }
        case 'sapi': {
          // Auth0 logs admin Management API actions as `sapi`. The
          // `description` field carries a human-readable action name.
          const desc = readString(entry, 'description');
          if (sub && typeof desc === 'string') {
            const lowered = desc.toLowerCase();
            // Order matters: 'unblock user' contains the substring
            // 'block user', so the unblock branch must be checked
            // first (or we'd treat every unblock as a deactivation).
            if (lowered.includes('unblock user')) {
              await this.users.setStatus(client, sub, 'ACTIVE');
              applied = true;
            } else if (lowered.includes('block user')) {
              await this.users.setStatus(client, sub, 'DEACTIVATED');
              applied = true;
            }
          }
          break;
        }
        default:
          // Unknown but well-formed event: ledger row prevents future
          // re-delivery from re-checking. No side-effect.
          break;
      }
      await client.query('COMMIT');
      return applied ? 'APPLIED' : 'SKIPPED';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface HandleBatchSummary {
  received: number;
  applied: number;
  duplicates: number;
  skipped: number;
  malformed: number;
}

type EntryOutcome = 'APPLIED' | 'DUPLICATE' | 'SKIPPED';

function extractLogEntries(payload: unknown): readonly Record<string, unknown>[] {
  // Auth0's webhook stream wraps each batch in `{ logs: [...] }` for
  // the standard log streams; some destinations receive a bare array.
  // Accept both, plus a single-object short-form.
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>;
    const logs = obj['logs'];
    if (Array.isArray(logs)) return logs as Record<string, unknown>[];
    return [obj];
  }
  return [];
}

function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readEventSub(entry: Record<string, unknown>): string | undefined {
  // Auth0 places the affected user_id in different shapes per event.
  // Walk known locations.
  const directSub = readString(entry, 'user_id');
  if (directSub) return directSub;
  const data = entry['data'];
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    const fromData = readString(d, 'user_id') ?? readString(d, 'sub');
    if (fromData) return fromData;
  }
  return undefined;
}

function readEventDetail(
  entry: Record<string, unknown>,
  key: string,
): string | undefined {
  const direct = entry[key];
  if (typeof direct === 'string') return direct;
  const data = entry['data'];
  if (typeof data === 'object' && data !== null) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  const details = entry['details'];
  if (typeof details === 'object' && details !== null) {
    const v = (details as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
