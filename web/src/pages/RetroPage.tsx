import { FlexBox, MessageStrip, Panel, Text, Title } from "@ui5/webcomponents-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { RetroMetrics } from "../types";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 180, padding: "0.75rem 1rem", border: "1px solid var(--sapList_BorderColor)", borderRadius: 6 }}>
      <Text style={{ display: "block", opacity: 0.7 }}>{label}</Text>
      <Title level="H3">{value}</Title>
    </div>
  );
}

export function RetroPage() {
  const [metrics, setMetrics] = useState<RetroMetrics | null>(null);

  useEffect(() => {
    api.retro().then(setMetrics);
  }, []);

  if (!metrics) return <div style={{ padding: "2rem" }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 1000, margin: "2rem auto", padding: "0 1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Title level="H2">Process retro — continuous improvement</Title>
      <Text>
        Standing metrics across every program run, per docs/design/clean-core-migration-design.md's Process Retro
        Agent — this is the ongoing answer to "validate the process and advise on improvements," not a one-off
        exercise.
      </Text>
      <FlexBox style={{ gap: "1rem", flexWrap: "wrap" }}>
        <Metric label="Total programs" value={String(metrics.totalPrograms)} />
        <Metric label="Parked rate" value={`${Math.round(metrics.parkedRate * 100)}%`} />
        <Metric label="Gate 1 rejection rate" value={`${Math.round(metrics.gate1RejectionRate * 100)}%`} />
        <Metric label="Native quick-fix ratio" value={`${Math.round(metrics.nativeQuickFixRatio * 100)}%`} />
        <Metric label="AI-fix ratio" value={`${Math.round(metrics.aiFixRatio * 100)}%`} />
        <Metric label="Validation fail rate" value={`${Math.round(metrics.validationFailRate * 100)}%`} />
        <Metric label="Avg findings / program" value={metrics.avgFindingsPerProgram.toFixed(1)} />
      </FlexBox>

      <Panel headerText="By state">
        <div style={{ padding: "1rem" }}>
          {Object.entries(metrics.byState).map(([state, count]) => (
            <Text key={state} style={{ display: "block" }}>
              {state}: {count}
            </Text>
          ))}
        </div>
      </Panel>

      <Panel headerText="Recommendations">
        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {metrics.recommendations.map((r, i) => (
            <MessageStrip key={i} design="Information">
              {r}
            </MessageStrip>
          ))}
        </div>
      </Panel>
    </div>
  );
}
