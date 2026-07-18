import { describe, expect, it } from "vitest";
import { computeRiskScore, worstExtensibilityLevel } from "../src/risk/riskScore";
import { Finding } from "../src/domain/types";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    atcCheckId: "CHK",
    checkName: "Check",
    message: "msg",
    objectName: "ZPROG",
    priority: 3,
    extensibilityLevel: "B",
    suggestedFix: { origin: "native_quick_fix", description: "fix", confidence: "high" },
    status: "open",
    ...overrides,
  };
}

describe("riskScore", () => {
  it("returns a zero/Low score when there are no findings", () => {
    const score = computeRiskScore([], "L", 0);
    expect(score.total).toBe(0);
    expect(score.band).toBe("Low");
  });

  it("worstExtensibilityLevel picks the most severe level (D beats B)", () => {
    const findings = [finding({ extensibilityLevel: "B" }), finding({ extensibilityLevel: "D", id: "f2" })];
    expect(worstExtensibilityLevel(findings)).toBe("D");
  });

  it("increases with worse ATC priority, extensibility level, and criticality", () => {
    const low = computeRiskScore([finding({ priority: 4, extensibilityLevel: "B" })], "L", 1);
    const high = computeRiskScore([finding({ priority: 1, extensibilityLevel: "D" })], "H", 1);
    expect(high.total).toBeGreaterThan(low.total);
  });

  it("applies a higher fix-confidence penalty for AI-generated fixes than native quick fixes", () => {
    const native = computeRiskScore([finding({ suggestedFix: { origin: "native_quick_fix", description: "", confidence: "high" } })], "M", 1);
    const ai = computeRiskScore([finding({ suggestedFix: { origin: "ai_generated", description: "", confidence: "medium" } })], "M", 1);
    expect(ai.fixConfidencePenalty).toBeGreaterThan(native.fixConfidencePenalty);
  });

  it("bands correctly at boundaries", () => {
    const critical = computeRiskScore(
      [finding({ priority: 1, extensibilityLevel: "D", suggestedFix: { origin: "ai_generated", description: "", confidence: "low" } })],
      "H",
      10
    );
    expect(["Critical", "High"]).toContain(critical.band);
  });
});
