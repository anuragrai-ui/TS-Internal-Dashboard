import type { ParsedSla } from "@/lib/escalation/types";

/**
 * Reduces a JSM SLA (Time to Resolution, cf[10650] / servicedeskapi metric 62)
 * to ParsedSla. Accepts both shapes Jira returns - the issue field
 * (`{ id, name, _links, completedCycles, ongoingCycle }`) and one entry of
 * `/rest/servicedeskapi/request/{key}/sla` `values[]` - since they share the
 * cycle layout and differ only in envelope fields we never read.
 *
 * Deliberately never read:
 * - `breachTime`: on a paused cycle JSM recomputes it on every read, so it
 *   drifts forward and is not a deadline. The pilot runs its own WfP timer.
 * - `friendly`: localized display text ("-2h 30m"); only `millis` is data.
 *
 * Never throws: anything unexpected degrades to null fields or state "none"
 * so one odd ticket cannot abort a whole classification run.
 */

type JsonObject = Record<string, unknown>;

/* A fresh object per call: callers own their ParsedSla and may mutate it. */
function noSla(): ParsedSla {
  return { breached: false, goalMs: null, remainingMs: null, state: "none", withinCalendarHours: null };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

/* `{ millis: number }` -> number. No string coercion: a "3600000" here means
   the payload is not what we think it is, and guessing is worse than null. */
function durationMs(value: unknown): number | null {
  const millis = asObject(value)?.millis;
  return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
}

function parseOngoing(cycle: JsonObject): ParsedSla {
  /* paused decides whether remainingMs is live or frozen; if we cannot read it
     we cannot classify the cycle at all, so report no usable cycle. */
  if (typeof cycle.paused !== "boolean") return noSla();

  return {
    breached: cycle.breached === true,
    goalMs: durationMs(cycle.goalDuration),
    /* Negative once breached - the sign is the overrun, keep it. */
    remainingMs: durationMs(cycle.remainingTime),
    state: cycle.paused ? "paused" : "running",
    withinCalendarHours: typeof cycle.withinCalendarHours === "boolean" ? cycle.withinCalendarHours : null,
  };
}

function parseLastCompleted(completedCycles: unknown): ParsedSla {
  if (!Array.isArray(completedCycles)) return noSla();

  /* Jira lists completed cycles oldest first; skip junk entries rather than
     letting one malformed element hide the real last cycle. */
  const cycles = completedCycles.map(asObject).filter((cycle): cycle is JsonObject => cycle !== null);
  const last = cycles.at(-1);
  if (!last) return noSla();

  return {
    breached: last.breached === true,
    goalMs: durationMs(last.goalDuration),
    /* A completed cycle's remaining time is history, not a live budget. */
    remainingMs: null,
    state: "completed_only",
    withinCalendarHours: null,
  };
}

export function parseJsmSla(raw: unknown): ParsedSla {
  const sla = asObject(raw);
  if (!sla) return noSla();

  /* An ongoing cycle always wins: completed cycles describe earlier WfP/reopen
     rounds. A present-but-non-object ongoingCycle is malformed, not absent -
     falling back to old completed cycles would misreport the current state. */
  const ongoing = sla.ongoingCycle;
  if (ongoing !== undefined && ongoing !== null) {
    const cycle = asObject(ongoing);
    return cycle ? parseOngoing(cycle) : noSla();
  }

  return parseLastCompleted(sla.completedCycles);
}

/**
 * Picks one metric out of a servicedeskapi `values[]` array. Id first because
 * metric names are admin-editable; exact name is the fallback for callers that
 * only know the display name. Returns undefined when nothing matches, which
 * parseJsmSla turns into state "none".
 */
export function findSla(values: unknown, metricIdOrName: { id?: string; name?: string }): unknown {
  if (!Array.isArray(values)) return undefined;

  const entries = values.map(asObject).filter((entry): entry is JsonObject => entry !== null);
  const { id, name } = metricIdOrName;

  if (id) {
    /* servicedeskapi sends ids as strings, but tolerate a numeric id. */
    const byId = entries.find(
      (entry) => (typeof entry.id === "string" || typeof entry.id === "number") && String(entry.id) === id,
    );
    if (byId) return byId;
  }

  if (name) {
    const byName = entries.find((entry) => entry.name === name);
    if (byName) return byName;
  }

  return undefined;
}
