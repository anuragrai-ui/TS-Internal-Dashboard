"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ErrorNotice, ExecutionNotice } from "@/components/actions/ExecutionNotice";
import { fetchJiraOptions, mightHaveArrived, postAction, useAttemptKey } from "@/components/actions/actionsApi";
import { Icon } from "@/components/Icon";
import { PriorityText } from "@/components/tracker/TrackerBits";
import { ACTION_PRIORITIES, CP_KEY_PATTERN } from "@/lib/actions/validate";

import type { IconName } from "@/components/Icon";
import type { TrackerPriority, TrackerTicket } from "@/lib/tracker/types";
import type { ActionArgs, ActionExecution, JiraOptionsResponse } from "@/lib/workspace/types";

type Editor = "assignee" | "cp" | "priority" | "status";

type OptionsState = { error: string; status: "error" } | { options: JiraOptionsResponse; status: "ready" } | { status: "idle" | "loading" };

type Outcome = { args: ActionArgs; execution: ActionExecution } | { error: string } | null;

/* What the bar shows right after a change, before the tracker's own copy of the ticket catches up (its snapshot is rebuilt every few minutes). */
interface Overrides {
  assignee?: string | null;
  priority?: TrackerPriority;
  status?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

interface TicketActionsBarProps {
  /* Opens the composer on its #firefighters tab. */
  onEscalate: () => void;
  /* After a change went through: reload the detail panel. */
  onChanged: () => void;
  ticket: TrackerTicket;
}

/** Status, assignee, priority, "link a CP" and "escalate" for one ticket - each a direct write with the person's own Jira token. */
export function TicketActionsBar({ onChanged, onEscalate, ticket }: TicketActionsBarProps): React.ReactElement {
  const ticketKey = ticket.key;
  const baseId = useId();
  const [open, setOpen] = useState<Editor | null>(null);
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const attempt = useAttemptKey();
  const optionsRequest = useRef<Promise<JiraOptionsResponse | null> | null>(null);

  /* A different ticket starts clean; so does a fresh copy of this one (the overrides have caught up or been superseded). */
  useEffect(() => {
    setOpen(null);
    setOutcome(null);
    setOptionsState({ status: "idle" });
    optionsRequest.current = null;
  }, [ticketKey]);
  useEffect(() => {
    setOverrides({});
  }, [ticketKey, ticket.updated]);

  const loadOptions = useCallback(
    (force = false): Promise<JiraOptionsResponse | null> => {
      if (optionsRequest.current && !force) {
        return optionsRequest.current;
      }
      setOptionsState({ status: "loading" });
      const request = fetchJiraOptions(ticketKey).then((result) => {
        if (!result.ok) {
          setOptionsState({ error: result.error, status: "error" });
          optionsRequest.current = null;
          return null;
        }
        setOptionsState({ options: result.data, status: "ready" });
        return result.data;
      });
      optionsRequest.current = request;
      return request;
    },
    [ticketKey],
  );

  const toggle = (editor: Editor): void => {
    setOpen((current) => (current === editor ? null : editor));
    void loadOptions();
  };

  const send = async (args: ActionArgs, force = false): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    const options = await loadOptions();
    const result = await postAction({
      args,
      expectedVersion: options?.version ?? null,
      force,
      idempotencyKey: attempt.keyFor(JSON.stringify({ args, force, ticketKey })),
      ticketKey,
    });
    setBusy(false);

    if (!result.ok) {
      if (!mightHaveArrived(result)) {
        attempt.settle();
      }
      setOutcome({ error: result.error });
      return;
    }
    attempt.settle();
    const { execution } = result.data;
    setOutcome({ args, execution });
    if (execution.status === "succeeded" || execution.status === "duplicate") {
      setOverrides((current) => ({ ...current, ...overrideFor(args, optionsState) }));
      setOpen(null);
      onChanged();
      /* The ticket's `updated` just moved - the next change must compare against the new one. */
      void loadOptions(true);
    }
  };

  const reload = (): void => {
    setOutcome(null);
    void loadOptions(true);
    onChanged();
  };

