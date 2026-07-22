import { describe, expect, it } from "vitest";
import { runRemediation } from "../src/agents/remediationAgent";
import { Finding } from "../src/domain/types";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    atcCheckId: "STATIC_USAGE_API_SELECT_STAR",
    checkName: "Usage of APIs (direct table read)",
    message: "Usage of APIs (direct table read): vbrk",
    objectName: "vbrk",
    priority: 2,
    extensibilityLevel: "C",
    suggestedFix: { origin: "native_quick_fix", description: "Replace direct SELECT on vbrk with released CDS view I_BillingDocument.", replacementObject: "I_BillingDocument", confidence: "high" },
    status: "approved",
    ...overrides,
  };
}

describe("runRemediation — generic real-mode fallback", () => {
  it("swaps a real FROM <table> reference for the finding's replacementObject, preserving keyword casing", () => {
    const source = "SELECT * from vbrk INTO TABLE @DATA(lt_vbrk).";
    const result = runRemediation(source, [finding({})]);
    expect(result.appliedFindingIds).toContain("f1");
    expect(result.newSource).toContain("from I_BillingDocument");
    expect(result.newSource.toLowerCase()).not.toContain("from vbrk");
  });

  it("swaps a real JOIN <table> reference too", () => {
    const source = "SELECT a~foo FROM zheader AS a JOIN bseg AS b ON a~id = b~id.";
    const bsegFinding = finding({
      id: "f2",
      objectName: "bseg",
      message: "JOIN on obsolete cluster table (BSEG): BSEG",
      suggestedFix: { origin: "native_quick_fix", description: "Replace BSEG access with I_OperationalAcctgDocItem.", replacementObject: "I_OperationalAcctgDocItem", confidence: "high" },
    });
    const result = runRemediation(source, [bsegFinding]);
    expect(result.appliedFindingIds).toContain("f2");
    expect(result.newSource).toContain("JOIN I_OperationalAcctgDocItem");
  });

  it("does not touch unrelated table names that share a substring", () => {
    const source = "SELECT * FROM vbrk_extended INTO TABLE @DATA(lt).";
    const result = runRemediation(source, [finding({})]);
    expect(result.skippedFindingIds).toContain("f1");
    expect(result.newSource).toContain("FROM vbrk_extended");
  });

  it("skips findings with no replacement object and no hardcoded mock pattern match", () => {
    const source = "UPDATE ztable SET flag = 'X'.";
    const noFixFinding = finding({
      suggestedFix: { origin: "ai_generated", description: "Replace the direct write with a released BAPI.", confidence: "medium" },
    });
    const result = runRemediation(source, [noFixFinding]);
    expect(result.skippedFindingIds).toContain("f1");
    expect(result.newSource).toBe(source);
  });
});
