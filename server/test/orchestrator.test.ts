import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { InMemoryProgramStore } from "../src/store/store";
import { MockSapClient } from "../src/sap/MockSapClient";
import { SapClient } from "../src/sap/SapClient";

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
