import type { QueryResult, QueryResultRow } from '@bb/db';

/**
 * Narrow subset of `pg`'s `Pool` / `PoolClient` query surface — just
 * the `query(text, values?)` method. Both `Pool` and `PoolClient`
 * satisfy this structurally, so a repository method can accept a
 * `Queryable` and the caller decides which to pass:
 *
 *   - The pool itself, for one-shot reads outside any transaction:
 *
 *       const booking = await repo.loadById(this.pool, id);
 *
 *   - A checked-out client mid-transaction, when the read or write
 *     must commit or roll back as part of a larger unit of work:
 *
 *       const client = await this.pool.connect();
 *       try {
 *         await client.query('BEGIN');
 *         const result = await repo.markConfirmed(client, id);
 *         await client.query('COMMIT');
 *       } catch (err) {
 *         await client.query('ROLLBACK').catch(() => undefined);
 *         throw err;
 *       } finally {
 *         client.release();
 *       }
 *
 * Tests pass a hand-rolled `{ query: vi.fn() }` matching the same
 * shape, so unit tests do not need a real pg connection.
 *
 * Locked design choice (ADR-024 C5c plan): introduce one shared
 * `Queryable` rather than splitting every repository signature into
 * `Pool`-flavoured and `PoolClient`-flavoured variants.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}
