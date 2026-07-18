import { WorkflowState } from "../domain/types";

// Allowed transitions per docs/design/clean-core-migration-design.md §5.
export const ALLOWED_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  UPLOADED: ["GIT_BASELINED"],
  GIT_BASELINED: ["DISCOVERED"],
  DISCOVERED: ["ANALYZED"],
  ANALYZED: ["BASELINING_TESTS"],
  BASELINING_TESTS: ["AWAITING_HUMAN_REVIEW_1"],
  AWAITING_HUMAN_REVIEW_1: ["PARKED", "REMEDIATING"],
  PARKED: ["REMEDIATING"], // a parked program can be revisited later
  REMEDIATING: ["VALIDATING"],
  VALIDATING: ["REMEDIATING", "ESCALATED", "AWAITING_HUMAN_REVIEW_2"],
  ESCALATED: ["REMEDIATING", "PARKED"],
  AWAITING_HUMAN_REVIEW_2: ["REMEDIATING", "PARKED", "TRANSPORT_RELEASED"],
  TRANSPORT_RELEASED: ["DOCUMENTED"],
  DOCUMENTED: ["DONE"],
  DONE: [],
};

export function assertTransitionAllowed(from: WorkflowState, to: WorkflowState) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
  }
}
