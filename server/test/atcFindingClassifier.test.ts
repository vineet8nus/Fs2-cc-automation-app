import { describe, expect, it } from "vitest";
import { classifyAtcFinding, parseAtcWorklistFindings } from "../src/sap/atcFindingClassifier";

// Captured live from a real ATC run (ZNUS_SCI_DEF_CENTRAL) against
// ZIF_ZCC_LOG on SHD200SYSTEM — used as a fixture so the parser is tested
// against the exact XML shape ADT actually returns, not a synthetic guess.
const REAL_WORKLIST_XML = `<?xml version="1.0" encoding="utf-8"?><atcworklist:worklist atcworklist:id="0D2C316FC3F81FE1A1CF939098A926BF" atcworklist:timestamp="2026-07-23T09:55:26Z" xmlns:atcworklist="http://www.sap.com/adt/atc/worklist"><atcworklist:objects><atcobject:object adtcore:uri="/sap/bc/adt/atc/objects/R3TR/INTF/ZIF_ZCC_LOG" adtcore:type="INTF" adtcore:name="ZIF_ZCC_LOG" adtcore:packageName="ZTEST_VK" atcobject:author="VINEET" xmlns:atcobject="http://www.sap.com/adt/atc/object" xmlns:adtcore="http://www.sap.com/adt/core"><atcobject:findings><atcfinding:finding adtcore:uri="/sap/bc/adt/atc/findings/itemid/A/index/1" atcfinding:location="/sap/bc/adt/oo/interfaces/zif_zcc_log/source/main#start=3,0" atcfinding:processor="VINEET" atcfinding:priority="2" atcfinding:checkId="607C8DA83153D361AEA481F8B1C02D86" atcfinding:checkTitle="Extended Naming Conventions for Programs" atcfinding:messageId="METH_IMP" atcfinding:messageTitle="Invalid name I_MESSAGE for IMPORTING parameter (METHODS)" atcfinding:exemptionApproval="" atcfinding:exemptionKind="" atcfinding:checksum="-932106392" xmlns:atcfinding="http://www.sap.com/adt/atc/finding"><atom:link href="x" rel="http://www.sap.com/adt/relations/documentation" xmlns:atom="http://www.w3.org/2005/Atom"/></atcfinding:finding></atcobject:findings></atcobject:object></atcworklist:objects></atcworklist:worklist>`;

describe("parseAtcWorklistFindings", () => {
  it("extracts findings with the real object name, not the queried one", () => {
    const findings = parseAtcWorklistFindings(REAL_WORKLIST_XML);
    expect(findings).toHaveLength(1);
    expect(findings[0].objectName).toBe("ZIF_ZCC_LOG");
    expect(findings[0].atcCheckId).toBe("607C8DA83153D361AEA481F8B1C02D86");
    expect(findings[0].checkName).toBe("Extended Naming Conventions for Programs");
    expect(findings[0].message).toBe("Invalid name I_MESSAGE for IMPORTING parameter (METHODS)");
    expect(findings[0].priority).toBe(2);
  });

  it("returns nothing for a worklist with no objects", () => {
    expect(parseAtcWorklistFindings(`<atcworklist:worklist xmlns:atcworklist="x"><atcworklist:objects/></atcworklist:worklist>`)).toEqual([]);
  });
});

describe("classifyAtcFinding", () => {
  it("gives a high-confidence native quick fix for a known standard table", () => {
    const result = classifyAtcFinding("Usage of APIs", "Direct SELECT on table MARA is not released.", 2);
    expect(result.fixOrigin).toBe("native_quick_fix");
    expect(result.replacementObject).toBe("I_Product");
    expect(result.fixConfidence).toBe("high");
  });

  it("classifies naming-convention findings as a low-confidence AI fix", () => {
    const result = classifyAtcFinding("Extended Naming Conventions for Programs", "Invalid name I_MESSAGE for IMPORTING parameter", 2);
    expect(result.extensibilityLevel).toBe("B");
    expect(result.fixOrigin).toBe("ai_generated");
  });

  it("falls back to priority-derived extensibility with no fabricated fix for an unrecognized check", () => {
    const result = classifyAtcFinding("Some Unknown Check", "Something ATC found that we've never seen before", 1);
    expect(result.extensibilityLevel).toBe("D");
    expect(result.fixOrigin).toBe("none");
  });
});
