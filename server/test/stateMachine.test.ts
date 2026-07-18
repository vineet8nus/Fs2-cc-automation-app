import { describe, expect, it } from "vitest";
import { assertTransitionAllowed } from "../src/orchestrator/stateMachine";

describe("state machine", () => {
  it("allows the documented happy-path sequence", () => {
    const path: Array<[string, string]> = [
      ["UPLOADED", "GIT_BASELINED"],
      ["GIT_BASELINED", "DISCOVERED"],
      ["DISCOVERED", "ANALYZED"],
      ["ANALYZED", "BASELINING_TESTS"],
      ["BASELINING_TESTS", "AWAITING_HUMAN_REVIEW_1"],
      ["AWAITING_HUMAN_REVIEW_1", "REMEDIATING"],
      ["REMEDIATING", "VALIDATING"],
      ["VALIDATING", "AWAITING_HUMAN_REVIEW_2"],
      ["AWAITING_HUMAN_REVIEW_2", "TRANSPORT_RELEASED"],
      ["TRANSPORT_RELEASED", "DOCUMENTED"],
      ["DOCUMENTED", "DONE"],
    ];
    for (const [from, to] of path) {
      expect(() => assertTransitionAllowed(from as never, to as never)).not.toThrow();
    }
  });

  it("rejects skipping a phase", () => {
    expect(() => assertTransitionAllowed("UPLOADED" as never, "ANALYZED" as never)).toThrow();
  });

  it("rejects transitions out of the terminal DONE state", () => {
    expect(() => assertTransitionAllowed("DONE" as never, "REMEDIATING" as never)).toThrow();
  });

  it("allows validation failure retry loop and escalation", () => {
    expect(() => assertTransitionAllowed("VALIDATING" as never, "REMEDIATING" as never)).not.toThrow();
    expect(() => assertTransitionAllowed("VALIDATING" as never, "ESCALATED" as never)).not.toThrow();
  });
});
