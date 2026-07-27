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

  // Real ATC findings carry the containing object's name in objectName
  // (e.g. "ZTEST_VK2"), not the actual violated table — the table name
  // only ever surfaces inside the free-text message. Confirmed live on
  // ztest_vk2: this exact shape (objectName = containing program,
  // "MARA" only in the message) is what real ATC produces.
  it("recovers the real violated table name from replacementObject via the reverse CDS mapping, not the (unhelpful) objectName", () => {
    const source = "REPORT ztest_vk2.\nSELECT * from mara INTO TABLE @DATA(lt_mara).";
    const realAtcFinding = finding({
      objectName: "ZTEST_VK2",
      message: "Read access (SELECT) to database table / view MARA",
      suggestedFix: { origin: "ai_generated", description: "Identify a released CDS view for MARA.", replacementObject: "I_Product", confidence: "medium" },
    });
    const result = runRemediation(source, [realAtcFinding]);
    expect(result.appliedFindingIds).toContain("f1");
    expect(result.newSource).toContain("from I_Product");
  });
});

describe("runRemediation — mock-template branches never claim success without an actual change", () => {
  it("does not report a finding as fixed when the mock-template branch's loose gate matches but the real source doesn't match its specific pattern", () => {
    // Real source that superficially resembles the MockSapClient MARA
    // template (mentions "SELECT * FROM mara" and the finding's message
    // mentions "MARA") but isn't the exact fixed template text the mock
    // branch's specific replace regex requires (no "UP TO 100 ROWS."
    // suffix) — and critically, has no replacementObject either, so the
    // generic fallback can't do anything for it. This must end up
    // genuinely skipped, not falsely "fixed".
    const source = "SELECT * from mara INTO TABLE @DATA(lt_mara) WHERE matnr = 'X'.";
    const noReplacementFinding = finding({
      objectName: "ZTEST_VK2",
      message: "MARA read without WHERE-driven selectivity check.",
      suggestedFix: { origin: "none", description: "Manual review required.", confidence: "low" },
    });
    const result = runRemediation(source, [noReplacementFinding]);
    expect(result.skippedFindingIds).toContain("f1");
    expect(result.newSource).toBe(source);
    expect(result.appliedFindingIds).not.toContain("f1");
  });

  it("still applies the mock template's exact fix when the source genuinely matches it", () => {
    const source = "SELECT * FROM mara INTO TABLE @DATA(lt_mara) UP TO 100 ROWS.";
    const mockFinding = finding({
      objectName: "ZUXTEST",
      message: "Direct SELECT on table MARA is not released for Clean Core; use a released successor.",
      suggestedFix: { origin: "native_quick_fix", description: "Replace direct SELECT on MARA with released CDS view I_Product.", replacementObject: "I_Product", confidence: "high" },
    });
    const result = runRemediation(source, [mockFinding]);
    expect(result.appliedFindingIds).toContain("f1");
    expect(result.newSource).toContain("SELECT * FROM I_Product INTO TABLE @DATA(lt_mara) UP TO 100 ROWS.");
  });
});
