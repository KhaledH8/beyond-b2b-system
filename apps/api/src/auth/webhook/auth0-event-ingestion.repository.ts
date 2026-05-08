import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';

/**
 * Idempotency ledger for Auth0 webhook events (Slice E2-B).
 *
 * The `auth0_event_ingestion` table (created in the E2-A migration)
 * has a single PK column, `log_id`. A second insert of the same
 * `log_id` raises a Postgres unique_violation (SQLSTATE 23505) and
 * tells the handler "this event has already been processed".
 *
 * The handler writes the event side-effects (e.g. updating
 * `core_user.email`) and the idempotency row in the same transaction,
 * so a crash between side-effect and ledger write either rolls both
 * back or commits both. A retried delivery from Auth0 will then find
 * the ledger row and skip cleanly.
 */
@Injectable()
export class Auth0EventIngestionRepository {
  /**
   * Returns true iff the row was inserted (i.e. this is the first
   * time we've seen this `log_id`); false on unique_violation. Other
   * SQL errors propagate.
   */
  async tryRecord(
    q: Queryable,
    logId: string,
    eventType: string,
  ): Promise<boolean> {
    try {
      await q.query(
        `INSERT INTO auth0_event_ingestion (log_id, event_type) VALUES ($1, $2)`,
        [logId, eventType],
      );
      return true;
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === '23505'
      ) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Test-only check that a `log_id` has been recorded. Production
   * code does not need this — the insert path returns the answer
   * authoritatively. Exposed so integration tests can assert
   * idempotency without re-driving the handler.
   */
  async exists(q: Queryable, logId: string): Promise<boolean> {
    const { rows } = await q.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM auth0_event_ingestion WHERE log_id = $1) AS exists`,
      [logId],
    );
    return rows[0]?.exists === true;
  }
}
