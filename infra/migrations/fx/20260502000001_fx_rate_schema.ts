import type { Knex } from 'knex';

/**
 * ADR-024 C1: FX strategy — schema only.
 *
 * Three tables that form the audit + operational foundation for the
 * three-tier FX model. No service code, no Nest changes, no search
 * integration. Booking-time FX lock (booking_fx_lock) is deferred to
 * the C5 migration.
 *
 * Tables (creation order follows FK dependency):
 *   1. fx_provider_credentials — API key references per provider
 *   2. fx_rate_snapshot        — OXR + ECB rate snapshots
 *   3. fx_application          — per-conversion audit log; FKs into #2
 *
 * Design decisions recorded here (ADR-024 D7–D8):
 *
 *   No tenant_id on any of these tables. The FX layer is platform-wide
 *   in v1 (ADR-024 D8). Per-tenant provider selection, if ever needed,
 *   is a follow-up ADR; the schema change at that point is small (add
 *   nullable tenant_id to fx_provider_credentials and add a resolution
 *   rule). Starting with tenant_id NULL would be a premature column
 *   (CLAUDE.md §7).
 *
 *   fx_application.rate_snapshot_id is NOT NULL. Every recorded
 *   conversion must trace to a stored snapshot — this is the audit
 *   invariant. A degraded conversion (both OXR and ECB unavailable)
 *   produces no fx_application row at all; the response meta carries
 *   provider='NONE' / degraded=true in that case (ADR-024 C4).
 *
 *   fx_provider_credentials.api_key_ref stores an env-var name in dev
 *   (e.g. 'OXR_APP_ID') or a secret-manager path in prod. The raw
 *   API key is never stored in this column. This mirrors the pattern
 *   used for INTERNAL_API_KEY elsewhere in the project.
 *
 *   The UNIQUE constraint on fx_rate_snapshot creates a B-tree index
 *   on (provider, base_currency, quote_currency, observed_at). The
 *   lookup query — newest row within a freshness TTL for a given
 *   (provider, base, quote) — is satisfied by scanning this index in
 *   reverse on observed_at, so no additional lookup index is needed.
 *
 * Rollback drops in reverse FK dependency order.
 */
