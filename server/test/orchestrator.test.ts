import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { InMemoryProgramStore } from "../src/store/store";
import { DependencyObject } from "../src/domain/types";
import { MockSapClient } from "../src/sap/MockSapClient";
import { AtcRawFinding, ObjectSource, SapClient } from "../src/sap/SapClient";

// A SapClient that behaves like MockSapClient for everything up through
// Gate 1, but fails validation the way RealAdtClient currently does (an
// unimplemented write-path method throwing) — this is exactly the scenario
// a real-mode Gate 1 approval hits today, since syntaxCheckAndActivate
// isn't implemented yet.
class ThrowsOnActivateSapClient extends MockSapClient implements SapClient {
  async syntaxCheckAndActivate(): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }> {
    throw new Error("syntaxCheckAndActivate() is not implemented yet");
  }
}

describe("orchestrator resilience to unimplemented SapClient methods", () => {
  it("escalates cleanly instead of leaving the program stuck in VALIDATING", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new ThrowsOnActivateSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZTHROWTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(program.state).toBe("AWAITING_HUMAN_REVIEW_1");

    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");
    expect(proposed.state).toBe("AWAITING_FIX_REVIEW");

    const result = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "approve write");

    expect(result.state).toBe("ESCALATED");
    expect(result.state).not.toBe("VALIDATING");
    expect(result.auditLog.some((a) => a.action === "validation-error")).toBe(true);

    // Re-fetching from the store must show the same resolved state, not a
    // program stuck mid-transition.
    expect(store.get(program.id)?.state).toBe("ESCALATED");
  });
});

// A SapClient where every suggested replacement object fails existence
// verification — simulates a fix proposing a CDS view/API that doesn't
// actually exist in the target system.
class NoObjectsExistSapClient extends MockSapClient implements SapClient {
  async objectExists(): Promise<boolean> {
    return false;
  }
}

describe("orchestrator verifies replacement objects before proposing a fix", () => {
  it("defers findings whose replacement object can't be confirmed, instead of proposing them", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new NoObjectsExistSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZNOOBJTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const findingsWithReplacement = program.findings.filter((f) => f.suggestedFix.replacementObject);
    expect(findingsWithReplacement.length).toBeGreaterThan(0);

    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");

    expect(proposed.state).toBe("AWAITING_FIX_REVIEW");
    for (const f of findingsWithReplacement) {
      const updated = proposed.findings.find((x) => x.id === f.id);
      expect(updated?.status).toBe("deferred");
    }
    expect(proposed.auditLog.some((a) => a.action === "replacement-object-not-found")).toBe(true);
  });
});

describe("orchestrator flags findings that have no mechanical fix behind them", () => {
  it("marks an approved finding as deferred (not silently left approved) when remediation can't apply anything for it", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZNOFIXTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    // The mock's "Missing ORDER BY" finding has fixOrigin "none" — there is
    // no automated fix for it, by design.
    const noFixFinding = program.findings.find((f) => f.checkName === "Missing ORDER BY");
    expect(noFixFinding).toBeDefined();

    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");

    expect(proposed.state).toBe("AWAITING_FIX_REVIEW");
    const updated = proposed.findings.find((f) => f.id === noFixFinding!.id);
    expect(updated?.status).toBe("deferred");
    expect(proposed.auditLog.some((a) => a.action === "no-automated-fix")).toBe(true);
  });
});

// A SapClient with one custom (Y/Z) INCLUDE dependency whose own source
// carries a violation the primary object's source doesn't have — proves
// findings from an Include are surfaced with the right containerObject
// attribution, and that remediation (which only ever touches the primary
// object) correctly defers them instead of pretending to fix them.
class IncludeDependencySapClient extends MockSapClient implements SapClient {
  async getDependencies(): Promise<DependencyObject[]> {
    return [{ name: "ZCL_INCL_HELPER", type: "INCLUDE", usedBy: "primary" }];
  }
  async readObjectSource(name: string, objectType?: string): Promise<ObjectSource> {
    if (objectType === "INCLUDE") {
      return { name, type: "INCL", source: "SELECT * FROM vbap INTO TABLE @DATA(lt_vbap)." };
    }
    return super.readObjectSource(name, objectType);
  }
  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    if (currentSource.includes("vbap")) {
      return [
        {
          atcCheckId: "TEST_INCLUDE_FINDING",
          checkName: "Test include finding",
          message: "Direct SELECT on vbap in include",
          objectName: "VBAP",
          priority: 2,
          extensibilityLevel: "C",
          fixOrigin: "ai_generated",
          fixDescription: "Identify a released CDS view for vbap.",
          fixConfidence: "low",
        },
      ];
    }
    return super.runAtcCheck(objectNames, currentSource);
  }
}

describe("orchestrator surfaces findings from Includes/Classes with correct object attribution (real mode only)", () => {
  it("attributes an Include's finding to the Include, and defers it (never silently 'fixes' the primary object instead)", async () => {
    const prior = process.env.SAP_INTEGRATION_MODE;
    process.env.SAP_INTEGRATION_MODE = "real";
    try {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new IncludeDependencySapClient());

      const [program] = await orchestrator.ingest([
        { programName: "ZINCLTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);
      const includeFinding = program.findings.find((f) => f.atcCheckId === "TEST_INCLUDE_FINDING");
      expect(includeFinding).toBeDefined();
      expect(includeFinding?.containerObject).toBe("ZCL_INCL_HELPER");

      const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");

      expect(proposed.state).toBe("AWAITING_FIX_REVIEW");
      const updated = proposed.findings.find((f) => f.id === includeFinding!.id);
      expect(updated?.status).toBe("deferred");
      expect(
        proposed.auditLog.some((a) => a.action === "no-automated-fix" && a.details?.includes("ZCL_INCL_HELPER"))
      ).toBe(true);
    } finally {
      process.env.SAP_INTEGRATION_MODE = prior;
    }
  });

  it("does not expand analysis to dependencies in mock mode (no behavior change to the existing demo path)", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new IncludeDependencySapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZINCLTEST2", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(program.findings.some((f) => f.atcCheckId === "TEST_INCLUDE_FINDING")).toBe(false);
    expect(program.findings.every((f) => f.containerObject === "ZINCLTEST2")).toBe(true);
  });
});

describe("orchestrator guards unsupported object types in real mode", () => {
  it("parks a non-PROGRAM object without touching SAP when SAP_INTEGRATION_MODE=real", async () => {
    const prior = process.env.SAP_INTEGRATION_MODE;
    process.env.SAP_INTEGRATION_MODE = "real";
    try {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new MockSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "ZCL_TEST", objectType: "CLASS", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.state).toBe("PARKED");
      expect(program.auditLog.some((a) => a.action === "object-type-not-supported")).toBe(true);
    } finally {
      process.env.SAP_INTEGRATION_MODE = prior;
    }
  });
});
