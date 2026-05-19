import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import { DocumentRepository } from '../document.repository';

/**
 * Integration tests for the two `doc_` tables. Real Postgres; skipped
 * cleanly when DATABASE_URL is absent.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const d = HAS_DATABASE ? describe : describe.skip;

d('DocumentRepository — number sequence', () => {
  let pool: Pool;
  const repo = new DocumentRepository();

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function tenant(): Promise<string> {
    const id = newUlid();
    const slug = `doc-${id.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1,$2,$3)`,
      [id, slug, `Doc Tenant ${slug}`],
    );
    return id;
  }

  it('allocates monotonically (1, 2, 3) for the same scope', async () => {
    const t = await tenant();
    const a = await repo.allocateNumber(pool, {
      tenantId: t,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    const b = await repo.allocateNumber(pool, {
      tenantId: t,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    expect(a.allocatedNumber).toBe(1);
    expect(b.allocatedNumber).toBe(2);
    expect(a.sequenceId).toBe(b.sequenceId);
  });

  it('isolates counters per tenant', async () => {
    const t1 = await tenant();
    const t2 = await tenant();
    await repo.allocateNumber(pool, {
      tenantId: t1,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    const t2first = await repo.allocateNumber(pool, {
      tenantId: t2,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    expect(t2first.allocatedNumber).toBe(1);
  });

  it('isolates counters per document type', async () => {
    const t = await tenant();
    await repo.allocateNumber(pool, {
      tenantId: t,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    const other = await repo.allocateNumber(pool, {
      tenantId: t,
      documentType: 'BB_VOUCHER',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-VCH',
    });
    expect(other.allocatedNumber).toBe(1);
  });

  it('a rolled-back allocation does not advance the committed counter', async () => {
    const t = await tenant();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await repo.allocateNumber(client, {
        tenantId: t,
        documentType: 'BB_BOOKING_CONFIRMATION',
        scopeKey: 'TENANT',
        fiscalYear: 2026,
        prefix: 'BB-CONF',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const after = await repo.allocateNumber(pool, {
      tenantId: t,
      documentType: 'BB_BOOKING_CONFIRMATION',
      scopeKey: 'TENANT',
      fiscalYear: 2026,
      prefix: 'BB-CONF',
    });
    expect(after.allocatedNumber).toBe(1);
  });
});

d('DocumentRepository — doc_booking_document', () => {
  let pool: Pool;
  const repo = new DocumentRepository();

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedBooking(): Promise<{
    tenantId: string;
    bookingId: string;
  }> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const hotelId = newUlid();
    const bookingId = newUlid();
    const slug = `docb-${tenantId.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1,$2,$3)`,
      [tenantId, slug, `DocB ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1,$2,'AGENCY','DocB Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1,'DocB Hotel','AE')`,
      [hotelId],
    );
    await pool.query(
      `INSERT INTO booking_booking (
         id, tenant_id, account_id, canonical_hotel_id,
         collection_mode, supplier_settlement_mode, payment_cost_model,
         check_in, check_out, reference, status, guest_details,
         sell_amount_minor_units, sell_currency
       ) VALUES (
         $1,$2,$3,$4,
         'BB_COLLECTS','PREPAID_BALANCE','PLATFORM_CARD_FEE',
         '2026-07-01','2026-07-04',$5,'CONFIRMED','{}'::jsonb,
         25000,'USD'
       )`,
      [bookingId, tenantId, accountId, hotelId, `BB-${slug}`],
    );
    return { tenantId, bookingId };
  }

  it('inserts an ISSUED doc and replay finds it', async () => {
    const { tenantId, bookingId } = await seedBooking();
    const inserted = await repo.insertIssued(pool, {
      tenantId,
      bookingId,
      documentType: 'BB_BOOKING_CONFIRMATION',
      documentNumber: 'BB-CONF-2026-00001',
      objectStorageKey: 'documents/x.json',
      contentHash: 'b'.repeat(64),
      contentSchemaVersion: 1,
    });
    expect(inserted.status).toBe('ISSUED');
    const found = await repo.findByBookingAndType(
      pool,
      bookingId,
      'BB_BOOKING_CONFIRMATION',
    );
    expect(found?.id).toBe(inserted.id);
  });

  it('blocks UPDATE and DELETE on an ISSUED row (immutable trigger)', async () => {
    const { tenantId, bookingId } = await seedBooking();
    const doc = await repo.insertIssued(pool, {
      tenantId,
      bookingId,
      documentType: 'BB_BOOKING_CONFIRMATION',
      documentNumber: 'BB-CONF-2026-00002',
      objectStorageKey: 'documents/y.json',
      contentHash: 'c'.repeat(64),
      contentSchemaVersion: 1,
    });
    await expect(
      pool.query(
        `UPDATE doc_booking_document SET status='FAILED' WHERE id=$1`,
        [doc.id],
      ),
    ).rejects.toThrow(/ISSUED and cannot be modified/);
    await expect(
      pool.query(`DELETE FROM doc_booking_document WHERE id=$1`, [doc.id]),
    ).rejects.toThrow(/ISSUED and cannot be deleted/);
  });

  it('the (booking_id, document_type) unique constraint blocks a double-issue', async () => {
    const { tenantId, bookingId } = await seedBooking();
    await repo.insertIssued(pool, {
      tenantId,
      bookingId,
      documentType: 'BB_BOOKING_CONFIRMATION',
      documentNumber: 'BB-CONF-2026-00003',
      objectStorageKey: 'documents/z.json',
      contentHash: 'd'.repeat(64),
      contentSchemaVersion: 1,
    });
    await expect(
      repo.insertIssued(pool, {
        tenantId,
        bookingId,
        documentType: 'BB_BOOKING_CONFIRMATION',
        documentNumber: 'BB-CONF-2026-00004',
        objectStorageKey: 'documents/z2.json',
        contentHash: 'e'.repeat(64),
        contentSchemaVersion: 1,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
