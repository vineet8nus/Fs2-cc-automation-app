import { describe, expect, it } from "vitest";
import { runCleanCoreAnalysis } from "../src/agents/cleanCoreAnalysisAgent";
import { AtcRawFinding, ObjectSource, SapClient, SYSTEM_ATC_FALLBACK_CHECK_ID } from "../src/sap/SapClient";
import { DependencyObject } from "../src/domain/types";

function finding(overrides: Partial<AtcRawFinding> & Pick<AtcRawFinding, "atcCheckId" | "objectName">): AtcRawFinding {
  return {
    checkName: "Test check",
    message: "Test message",
    priority: 3,
    extensibilityLevel: "B",
    fixOrigin: "none",
    fixDescription: "n/a",
    fixConfidence: "low",
    ...overrides,
  };
}

/**
 * Records every runAtcCheck call by the primary object name it was scoped
 * to, so tests can assert exactly which closure members get their own real
 * ATC query — the crux of the duplication bug this suite guards against.
 */
class RecordingSapClient implements SapClient {
  calls: string[] = [];
  constructor(
    private readonly primaryFindings: AtcRawFinding[],
    private readonly perObjectFindings: Record<string, AtcRawFinding[]> = {}
  ) {}

  async readObjectSource(name: string): Promise<ObjectSource> {
    return { name, type: "PROG", source: "" };
  }
  async getDependencies(): Promise<DependencyObject[]> {
    return [];
  }
  async runAtcCheck(objectNames: string[]): Promise<AtcRawFinding[]> {
    const name = objectNames[0];
    this.calls.push(name);
    if (name in this.perObjectFindings) return this.perObjectFindings[name];
    return this.primaryFindings;
  }
  async runAbapUnit(): Promise<never[]> {
    return [];
  }
  async syntaxCheckAndActivate() {
    return { syntaxOk: true, activated: true, messages: [] };
  }
  async objectExists(): Promise<boolean> {
    return true;
  }
}

describe("runCleanCoreAnalysis closure-object attribution (multi-object dedup fix)", () => {
  it("does not re-query real ATC for an INCLUDE closure member once the primary run already used real ATC, but does re-query a CLASS member", async () => {
    const includeFindingViaPrimary = finding({
      atcCheckId: "REAL_FINDING_IN_INCLUDE",
      objectName: "ZPROG1",
      foundInObject: "ZPROG1_C01",
    });
    const classOwnFinding = finding({
      atcCheckId: "REAL_FINDING_IN_CLASS",
      objectName: "ZCL_HELPER",
    });
    const sap = new RecordingSapClient([includeFindingViaPrimary], { ZCL_HELPER: [classOwnFinding] });

    const findings = await runCleanCoreAnalysis(
      ["ZPROG1"],
      "ZPROG1",
      { name: "ZPROG1", type: "PROG", source: "REPORT zprog1." },
      sap,
      [
        { name: "ZPROG1_C01", source: "* include source", type: "INCLUDE" },
        { name: "ZCL_HELPER", source: "CLASS zcl_helper.", type: "CLASS" },
      ]
    );

    // Exactly two real ATC calls: the primary, and the CLASS. The INCLUDE
    // must never be independently re-queried once the primary already
    // succeeded via real ATC — that redundant call is what previously
    // duplicated/mislabeled findings across every closure member.
    expect(sap.calls).toEqual(["ZPROG1", "ZCL_HELPER"]);

    const includeFinding = findings.find((f) => f.atcCheckId === "REAL_FINDING_IN_INCLUDE");
    expect(includeFinding?.containerObject).toBe("ZPROG1_C01");
    expect(findings.filter((f) => f.atcCheckId === "REAL_FINDING_IN_INCLUDE")).toHaveLength(1);

    const classFinding = findings.find((f) => f.atcCheckId === "REAL_FINDING_IN_CLASS");
    expect(classFinding?.containerObject).toBe("ZCL_HELPER");
  });

  it("still re-queries an INCLUDE closure member when the primary run fell back to the static engine", async () => {
    const fallbackMarker = finding({ atcCheckId: SYSTEM_ATC_FALLBACK_CHECK_ID, objectName: "ZPROG2" });
    const includeOwnFinding = finding({ atcCheckId: "STATIC_FINDING_IN_INCLUDE", objectName: "ZPROG2_C01" });
    const sap = new RecordingSapClient([fallbackMarker], { ZPROG2_C01: [includeOwnFinding] });

    const findings = await runCleanCoreAnalysis(
      ["ZPROG2"],
      "ZPROG2",
      { name: "ZPROG2", type: "PROG", source: "REPORT zprog2." },
      sap,
      [{ name: "ZPROG2_C01", source: "* include source", type: "INCLUDE" }]
    );

    expect(sap.calls).toEqual(["ZPROG2", "ZPROG2_C01"]);
    expect(findings.some((f) => f.atcCheckId === "STATIC_FINDING_IN_INCLUDE")).toBe(true);
  });
});
