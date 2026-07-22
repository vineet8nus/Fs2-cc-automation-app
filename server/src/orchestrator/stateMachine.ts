import { WorkflowState } from "../domain/types";

// Allowed transitions per docs/design/clean-core-migration-design.md §5.
export const ALLOWED_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  // PARKED here covers an object type the live system can't process yet
  // (see Orchestrator.ingest) — parked before any Git/ADT call is made.
  UPLOADED: ["GIT_BASELINED", "PARKED"],
  GIT_BASELINED: ["DISCOVERED"],
  DISCOVERED: ["ANALYZED"],
  ANALYZED: ["BASELINING_TESTS"],
  BASELINING_TESTS: ["AWAITING_HUMAN_REVIEW_1"],
  AWAITING_HUMAN_REVIEW_1: ["PARKED", "REMEDIATING"],
  PARKED: ["REMEDIATING"], // a parked program can be revisited later
  // REMEDIATING always produces a proposal for human review before any
  // write happens — it never goes straight to VALIDATING.
  REMEDIATING: ["AWAITING_FIX_REVIEW"],
  AWAITING_FIX_REVIEW: ["VALIDATING", "REMEDIATING", "PARKED"],
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
