import { MIGRATIONS } from "@/lib/db/migrations";
import { sql } from "@/lib/db/sql";

import type { Migration } from "@/lib/db/migrations";
import type { SqlExecutor, SqlStatement } from "@/lib/db/sql";

/**
 * Applies pending migrations, in order, exactly once across every
 * concurrently starting instance.
 *
 * Why pg_advisory_xact_lock and not pg_advisory_lock: over Neon's HTTP
 * driver each request is its own session, so a session lock taken in one
 * request is released (or orphaned on a pooled backend) before the DDL in
 * the next one runs. Instead each migration is ONE transaction that starts
 * by taking a transaction-scoped advisory lock, runs its statements and
 * records itself in schema_migrations. Two instances racing on the same
 * migration serialize on the lock; the loser's INSERT into schema_migrations
 * then hits the primary key and its whole transaction rolls back, after
 * which it re-reads what is applied and carries on. No step depends on the
 * lock being held across requests.
 */

/* Arbitrary app-wide constant (fits a bigint); only migrations take this lock. */
export const MIGRATION_LOCK_KEY = "5454534341534553";

const CREATE_MIGRATIONS_TABLE = sql(
  "migrations.create_table",
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`,
);

const LIST_APPLIED = sql("migrations.list_applied", "SELECT version FROM schema_migrations ORDER BY version");

/**
 * Throws unless versions are 1..n, strictly increasing, with no gaps or
 * duplicates. A broken list must fail before any DDL runs.
 */
export function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration list is out of order: position ${index + 1} holds version ${migration.version} (${migration.name}).`);
    }
    if (migration.statements.length === 0) {
      throw new Error(`Migration ${migration.version} (${migration.name}) has no statements.`);
    }
  });
}

/** The migrations not yet in `applied`, oldest first. Throws if the database is ahead of this build. */
export function pendingMigrations(migrations: readonly Migration[], applied: ReadonlySet<number>): Migration[] {
  const latest = migrations.at(-1)?.version ?? 0;
  const ahead = [...applied].filter((version) => version > latest);
  if (ahead.length > 0) {
    /* An older deployment must not run against a schema it doesn't know; reads may still work, so this is loud, not silent. */
    throw new Error(`The database has migrations this build does not know (${ahead.join(", ")}); deploy the newer build.`);
  }
  return migrations.filter((migration) => !applied.has(migration.version));
}

/** The statements of one migration's transaction: lock, DDL, then the bookkeeping row. */
export function migrationTransaction(migration: Migration): SqlStatement[] {
  return [
    sql("migrations.lock", "SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]),
    ...migration.statements.map((text, index) => sql(`migrations.v${migration.version}.${index}`, text)),
    /* Deliberately no ON CONFLICT: a duplicate must abort the transaction (see the module comment). */
    sql("migrations.record", "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]),
  ];
}

async function appliedVersions(db: SqlExecutor): Promise<Set<number>> {
  const rows = await db.query<{ version: number | string }>(LIST_APPLIED);
  return new Set(rows.map((row) => Number(row.version)));
}

/**
 * Applies every pending migration. Returns the versions this call applied
 * (empty when the schema was already current). Throws on failure - callers
 * go through ensureMigrated, which turns that into a retry on the next call.
 */
export async function runMigrations(db: SqlExecutor, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  validateMigrations(migrations);
  await db.query(CREATE_MIGRATIONS_TABLE);

  const appliedNow: number[] = [];
  let applied = await appliedVersions(db);

  for (const migration of pendingMigrations(migrations, applied)) {
    /* Re-checked per migration: another instance may have applied it while we ran the previous one. */
    if (applied.has(migration.version)) {
      continue;
    }
    try {
      await db.transaction(migrationTransaction(migration));
      appliedNow.push(migration.version);
      applied.add(migration.version);
    } catch (error) {
      applied = await appliedVersions(db);
      if (!applied.has(migration.version)) {
        throw error;
      }
      /* Lost the race: someone else applied it, and our transaction rolled back cleanly. */
    }
  }
  return appliedNow;
}

const migrated = new WeakMap<SqlExecutor, Promise<void>>();

/**
 * runMigrations once per executor per instance. Concurrent callers share the
 * in-flight run; a failed run is forgotten so the next call tries again
 * (rather than wedging the instance until it is recycled).
 */
export function ensureMigrated(db: SqlExecutor, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  let running = migrated.get(db);
  if (!running) {
    running = runMigrations(db, migrations).then(
      (versions) => {
        if (versions.length > 0) {
          console.info(`Case store: applied migrations ${versions.join(", ")}.`);
        }
      },
      (error: unknown) => {
        migrated.delete(db);
        throw error;
      },
    );
    migrated.set(db, running);
  }
  return running;
}
