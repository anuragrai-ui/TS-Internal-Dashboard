import { neon } from "@neondatabase/serverless";

import { ensureMigrated } from "@/lib/db/migrate";

import type { DbResult, SqlExecutor, SqlStatement } from "@/lib/db/sql";

export { sql } from "@/lib/db/sql";
export type { DbResult, SqlExecutor, SqlStatement } from "@/lib/db/sql";

/**
 * The case store's only door to Postgres (Neon).
 *
 * Neon's HTTP driver is used rather than a pooled TCP client: every query is
 * one HTTPS round trip with no socket to keep alive, which is what a Vercel
 * function that lives for a few seconds wants. The cost is that there are no
 * interactive sessions - a multi-statement unit of work goes out as one
 * non-interactive transaction (SqlExecutor.transaction), and session-level
 * state (SET, pg_advisory_lock) does not outlive a single request. migrate.ts
 * is written around that.
 *
 * Everything else in src/lib/cases talks to the SqlExecutor interface, never
 * to neon() directly, so scripts/test-cases.ts can run the whole sync over an
 * in-memory fake. Each statement carries a stable `name` the fake dispatches
 * on; the real executor ignores it.
 *
 * DATABASE_URL (pooled) is preferred; DATABASE_URL_UNPOOLED is the fallback.
 * Neither is set locally, and every caller degrades to "not configured"
 * rather than failing when they are absent.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
/* Migrations run DDL under an advisory lock that may have to wait for another instance. */
const TRANSACTION_TIMEOUT_MS = 30_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function connectionString(env: Record<string, string | undefined>): string | undefined {
  return nonEmpty(env.DATABASE_URL) ?? nonEmpty(env.DATABASE_URL_UNPOOLED);
}

/** Whether a Postgres connection string is configured. `env` is injectable for tests. */
export function isDatabaseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return connectionString(env) !== undefined;
}

/* Driver and fetch errors can echo the connection string (and so the
   password). Anything that may end up in a log, sync_state or an API
   response passes through here first. */
const CONNECTION_STRING_PATTERN = /postgres(?:ql)?:\/\/[^\s"'`]+/gi;

/** Error text with any connection string (and the configured password) removed. */
export function redactDbError(error: unknown, env: Record<string, string | undefined> = process.env): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(CONNECTION_STRING_PATTERN, "postgres://[redacted]");
  const url = connectionString(env);
  if (url) {
    try {
      const password = decodeURIComponent(new URL(url).password);
      if (password.length >= 4) {
        text = text.split(password).join("[redacted]");
      }
    } catch {
      /* Not a parseable URL - the pattern above already covered the common shape. */
    }
  }
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/** A SqlExecutor over Neon's HTTP driver, with a timeout on every round trip. */
export function createNeonExecutor(url: string, opts: { timeoutMs?: number; transactionTimeoutMs?: number } = {}): SqlExecutor {
  const client = neon(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transactionTimeoutMs = opts.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS;

  return {
    async query<T extends object>(statement: SqlStatement): Promise<T[]> {
      const rows: unknown = await client.query(statement.text, statement.params, {
        fetchOptions: { signal: AbortSignal.timeout(timeoutMs) },
      });
      return rows as T[];
    },
    async transaction(statements: SqlStatement[]): Promise<Array<Array<Record<string, unknown>>>> {
      if (statements.length === 0) {
        return [];
      }
      const results: unknown = await client.transaction(
        (txn) => statements.map((statement) => txn.query(statement.text, statement.params)),
        { fetchOptions: { signal: AbortSignal.timeout(transactionTimeoutMs) } },
      );
      return results as Array<Array<Record<string, unknown>>>;
    },
  };
}

let rawExecutor: SqlExecutor | null = null;
let migratedExecutor: SqlExecutor | null = null;

/**
 * The process-wide executor, created on first use, that runs pending
 * migrations (once per instance) before its first statement. Null when no
 * database is configured - callers report "not configured" instead of failing.
 */
export function getDb(): SqlExecutor | null {
  if (migratedExecutor) {
    return migratedExecutor;
  }
  const url = connectionString(process.env);
  if (!url) {
    return null;
  }
  rawExecutor ??= createNeonExecutor(url);
  migratedExecutor = withMigrations(rawExecutor);
  return migratedExecutor;
}

/** Wraps an executor so the first statement on it waits for ensureMigrated. Exported for tests. */
export function withMigrations(executor: SqlExecutor): SqlExecutor {
  return {
    async query<T extends object>(statement: SqlStatement): Promise<T[]> {
      await ensureMigrated(executor);
      return executor.query<T>(statement);
    },
    async transaction(statements: SqlStatement[]): Promise<Array<Array<Record<string, unknown>>>> {
      await ensureMigrated(executor);
      return executor.transaction(statements);
    },
  };
}

/**
 * Runs `fn` against the configured database and turns every failure into a
 * DbResult. Never throws; errors are logged (redacted) under `label`.
 */
export async function withDb<T>(label: string, fn: (db: SqlExecutor) => Promise<T>, db: SqlExecutor | null = getDb()): Promise<DbResult<T>> {
  if (!db) {
    return { error: "The case store database is not configured (DATABASE_URL is unset).", ok: false };
  }
  try {
    return { ok: true, value: await fn(db) };
  } catch (error) {
    const message = redactDbError(error);
    console.warn(`Case store: ${label} failed.`, message);
    return { error: message, ok: false };
  }
}

/* ------------------------------------------------------------ row helpers */

/** A timestamptz column as an ISO string, whether the driver returned a Date or text. Null stays null. */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A bigint/int/numeric column as a number (Postgres bigint arrives as a string). Null stays null. */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Text column, or null. */
export function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" ? String(value) : null;
}
