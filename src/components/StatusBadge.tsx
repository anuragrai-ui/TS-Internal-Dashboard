interface StatusBadgeProps {
  status?: string;
}

function toneForStatus(status: string): string {
  const value = status.toLowerCase();

  if (value.includes("done") || value.includes("resolved") || value.includes("closed") || value.includes("released")) {
    return "tone-success";
  }

  if (value.includes("waiting") || value.includes("blocked") || value.includes("pending") || value.includes("backlog")) {
    return "tone-warning";
  }

  if (value.includes("progress") || value.includes("review") || value.includes("selected")) {
    return "tone-accent";
  }

  return "";
}

export function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  if (!status) {
    return <span className="status-badge">Unknown</span>;
  }

  const tone = toneForStatus(status);

  return <span className={tone ? `status-badge ${tone}` : "status-badge"}>{status}</span>;
}
