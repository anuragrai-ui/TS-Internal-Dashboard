import type { JiraCredentials } from "@/lib/jiraClient";
import { getCurrentUser } from "@/lib/jiraClient";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { decryptSecret, encryptSecret, isTokenEncryptionConfigured } from "@/lib/tokenCrypto";

/**
 * Lets each team member register their own Jira API token so a follow-up
 * comment on their ticket posts under their own Jira identity instead of the
 * shared service account - see the "Per-Team-Member Jira Tokens" README
 * section. Routing is by ticket ASSIGNEE, not by "who is browsing" (this app
 * has no login/session concept at all - see AppShell.tsx's getCurrentUser()
 * call, which always resolves to the shared service account): whoever a
 * ticket is assigned to is whoever's token (if registered) posts the
 * follow-up, regardless of who clicked Send. This matches the actual
 * request - "so everyone can take action on their own tickets" - without
 * needing to build real authentication for a small internal team.
 */
export interface RegisteredJiraUser {
  accountId: string;
  displayName: string;
  email: string;
  registeredAt: string;
}

interface StoredUserToken extends RegisteredJiraUser {
  encryptedApiToken: string;
}

const REGISTERED_USERS_SET_KEY = "jira_user_tokens:accounts";

function tokenKey(accountId: string): string {
  return `jira_user_tokens:token:${accountId}`;
}

/* The exact slice of the Redis client this module touches - injectable so
   the store/list/remove logic can be unit-tested against a small in-memory
   fake instead of a real Upstash instance, matching the DI pattern used
   elsewhere in this codebase (getAuditEntries, resolveMentionTarget, etc.). */
export interface UserTokenStore {
  del: (key: string) => Promise<unknown>;
  get: <T>(key: string) => Promise<T | null>;
  sadd: (key: string, member: string) => Promise<unknown>;
  smembers: (key: string) => Promise<string[]>;
  set: (key: string, value: unknown) => Promise<unknown>;
  srem: (key: string, member: string) => Promise<unknown>;
}

/* Not a default parameter value: getRedis() must only run after the
   isRedisConfigured() guard in each function below has already passed - a
   default parameter is evaluated eagerly on every call that omits it, which
   would call getRedis() (and construct a client from possibly-unset env
   vars) even when the intent is to short-circuit before touching Redis at
   all. Each function resolves `store ?? resolveStore()` inside its body,
   after its own guard. */
function resolveStore(): UserTokenStore {
  return getRedis();
}

export type RegisterTokenResult =
  | { ok: true; user: RegisteredJiraUser }
  | { error: string; ok: false };

/**
 * Validates the given email+token pair against Jira's own `/myself` (proves
 * the token actually works and belongs to whoever is registering it - never
 * trusted blindly from the form), then stores it encrypted, keyed by the
 * account id Jira itself returns for that token.
 */
export async function registerUserJiraToken(
  email: string,
  apiToken: string,
  verifyCredentials: (credentials: JiraCredentials) => Promise<{
    account_id?: string;
    display_name?: string;
    email?: string;
  }> = getCurrentUser,
  store?: UserTokenStore,
): Promise<RegisterTokenResult> {
  if (!isRedisConfigured()) {
    return { error: "Redis is not configured - per-user Jira tokens require it to persist.", ok: false };
  }
  if (!isTokenEncryptionConfigured()) {
    return { error: "TOKEN_ENCRYPTION_KEY is not configured on the server - cannot store tokens safely.", ok: false };
  }

  const activeStore = store ?? resolveStore();

  let currentUser: Awaited<ReturnType<typeof verifyCredentials>>;
  try {
    currentUser = await verifyCredentials({ apiToken, email });
  } catch {
    return { error: "That email/API token pair was rejected by Jira - double-check both and try again.", ok: false };
  }

  if (!currentUser.account_id) {
    return { error: "Jira didn't return an account id for this token - cannot register it.", ok: false };
  }

  const record: StoredUserToken = {
    accountId: currentUser.account_id,
    displayName: currentUser.display_name ?? email,
    email: currentUser.email ?? email,
    encryptedApiToken: encryptSecret(apiToken),
    registeredAt: new Date().toISOString(),
  };

  await activeStore.set(tokenKey(record.accountId), record);
  await activeStore.sadd(REGISTERED_USERS_SET_KEY, record.accountId);

  return {
    ok: true,
    user: {
      accountId: record.accountId,
      displayName: record.displayName,
      email: record.email,
      registeredAt: record.registeredAt,
    },
  };
}

/** Returns the credentials to use for posting to a ticket assigned to `accountId`, or null if that person hasn't registered one (or the account/store isn't configured) - callers fall back to the shared service account in that case. */
export async function getJiraCredentialsForAccount(
  accountId: string | undefined,
  store?: UserTokenStore,
): Promise<JiraCredentials | null> {
  if (!accountId || !isRedisConfigured() || !isTokenEncryptionConfigured()) {
    return null;
  }

  try {
    const record = await (store ?? resolveStore()).get<StoredUserToken>(tokenKey(accountId));
    if (!record) {
      return null;
    }
    return { apiToken: decryptSecret(record.encryptedApiToken), email: record.email };
  } catch (error) {
    console.warn(`Failed to read/decrypt the registered Jira token for account ${accountId}.`, error);
    return null;
  }
}

export async function listRegisteredJiraUsers(store?: UserTokenStore): Promise<RegisteredJiraUser[]> {
  if (!isRedisConfigured()) {
    return [];
  }

  try {
    const activeStore = store ?? resolveStore();
    const accountIds = await activeStore.smembers(REGISTERED_USERS_SET_KEY);
    if (accountIds.length === 0) {
      return [];
    }

    const records = await Promise.all(accountIds.map((id) => activeStore.get<StoredUserToken>(tokenKey(id))));

    return records
      .filter((record): record is StoredUserToken => record !== null)
      .map(({ accountId, displayName, email, registeredAt }) => ({ accountId, displayName, email, registeredAt }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch (error) {
    console.warn("Failed to list registered Jira users.", error);
    return [];
  }
}

export async function removeUserJiraToken(accountId: string, store?: UserTokenStore): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  const activeStore = store ?? resolveStore();
  await activeStore.del(tokenKey(accountId));
  await activeStore.srem(REGISTERED_USERS_SET_KEY, accountId);
}