export async function up(knex: Knex): Promise<void> {
  // --- fx_provider_credentials -----------------------------------------------
  //
  // One row per provider (OXR, ECB stub, etc.). Created first because
  // no other table references it as a FK, but it is logically the
  // root of the provider configuration.
  //
  // api_key_ref: the value is a reference to the real key, not the
  // key itself — in dev this is an env-var name, in prod a secret-
  // manager path. The runtime resolves the reference; this column
  // never stores raw credentials.

  await knex.raw(`
    CREATE TABLE fx_provider_credentials (
      id          CHAR(26)     NOT NULL,
      provider    VARCHAR(16)  NOT NULL,
      api_key_ref VARCHAR(256) NOT NULL,
      is_active   BOOLEAN      NOT NULL DEFAULT true,

      CONSTRAINT fx_provider_credentials_pk          PRIMARY KEY (id),
      CONSTRAINT fx_provider_credentials_provider_uq UNIQUE (provider)
    )
  `);

  // --- fx_rate_snapshot -------------------------------------------------------
  //
  // Append-only store of OXR and ECB rate observations. One row per
  // (provider, base_currency, quote_currency, observed_at) — the UNIQUE
  // constraint enforces idempotency so the ECB and OXR sync jobs can
  // upsert safely on repeated calls for the same publication date/time.
  //
  // observed_at: when the provider published the rate (ECB uses
  // T16:00:00Z for the daily publication; OXR uses the timestamp
  // embedded in the API response). This is distinct from fetched_at
  // (when we wrote the row), which matters for audit and TTL logic:
  // TTL windows key on observed_at, not fetched_at.
  //
  // raw_payload_ref: object-storage reference to the provider's raw
  // response blob. Null in C1/C2 — the object-storage integration for
  // raw payload archiving is a later audit enhancement. The column is
  // present now so the schema does not need to change when that lands.

  await knex.raw(`
    CREATE TABLE fx_rate_snapshot (
      id              CHAR(26)      NOT NULL,
      provider        VARCHAR(16)   NOT NULL,
      base_currency   CHAR(3)       NOT NULL,
      quote_currency  CHAR(3)       NOT NULL,
      rate            NUMERIC(18,8) NOT NULL,
      observed_at     TIMESTAMPTZ   NOT NULL,
      fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
      raw_payload_ref VARCHAR(256),

      CONSTRAINT fx_rate_snapshot_pk           PRIMARY KEY (id),
      CONSTRAINT fx_rate_snapshot_provider_chk CHECK (provider IN ('OXR', 'ECB')),
      CONSTRAINT fx_rate_snapshot_rate_chk     CHECK (rate > 0),
      CONSTRAINT fx_rate_snapshot_uq           UNIQUE (provider, base_currency, quote_currency, observed_at)
    )
  `);

  // --- fx_application ---------------------------------------------------------
  //
  // Audit record of every FX conversion applied by the platform.
  // Append-only. The service layer writes one row per unique
  // (source_currency, display_currency, rate_snapshot_id) combination
  // used in a given request, not one row per converted rate — callers
  // deduplicate before writing to avoid N rows per search response.
  //
  // rate_snapshot_id is NOT NULL: every conversion must trace to a
  // stored snapshot. There is no "estimated" or "inline" conversion
  // path; if no snapshot exists the conversion is skipped entirely
  // and no fx_application row is written.
  //
  // application_kind distinguishes search-time conversions (eligible
  // for time-bound retention pruning) from booking-display conversions
  // (retained for the full booking lifetime per ADR-024 D7).
  //
  // request_correlation_ref: the searchId (kind='SEARCH') or bookingId
  // (kind='BOOKING_DISPLAY') from the owning request. Opaque to this
  // table; used for join-back lookups in audit tooling.

  await knex.raw(`
    CREATE TABLE fx_application (
      id                       CHAR(26)      NOT NULL,
      applied_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
      provider                 VARCHAR(16)   NOT NULL,
      source_currency          CHAR(3)       NOT NULL,
      display_currency         CHAR(3)       NOT NULL,
      rate                     NUMERIC(18,8) NOT NULL,
      rate_snapshot_id         CHAR(26)      NOT NULL,
      application_kind         VARCHAR(16)   NOT NULL,
      request_correlation_ref  VARCHAR(64),

      CONSTRAINT fx_application_pk           PRIMARY KEY (id),
      CONSTRAINT fx_application_snapshot_fk  FOREIGN KEY (rate_snapshot_id)
                                             REFERENCES fx_rate_snapshot(id),
      CONSTRAINT fx_application_provider_chk CHECK (provider IN ('OXR', 'ECB')),
      CONSTRAINT fx_application_kind_chk     CHECK (application_kind IN (
                                               'SEARCH',
                                               'BOOKING_DISPLAY'
                                             )),
      CONSTRAINT fx_application_rate_chk     CHECK (rate > 0)
    )
  `);

  // Retention pruning and per-request audit queries both scan on
  // (application_kind, applied_at). SEARCH rows can be pruned after
  // their retention window; BOOKING_DISPLAY rows are retained longer.
  // DESC on applied_at puts the most recent rows first for the pruning
  // job and for "what FX was used in the last N searches" queries.
  await knex.raw(`
    CREATE INDEX fx_application_kind_applied_idx
    ON fx_application (application_kind, applied_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Reverse FK dependency order:
  //   fx_application references fx_rate_snapshot → drop first
  //   fx_rate_snapshot is standalone              → drop second
  //   fx_provider_credentials is standalone       → drop third
  await knex.raw('DROP TABLE IF EXISTS fx_application');
  await knex.raw('DROP TABLE IF EXISTS fx_rate_snapshot');
  await knex.raw('DROP TABLE IF EXISTS fx_provider_credentials');
}