  const statusName = overrides.status ?? ticket.statusName;
  const assigneeName = overrides.assignee !== undefined ? overrides.assignee : (ticket.assignee?.name ?? null);
  const priority = overrides.priority ?? ticket.priority;

  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      /* Handled here, so the workspace's Escape (close the panel) doesn't fire too. */
      event.preventDefault();
      event.stopPropagation();
      const editor = open;
      setOpen(null);
      if (editor) {
        document.getElementById(`${baseId}-${editor}-btn`)?.focus();
      }
    }
  };

  const control = (editor: Editor, icon: IconName, label: string, value: React.ReactNode): React.ReactElement => (
    <button
      aria-controls={`${baseId}-editor`}
      aria-expanded={open === editor}
      className="act-control"
      data-open={open === editor}
      id={`${baseId}-${editor}-btn`}
      onClick={() => toggle(editor)}
      type="button"
    >
      <Icon name={icon} size={13} />
      <span className="act-control-label">{label}</span>
      <span className="act-control-value">{value}</span>
      <Icon name="chevron-down" size={11} />
    </button>
  );

  return (
    <div className="act-bar">
      <div aria-label={`Change ${ticketKey}`} className="act-bar-row" role="group">
        {control("status", "layers", "Status", statusName)}
        {control("assignee", "user", "Assignee", assigneeName ?? "Unassigned")}
        {control("priority", "sort", "Priority", <PriorityText priority={priority} />)}
        {control("cp", "link", "Link CP", null)}
        <button className="act-control" data-tone="danger" onClick={onEscalate} type="button">
          <Icon name="zap" size={13} />
          <span className="act-control-value">Escalate to #firefighters</span>
        </button>
      </div>

      {open ? (
        <div aria-labelledby={`${baseId}-${open}-btn`} className="act-editor" id={`${baseId}-editor`} onKeyDown={onEditorKeyDown} role="group">
          {optionsState.status === "error" ? (
            <ErrorNotice message={optionsState.error} />
          ) : open === "status" ? (
            <StatusEditor busy={busy} current={statusName} onPick={(args) => void send(args)} options={optionsState} />
          ) : open === "assignee" ? (
            <AssigneeEditor busy={busy} currentName={assigneeName} onPick={(args) => void send(args)} ticketKey={ticketKey} />
          ) : open === "priority" ? (
            <PriorityEditor busy={busy} current={priority} onPick={(args) => void send(args)} />
          ) : (
            <LinkCpEditor busy={busy} linked={ticket.cps.map((cp) => cp.key)} onLink={(args) => void send(args)} />
          )}
        </div>
      ) : null}

      {outcome ? (
        "error" in outcome ? (
          <ErrorNotice message={outcome.error} />
        ) : (
          <ExecutionNotice execution={outcome.execution} onForce={() => void send(outcome.args, true)} onReload={reload} />
        )
      ) : null}
    </div>
  );
}

function overrideFor(args: ActionArgs, optionsState: OptionsState): Overrides {
  switch (args.operation) {
    case "jira_transition": {
      const transition = optionsState.status === "ready" ? optionsState.options.transitions.find((option) => option.id === args.transitionId) : undefined;
      return transition ? { status: transition.toStatus } : {};
    }
    case "jira_assign":
      return { assignee: args.accountId === null ? null : (args.displayName ?? null) };
    case "jira_priority":
      return { priority: args.priority };
    default:
      return {};
  }
}

/* ------------------------------------------------------------- editors */

