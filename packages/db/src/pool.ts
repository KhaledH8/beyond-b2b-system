import { Pool, types } from 'pg';

// pg parses DATE (OID 1082) as a Date object by default, which causes
// timezone-based date drift when serialized to JSON. Return the raw
// YYYY-MM-DD string instead, matching the DB column semantics.
types.setTypeParser(1082, (val: string) => val);

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
