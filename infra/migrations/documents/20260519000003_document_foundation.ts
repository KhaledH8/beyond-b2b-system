import type { Knex } from 'knex';

/**
 * ADR-016 — Booking Documents Foundation Slice 1.
 *
 * Two additive `doc_`-prefixed tables, the minimum needed to issue a
 * structured-JSON `BB_BOOKING_CONFIRMATION` for a CONFIRMED booking:
 *
 *   doc_number_sequence   — per (tenant, document_type, scope_key)
 *                           counter. For BB_BOOKING_CONFIRMATION this
 *                           is MONOTONIC per tenant (scope_key
 *                           'TENANT'), explicitly NOT gapless: a
 *                           rolled-back issue may leave a gap, which
 *                           is acceptable for a commercial (non-legal)
 *                           document. Gapless legal-tax sequences
 *                           (TAX_INVOICE / CREDIT_NOTE / DEBIT_NOTE)
 *                           are a later, deliberate slice.
 *
 *   doc_booking_document  — one issued document per (booking_id,
 *                           document_type). Immutable once ISSUED.
 *
 * Deliberately NOT created here (later slices): doc_legal_entity,
 * doc_template, doc_delivery_attempt, doc_issue_policy, any tax-invoice
 * table.
 *
 * Purely additive. `down()` removes only what `up()` created.
 */
export async function up(knex: Knex): Promise<void> {
  // ── doc_number_sequence ────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE doc_number_sequence (
      id                 CHAR(26)     NOT NULL,
      tenant_id          CHAR(26)     NOT NULL,
      document_type      VARCHAR(48)  NOT NULL,
      scope_key          VARCHAR(128) NOT NULL,
      fiscal_year        SMALLINT,
      last_issued_number BIGINT       NOT NULL DEFAULT 0,
      prefix             VARCHAR(32)  NOT NULL,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT doc_number_sequence_pk        PRIMARY KEY (id),
      CONSTRAINT doc_number_sequence_tenant_fk FOREIGN KEY (tenant_id)
                                               REFERENCES core_tenant(id),
      CONSTRAINT doc_number_sequence_scope_uq  UNIQUE (tenant_id, document_type, scope_key),
      CONSTRAINT doc_number_sequence_num_chk   CHECK (last_issued_number >= 0)
    )
  `);

  // ── doc_booking_document ───────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE doc_booking_document (
      id                    CHAR(26)     NOT NULL,
      tenant_id             CHAR(26)     NOT NULL,
      booking_id            CHAR(26)     NOT NULL,
      document_type         VARCHAR(48)  NOT NULL,
      document_number       VARCHAR(64)  NOT NULL,
      status                VARCHAR(16)  NOT NULL,
      object_storage_key    VARCHAR(512) NOT NULL,
      content_hash          CHAR(64)     NOT NULL,
      content_schema_version SMALLINT    NOT NULL,
      issued_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT doc_booking_document_pk         PRIMARY KEY (id),
      CONSTRAINT doc_booking_document_tenant_fk  FOREIGN KEY (tenant_id)
                                                 REFERENCES core_tenant(id),
      CONSTRAINT doc_booking_document_booking_fk FOREIGN KEY (booking_id)
                                                 REFERENCES booking_booking(id),
      CONSTRAINT doc_booking_document_bk_type_uq UNIQUE (booking_id, document_type),
      CONSTRAINT doc_booking_document_status_chk CHECK (status IN
                                                   ('DRAFT', 'ISSUED', 'DELIVERED', 'FAILED'))
    )
  `);
  await knex.raw(`
    CREATE INDEX doc_booking_document_tenant_idx
    ON doc_booking_document(tenant_id)
  `);

  // ── Immutability enforcement ───────────────────────────────────────────
  // An ISSUED document is a financial-grade artefact: its number, blob
  // key, and content hash are pinned forever. Any UPDATE/DELETE of an
  // ISSUED row is a bug or an unauthorised correction path; raise
  // loudly. Corrections flow through ADR-016 credit/debit notes (a
  // later slice), never row edits.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION doc_booking_document_immutable()
    RETURNS trigger AS $$
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        IF (OLD.status = 'ISSUED') THEN
          RAISE EXCEPTION
            'doc_booking_document % is ISSUED and cannot be deleted',
            OLD.id;
        END IF;
        RETURN OLD;
      END IF;
      IF (OLD.status = 'ISSUED') THEN
        RAISE EXCEPTION
          'doc_booking_document % is ISSUED and cannot be modified',
          OLD.id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER doc_booking_document_immutable
    BEFORE UPDATE OR DELETE ON doc_booking_document
    FOR EACH ROW EXECUTE FUNCTION doc_booking_document_immutable()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'DROP TRIGGER IF EXISTS doc_booking_document_immutable ON doc_booking_document',
  );
  await knex.raw(
    'DROP FUNCTION IF EXISTS doc_booking_document_immutable()',
  );
  await knex.raw('DROP TABLE IF EXISTS doc_booking_document');
  await knex.raw('DROP TABLE IF EXISTS doc_number_sequence');
}
