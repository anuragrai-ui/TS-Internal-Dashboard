import { getCache, setCache } from "@/lib/cache";
import { normalizePersonName } from "@/lib/oncall/shifts";
import { slackRead } from "@/lib/slackApi";

import type { SlackReadResult } from "@/lib/slackApi";
import type { OnCallPerson } from "@/lib/workspace/types";

/**
 * Calendar people -> Slack user ids, so the on-call pill can offer a direct
 * message link. The calendar only has names (from the event title) or email
 * addresses (guests), and the bot lacks users:read.email, so emails in the
 * directory are usually absent and most matches are by name.
 *
 * Matching is deliberately conservative - a wrong DM link is worse than
 * none: an exact email, else exactly one person with that full name, else
 * exactly one person with that first and last name; anything ambiguous
 * stays unresolved.
 *
 * The directory is one users.list walk (200 per page, at most 10 pages),
 * cached a day with only id / names / email - never profiles or photos.
 */

export interface SlackDirectoryUser {
  displayName: string;
  email?: string;
  id: string;
  realName: string;
}

export interface CachedDirectory {
  /* False when a page failed or the page cap was hit: cached briefly, so a fixed scope shows up soon. */
  complete: boolean;
  users: SlackDirectoryUser[];
}

interface UsersListMember {
  deleted?: boolean;
  id?: string;
  is_app_user?: boolean;
  is_bot?: boolean;
  name?: string;
  profile?: { display_name?: string; email?: string; real_name?: string };
  real_name?: string;
}

export interface UsersListPage {
  error?: string;
  members?: UsersListMember[];
  ok: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackDirectoryDeps {
  cacheGet: () => Promise<CachedDirectory | null>;
  cacheSet: (value: CachedDirectory, ttlSeconds: number) => Promise<void>;
  read: (params: Record<string, string>) => Promise<SlackReadResult<UsersListPage>>;
}

const DIRECTORY_CACHE_KEY = "oncall:slack_directory";
const DIRECTORY_TTL_SECONDS = 86_400;
const PARTIAL_TTL_SECONDS = 900;
const PAGE_LIMIT = "200";
const MAX_PAGES = 10;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/** users.list members -> directory entries: people only (no deleted accounts, bots, apps or Slackbot). */
export function toDirectoryUsers(members: readonly UsersListMember[]): SlackDirectoryUser[] {
  const users: SlackDirectoryUser[] = [];
  for (const member of members) {
    if (!member.id || !SLACK_USER_ID.test(member.id) || member.id === "USLACKBOT" || member.deleted || member.is_bot || member.is_app_user) {
      continue;
    }
    const realName = member.profile?.real_name || member.real_name || member.name || "";
    const displayName = member.profile?.display_name || "";
    const email = member.profile?.email?.trim().toLowerCase();
    if (!realName && !displayName && !email) {
      continue;
    }
    users.push({ displayName, ...(email ? { email } : {}), id: member.id, realName });
  }
  return users;
}

function nameTokens(name: string): string[] {
  return normalizePersonName(name).split(" ").filter(Boolean);
}

function uniqueId(ids: Iterable<string>): string | undefined {
  const distinct = new Set(ids);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

/**
 * The one Slack user a calendar person is, or undefined: exact email, else a
 * unique full-name match (real or display name), else a unique first + last
 * name match ("Tarang Somani" = "Tarang Kumar Somani"). A single-word name
 * matches only a display name or real name of that one word, and only when
 * no one else in the workspace shares that first name.
 */
export function matchSlackUserId(person: Pick<OnCallPerson, "email" | "name">, users: readonly SlackDirectoryUser[]): string | undefined {
  const email = person.email?.trim().toLowerCase();
  if (email) {
    const byEmail = uniqueId(users.filter((user) => user.email === email).map((user) => user.id));
    if (byEmail) {
      return byEmail;
    }
  }

  const full = normalizePersonName(person.name);
  if (!full) {
    return undefined;
  }
  const tokens = full.split(" ");
  const byName = uniqueId(
    users.filter((user) => normalizePersonName(user.realName) === full || normalizePersonName(user.displayName) === full).map((user) => user.id),
  );
  if (byName && tokens.length >= 2) {
    return byName;
  }
  if (tokens.length < 2) {
    /* A lone first name ("FF US - Martin") counts only when exactly one person could be meant: nobody else has that first name. */
    const couldBe = uniqueId(users.filter((user) => nameTokens(user.realName)[0] === full || normalizePersonName(user.displayName) === full).map((user) => user.id));
    return byName && couldBe === byName ? byName : undefined;
  }
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return uniqueId(
    users
      .filter((user) =>
        [user.realName, user.displayName].some((name) => {
          const candidate = nameTokens(name);
          return candidate.length >= 2 && candidate[0] === first && candidate[candidate.length - 1] === last;
        }),
      )
      .map((user) => user.id),
  );
}

/** People with slackUserId filled in where the directory names exactly one match. Pure. */
export function resolveSlackUserIdsIn(people: readonly OnCallPerson[], users: readonly SlackDirectoryUser[]): OnCallPerson[] {
  return people.map((person) => {
    if (person.slackUserId) {
      return person;
    }
    const id = matchSlackUserId(person, users);
    return id ? { ...person, slackUserId: id } : person;
  });
}

function defaultDeps(): SlackDirectoryDeps {
  return {
    cacheGet: async () => (await getCache<CachedDirectory>(DIRECTORY_CACHE_KEY))?.value ?? null,
    cacheSet: (value, ttlSeconds) => setCache(DIRECTORY_CACHE_KEY, value, ttlSeconds),
    read: (params) => slackRead<UsersListPage>("users.list", params),
  };
}

/** The directory with explicit deps - what the tests drive. Never throws on a Slack failure (returns what it has). */
export async function loadSlackDirectoryWith(deps: SlackDirectoryDeps): Promise<SlackDirectoryUser[]> {
  const cached = await deps.cacheGet();
  if (cached) {
    return cached.users;
  }

  const users: SlackDirectoryUser[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await deps.read({ limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    if (!result.ok || !result.data) {
      if (page === 0) {
        console.warn(`On-call: Slack users.list failed (${result.error ?? "unknown"}); people won't get Slack links for now.`);
      }
      break;
    }
    users.push(...toDirectoryUsers(result.data.members ?? []));
    cursor = result.data.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      complete = true;
      break;
    }
  }

  /* A failed or partial walk is still worth a short cache: no Slack call per request while a scope is missing. */
  await deps.cacheSet({ complete, users }, complete ? DIRECTORY_TTL_SECONDS : PARTIAL_TTL_SECONDS);
  return users;
}

/** The workspace's people (id and names), cached a day. Empty - never throws - when Slack won't say. */
export async function loadSlackDirectory(): Promise<SlackDirectoryUser[]> {
  try {
    return await loadSlackDirectoryWith(defaultDeps());
  } catch (error) {
    console.warn("On-call: couldn't load the Slack directory.", error instanceof Error ? error.message : error);
    return [];
  }
}

/** Fills slackUserId for every person the directory matches unambiguously. Never throws; unmatched people are returned as they were. */
export async function resolveSlackUserIds(people: readonly OnCallPerson[]): Promise<OnCallPerson[]> {
  if (people.length === 0) {
    return [];
  }
  try {
    return resolveSlackUserIdsIn(people, await loadSlackDirectory());
  } catch {
    return [...people];
  }
}
