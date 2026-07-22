import { ObjectStatus, ValueState } from "@ui5/webcomponents-react";
import { ExtensibilityLevel, RiskScoreBreakdown, WorkflowState } from "../types";

const LEVEL_STATE: Record<ExtensibilityLevel, ValueState> = {
  A: ValueState.Success,
  B: ValueState.Information,
  C: ValueState.Warning,
  D: ValueState.Error,
};

export function LevelBadge({ level }: { level?: ExtensibilityLevel }) {
  if (!level) return <ObjectStatus state={ValueState.None}>n/a</ObjectStatus>;
  return (
    <ObjectStatus state={LEVEL_STATE[level]} showDefaultIcon>
      Level {level}
    </ObjectStatus>
  );
}

const BAND_STATE: Record<RiskScoreBreakdown["band"], ValueState> = {
  Critical: ValueState.Error,
  High: ValueState.Error,
  Medium: ValueState.Warning,
  Low: ValueState.Success,
};

export function RiskBadge({ riskScore }: { riskScore?: RiskScoreBreakdown }) {
  if (!riskScore) return <ObjectStatus state={ValueState.None}>n/a</ObjectStatus>;
  return (
    <ObjectStatus state={BAND_STATE[riskScore.band]} showDefaultIcon>
      {riskScore.total} · {riskScore.band}
    </ObjectStatus>
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

const STATE_VALUE: Partial<Record<WorkflowState, ValueState>> = {
  PARKED: ValueState.Warning,
  ESCALATED: ValueState.Error,
  DONE: ValueState.Success,
  TRANSPORT_RELEASED: ValueState.Success,
  DOCUMENTED: ValueState.Success,
  AWAITING_HUMAN_REVIEW_1: ValueState.Information,
  AWAITING_FIX_REVIEW: ValueState.Information,
  AWAITING_HUMAN_REVIEW_2: ValueState.Information,
};

export function StateBadge({ state }: { state: WorkflowState }) {
  return (
    <ObjectStatus state={STATE_VALUE[state] ?? ValueState.None} showDefaultIcon>
      {STATE_LABEL[state]}
    </ObjectStatus>
  );
}