function StatusEditor({
  busy,
  current,
  onPick,
  options,
}: {
  busy: boolean;
  current: string;
  onPick: (args: ActionArgs) => void;
  options: OptionsState;
}): React.ReactElement {
  if (options.status !== "ready") {
    return (
      <p aria-busy="true" className="trk-muted-note" role="status">
        Loading what you can move it to…
      </p>
    );
  }
  const transitions = options.options.transitions;
  if (transitions.length === 0) {
    return <p className="trk-muted-note">Jira offers you no status changes from {current}.</p>;
  }
  return (
    <ul aria-label="Move to" className="act-option-list">
      {transitions.map((transition) => (
        <li key={transition.id}>
          <button
            className="act-option"
            disabled={busy}
            onClick={() => onPick({ operation: "jira_transition", transitionId: transition.id, transitionName: transition.name })}
            type="button"
          >
            <span>{transition.name}</span>
            {transition.toStatus !== transition.name ? <span className="act-option-hint">→ {transition.toStatus}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function AssigneeEditor({
  busy,
  currentName,
  onPick,
  ticketKey,
}: {
  busy: boolean;
  currentName: string | null;
  onPick: (args: ActionArgs) => void;
  ticketKey: string;
}): React.ReactElement {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ error?: string; people: Array<{ accountId: string; displayName: string }>; status: "idle" | "loading" | "ready" }>({
    people: [],
    status: "idle",
  });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setResults((previous) => ({ ...previous, status: "loading" }));
      void fetchJiraOptions(ticketKey, query).then((result) => {
        if (!cancelled) {
          setResults(result.ok ? { people: result.data.assignees, status: "ready" } : { error: result.error, people: [], status: "ready" });
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, ticketKey]);

  return (
    <div className="act-assignee">
      <label className="act-field-label" htmlFor={inputId}>
        Assign to
      </label>
      <input
        autoComplete="off"
        autoFocus
        className="trk-input"
        id={inputId}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people"
        type="search"
        value={query}
      />
      {results.error ? <p className="trk-muted-note" data-tone="danger">{results.error}</p> : null}
      <ul aria-busy={results.status === "loading"} aria-label="People" className="act-option-list">
        {currentName !== null ? (
          <li>
            <button className="act-option" disabled={busy} onClick={() => onPick({ accountId: null, operation: "jira_assign" })} type="button">
              <span>Unassign</span>
              <span className="act-option-hint">now {currentName}</span>
            </button>
          </li>
        ) : null}
        {results.people.map((person) => (
          <li key={person.accountId}>
            <button
              className="act-option"
              disabled={busy || person.displayName === currentName}
              onClick={() => onPick({ accountId: person.accountId, displayName: person.displayName, operation: "jira_assign" })}
              type="button"
            >
              <span>{person.displayName}</span>
              {person.displayName === currentName ? <span className="act-option-hint">current</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {results.status === "ready" && results.people.length === 0 && !results.error ? <p className="trk-muted-note">Nobody assignable matches “{query}”.</p> : null}
    </div>
  );
}

function PriorityEditor({ busy, current, onPick }: { busy: boolean; current: TrackerPriority; onPick: (args: ActionArgs) => void }): React.ReactElement {
  return (
    <div aria-label="Priority" className="act-chip-row" role="group">
      {ACTION_PRIORITIES.map((priority) => (
        <button
          aria-pressed={priority === current}
          className="act-chip"
          disabled={busy || priority === current}
          key={priority}
          onClick={() => onPick({ operation: "jira_priority", priority })}
          type="button"
        >
          <PriorityText priority={priority} />
        </button>
      ))}
    </div>
  );
}

function LinkCpEditor({ busy, linked, onLink }: { busy: boolean; linked: string[]; onLink: (args: ActionArgs) => void }): React.ReactElement {
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  const cpKey = value.trim().toUpperCase();
  const valid = CP_KEY_PATTERN.test(cpKey);
  const already = linked.includes(cpKey);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (valid && !already) {
      onLink({ cpKey, operation: "jira_link_cp" });
    }
  };

  return (
    <form className="act-inline-form" onSubmit={submit}>
      <label className="act-field-label" htmlFor={inputId}>
        CP to link
      </label>
      <div className="act-inline-row">
        <input
          aria-describedby={hintId}
          aria-invalid={value.trim() !== "" && !valid}
          autoComplete="off"
          autoFocus
          className="trk-input"
          id={inputId}
          onChange={(event) => setValue(event.target.value)}
          placeholder="CP-1234"
          value={value}
        />
        <button className="trk-btn" disabled={busy || !valid || already} type="submit">
          {busy ? "Linking…" : "Link"}
        </button>
      </div>
      <p className="trk-muted-note" id={hintId}>
        {already ? `${cpKey} is already linked.` : "Adds a “relates to” link in Jira."}
      </p>
    </form>
  );
}
