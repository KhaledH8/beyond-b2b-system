import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';

/**
 * Integration tests for the audit_event append-only triggers
 * (ADR-028 D2.b).
 *
 * Verifies that BEFORE UPDATE and BEFORE DELETE triggers fire for
 * the connected role (the table owner in local dev / CI) and raise
 * the expected exception, preserving the append-only invariant in
 * environments where the role-level grant restriction does not apply.
 *
 * These tests intentionally drive the DB error path — they expect
 * specific exception messages.
 *
 * Skipped cleanly when DATABASE_URL is absent (unit-test-only runs).
 *
 * NOTE: The trigger fires for ALL roles including the table owner.
 * In production the primary defence is the role-level grant
 * (bb_app lacks UPDATE/DELETE). In local dev and CI, the trigger
 * is the sole enforcer. Both this test and that production constraint
 * are required by ADR-028 D2.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('audit_event append-only trigger (integration)', () => {
  let pool: Pool;
  let insertedId: string;
  let insertedOccurredAt: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

    // Insert a row that subsequent tests will attempt to mutate.
    // Uses ANONYMOUS actor_kind so no actor_user_id constraint fires.
    insertedId = newUlid();
    // Use a fixed timestamp in the current month so the partition exists.
    // The migration creates partitions for the current and next calendar month.
    const now = new Date().toISOString();
    insertedOccurredAt = now;

    await pool.query(
      `INSERT INTO audit_event (
         id, occurred_at, recorded_at, schema_version,
         category, kind, tenant_id,
         actor_kind, payload
       ) VALUES ($1, $2, $3, 1, 'SECURITY', 'TRIGGER_TEST', $4, 'ANONYMOUS', '{}')`,
      [insertedId, now, now, newUlid()],
    );
  }, 15_000);

  afterAll(async () => {
    // We cannot DELETE the test row — that is the whole point of the
    // trigger. Clean up by truncating the entire table in a raw
    // TRUNCATE (not a DELETE) which bypasses row-level triggers.
    // This is acceptable in a test-only database.
    // Note: in production, bb_app lacks TRUNCATE; in CI the owner
    // user has it. The trigger only fires on row-level UPDATE/DELETE.
    if (pool) {
      try {
        await pool.query('TRUNCATE TABLE audit_event CASCADE');
      } catch {
        // If truncate is not permitted, the test row will remain
        // in the test DB. That is acceptable — it is a valid audit
        // event row and causes no harm.
      }
      await pool.end();
    }
  });

  it('INSERT into audit_event succeeds and the row is readable', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM audit_event WHERE id = $1`,
      [insertedId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(insertedId);
  });

  it('UPDATE on audit_event raises the append-only exception', async () => {
    await expect(
      pool.query(
        `UPDATE audit_event SET kind = 'MUTATED' WHERE id = $1`,
        [insertedId],
      ),
    ).rejects.toThrow(/audit_event is append-only/);
  });

  it('DELETE on audit_event raises the append-only exception', async () => {
    await expect(
      pool.query(
        `DELETE FROM audit_event WHERE id = $1`,
        [insertedId],
      ),
    ).rejects.toThrow(/audit_event is append-only/);
  });

  it('row is unchanged after failed UPDATE and DELETE attempts', async () => {
    // Confirm the trigger raises before any mutation is applied.
    const { rows } = await pool.query<{ kind: string }>(
      `SELECT kind FROM audit_event WHERE id = $1`,
      [insertedId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('TRIGGER_TEST');
  });
});
