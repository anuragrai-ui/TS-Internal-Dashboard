import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

interface RiskBadgeProps {
  analysis?: TicketEscalationAnalysis;
}

function getRiskLabel(analysis?: TicketEscalationAnalysis): string {
  if (!analysis) {
    return "Not assessed";
  }

  if (analysis.risk_level === "immediate") {
    return "Immediate";
  }

  if (analysis.risk_level === "watch") {
    return "Watch";
  }

  if (analysis.risk_level === "normal") {
    return "Normal";
  }

  return "Unknown";
}

export function RiskBadge({ analysis }: RiskBadgeProps): React.ReactElement {
  const riskLevel = analysis?.risk_level ?? "unknown";
  const label = getRiskLabel(analysis);

  return (
    <span className={`risk-chip risk-${riskLevel}`}>
      {label}
      {analysis ? ` · ${analysis.risk_score}` : ""}
    </span>
  );
}
