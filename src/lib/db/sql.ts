/**
 * The statement and executor shapes shared by the case store. Kept apart
 * from client.ts (which owns the Neon connection) so migrate.ts can use
 * them without an import cycle.
 */

/** One parameterized statement. `name` identifies it to fakes and logs; `text` uses $1..$n placeholders. */
export interface SqlStatement {
  name: string;
  params: unknown[];
  text: string;
}

/** The slice of a SQL client the case store needs - injectable so tests run over an in-memory fake. */
export interface SqlExecutor {
  query<T extends object = Record<string, unknown>>(statement: SqlStatement): Promise<T[]>;
  /** All statements in one transaction (all or nothing); one row array per statement, in order. */
  transaction(statements: SqlStatement[]): Promise<Array<Array<Record<string, unknown>>>>;
}

/** A value or an error message - what the never-throwing wrappers return. */
export type DbResult<T> = { error: string; ok: false } | { ok: true; value: T };

/** Builds a statement. Whitespace is collapsed so logs and fakes see one line. */
export function sql(name: string, text: string, params: unknown[] = []): SqlStatement {
  return { name, params, text: text.replace(/\s+/g, " ").trim() };
}

