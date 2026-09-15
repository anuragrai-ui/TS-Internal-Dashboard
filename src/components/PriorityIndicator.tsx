interface PriorityIndicatorProps {
  priority?: string;
}

function dotClassForPriority(priority: string): string {
  const value = priority.toLowerCase();

  if (value.includes("highest") || value.includes("critical") || value.includes("urgent")) {
    return "p-highest";
  }
  if (value.includes("high")) {
    return "p-high";
  }
  if (value.includes("medium")) {
    return "p-medium";
  }
  if (value.includes("lowest")) {
    return "p-lowest";
  }
  if (value.includes("low")) {
    return "p-low";
  }

  return "p-medium";
}

export function PriorityIndicator({ priority }: PriorityIndicatorProps): React.ReactElement {
  if (!priority || priority === "None") {
    return <span className="priority-chip cell-muted">—</span>;
  }

  return (
    <span className="priority-chip">
      <span aria-hidden="true" className={`priority-dot ${dotClassForPriority(priority)}`} />
      {priority}
    </span>
  );
}
