export interface KpiItem {
  label: string;
  sub?: string;
  tone?: "danger" | "success" | "warning";
  value: number | string;
}

interface KpiStripProps {
  items: KpiItem[];
}

export function KpiStrip({ items }: KpiStripProps): React.ReactElement {
  return (
    <section aria-label="Key metrics" className="kpi-strip">
      {items.map((item) => (
        <div className="kpi-item" key={item.label}>
          <span className="kpi-label">{item.label}</span>
          <span className="kpi-value">{item.value}</span>
          {item.sub ? (
            <span className={item.tone ? `kpi-sub tone-${item.tone}` : "kpi-sub"}>{item.sub}</span>
          ) : null}
        </div>
      ))}
    </section>
  );
}
