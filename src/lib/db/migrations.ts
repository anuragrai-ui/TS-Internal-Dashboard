/**
 * The case store's schema, as ordered migrations bundled into the build.
 *
 * SQL lives in TS constants rather than .sql files so a Vercel function
 * never reads the filesystem (traced output would have to remember to ship
 * them). Rules for adding one:
 * - append with the next `version`; never edit or reorder a migration that
 *   has shipped - migrate.ts refuses a gap or a duplicate
 * - one statement per array entry (the HTTP driver runs one statement per
 *   call); no `--` comments, since sql() collapses each to one line
 * - prefer IF NOT EXISTS so a half-understood rerun is harmless; the
 *   advisory lock + schema_migrations row is what actually makes it once-only
 *
 * Conventions: timestamptz for every instant; bigint for millisecond
 * durations; text + CHECK instead of enums (adding a value is then a plain
 * constraint swap, not ALTER TYPE).
 */

export interface Migration {
  name: string;
  statements: string[];
  version: number;
}

const V1_INITIAL: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
    source text NOT NULL DEFAULT 'jira' CHECK (source IN ('jira', 'dashboard')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id bigint REFERENCES accounts (id) ON DELETE SET NULL,
    name text NOT NULL,
    email text,
    jira_account_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS contacts_account_idx ON contacts (account_id)`,
  `CREATE TABLE IF NOT EXISTS cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    jira_key text NOT NULL UNIQUE CHECK (jira_key ~ '^[A-Z][A-Z0-9]*-[0-9]+$'),
    account_id bigint REFERENCES accounts (id) ON DELETE SET NULL,
    pod text,
    priority text,
    status_id text NOT NULL,
    status_name text NOT NULL,
    status_category text NOT NULL CHECK (status_category IN ('new', 'indeterminate', 'done')),
    assignee_account_id text,
    assignee_name text,
    reporter_contact_id bigint REFERENCES contacts (id) ON DELETE SET NULL,
    summary text NOT NULL DEFAULT '',
    description_text text NOT NULL DEFAULT '',
    content_hash text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    jira_updated timestamptz NOT NULL,
    last_synced_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
  )`,
  `CREATE INDEX IF NOT EXISTS cases_account_idx ON cases (account_id)`,
  `CREATE INDEX IF NOT EXISTS cases_open_idx ON cases (pod, status_category, priority)`,
  `CREATE INDEX IF NOT EXISTS cases_assignee_idx ON cases (assignee_account_id) WHERE assignee_account_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS cases_jira_updated_idx ON cases (jira_updated DESC)`,
  `CREATE TABLE IF NOT EXISTS case_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source IN ('jira_comment', 'slack', 'dashboard')),
    external_id text NOT NULL,
    author_name text,
    author_account_id text,
    visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
    body_text text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL,
    edited_at timestamptz,
    UNIQUE (source, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS case_messages_case_idx ON case_messages (case_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS case_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('status', 'assignee', 'priority', 'link', 'created', 'resolved', 'comment', 'action')),
    from_value text,
    to_value text,
    from_id text,
    to_id text,
    actor_name text,
    actor_account_id text,
    at timestamptz NOT NULL,
    external_id text NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS case_events_case_idx ON case_events (case_id, at)`,
  `CREATE TABLE IF NOT EXISTS case_links (
    case_id uuid NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    linked_key text NOT NULL,
    link_type text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('inward', 'outward')),
    PRIMARY KEY (case_id, linked_key, link_type)
  )`,
  `CREATE INDEX IF NOT EXISTS case_links_linked_idx ON case_links (linked_key)`,
  `CREATE TABLE IF NOT EXISTS sla_clocks (
    case_id uuid NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    metric text NOT NULL CHECK (metric IN ('first_response', 'resolution')),
    goal_ms bigint CHECK (goal_ms IS NULL OR goal_ms > 0),
    state text NOT NULL CHECK (state IN ('running', 'paused', 'met', 'breached', 'none')),
    elapsed_business_ms bigint NOT NULL DEFAULT 0 CHECK (elapsed_business_ms >= 0),
    remaining_ms bigint,
    breached_at timestamptz,
    stopped_at timestamptz,
    jira_state text,
    jira_goal_ms bigint,
    jira_remaining_ms bigint,
    jira_breached boolean,
    computed_at timestamptz NOT NULL,
    PRIMARY KEY (case_id, metric)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id uuid REFERENCES cases (id) ON DELETE SET NULL,
    actor_account_id text,
    actor_name text,
    operation text NOT NULL,
    args jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_log_case_idx ON audit_log (case_id, at) WHERE case_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC)`,
];

/** Every migration, oldest first. Append only. */
export const MIGRATIONS: readonly Migration[] = [{ name: "initial_case_store", statements: V1_INITIAL, version: 1 }];
