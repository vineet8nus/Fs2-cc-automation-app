import { Badge } from "@ui5/webcomponents-react";
import { ExtensibilityLevel, RiskScoreBreakdown, WorkflowState } from "../types";

const LEVEL_SCHEME: Record<ExtensibilityLevel, number> = { A: 8, B: 1, C: 4, D: 6 };

export function LevelBadge({ level }: { level?: ExtensibilityLevel }) {
  if (!level) return <Badge colorScheme="8">n/a</Badge>;
  return <Badge colorScheme={String(LEVEL_SCHEME[level])}>Level {level}</Badge>;
}

const BAND_SCHEME: Record<RiskScoreBreakdown["band"], number> = { Critical: 6, High: 6, Medium: 4, Low: 8 };

export function RiskBadge({ riskScore }: { riskScore?: RiskScoreBreakdown }) {
  if (!riskScore) return <Badge colorScheme="8">n/a</Badge>;
  return (
    <Badge colorScheme={String(BAND_SCHEME[riskScore.band])}>
      {riskScore.total} · {riskScore.band}
    </Badge>
  );
}

const STATE_LABEL: Record<WorkflowState, string> = {
  UPLOADED: "Uploaded",
  GIT_BASELINED: "Git baselined",
  DISCOVERED: "Discovered",
  ANALYZED: "Analyzed",
  BASELINING_TESTS: "Baselining tests",
  AWAITING_HUMAN_REVIEW_1: "Awaiting review (Gate 1)",
  PARKED: "Parked",
  REMEDIATING: "Remediating",
  AWAITING_FIX_REVIEW: "Awaiting fix review",
  VALIDATING: "Validating",
  ESCALATED: "Escalated",
  AWAITING_HUMAN_REVIEW_2: "Awaiting review (Gate 2)",
  TRANSPORT_RELEASED: "Transport released",
  DOCUMENTED: "Documented",
  DONE: "Done",
};

const STATE_SCHEME: Partial<Record<WorkflowState, number>> = {
  PARKED: 4,
  ESCALATED: 6,
  DONE: 8,
  AWAITING_HUMAN_REVIEW_1: 2,
  AWAITING_FIX_REVIEW: 2,
  AWAITING_HUMAN_REVIEW_2: 2,
};

export function StateBadge({ state }: { state: WorkflowState }) {
  return <Badge colorScheme={String(STATE_SCHEME[state] ?? 1)}>{STATE_LABEL[state]}</Badge>;
}
