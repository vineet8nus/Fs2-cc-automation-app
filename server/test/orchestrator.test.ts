import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { InMemoryProgramStore } from "../src/store/store";
import { DependencyObject } from "../src/domain/types";
import { MockSapClient } from "../src/sap/MockSapClient";
import { AtcRawFinding, ObjectSource, SapClient } from "../src/sap/SapClient";
import { AiFixResult, AiRemediationClient } from "../src/agents/aiRemediationAgent";
import { Finding } from "../src/domain/types";

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

    const result = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "approve write", "TR12345");

    expect(result.state).toBe("ESCALATED");
    expect(result.state).not.toBe("VALIDATING");
    expect(result.auditLog.some((a) => a.action === "validation-error")).toBe(true);

    // Re-fetching from the store must show the same resolved state, not a
    // program stuck mid-transition.
    expect((await store.get(program.id))?.state).toBe("ESCALATED");
  });

  it("retryFromEscalation re-enters the human-gated fix-review cycle instead of re-writing directly", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new ThrowsOnActivateSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZRETRYTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");
    const escalated = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "approve write", "TR12345");
    expect(escalated.state).toBe("ESCALATED");

    const retried = await orchestrator.retryFromEscalation(program.id);

    // A fresh proposal, sent back to Fix Review for a new human approval —
    // never straight back to VALIDATING/SAP without one.
    expect(retried.state).toBe("AWAITING_FIX_REVIEW");
    expect(retried.auditLog.some((a) => a.action === "escalation-retry-requested")).toBe(true);
  });

  it("retryFromEscalation refuses to run from any state other than ESCALATED", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZNOTESCALATED", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(program.state).toBe("AWAITING_HUMAN_REVIEW_1");

    await expect(orchestrator.retryFromEscalation(program.id)).rejects.toThrow(/not ESCALATED/);
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
  // Models real ATC's actual behavior (see atcFindingClassifier.ts): a run
  // scoped to the primary Program's own URI already covers its whole
  // compilation unit, so it surfaces this Include's finding directly, with
  // `foundInObject` set from the finding's own location — not a second,
  // independent call scoped to the Include's own URI (which the orchestrator
  // no longer makes when the primary run already used real ATC; see
  // cleanCoreAnalysisAgent's needsOwnAtcRun).
  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    if (objectNames[0] === "ZINCLTEST") {
      return [
        {
          atcCheckId: "TEST_INCLUDE_FINDING",
          checkName: "Test include finding",
          message: "Direct SELECT on vbap in include",
          objectName: "ZINCLTEST",
          foundInObject: "ZCL_INCL_HELPER",
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
  it("parks a FUNCTION_GROUP without touching SAP when SAP_INTEGRATION_MODE=real (container-vs-function-module mismatch)", async () => {
    const prior = process.env.SAP_INTEGRATION_MODE;
    process.env.SAP_INTEGRATION_MODE = "real";
    try {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new MockSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "Z_FG_TEST", objectType: "FUNCTION_GROUP", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.state).toBe("PARKED");
      expect(program.auditLog.some((a) => a.action === "object-type-not-supported")).toBe(true);
    } finally {
      process.env.SAP_INTEGRATION_MODE = prior;
    }
  });

  it("no longer parks a CLASS in real mode — it now proceeds through the live pipeline", async () => {
    const prior = process.env.SAP_INTEGRATION_MODE;
    process.env.SAP_INTEGRATION_MODE = "real";
    try {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new MockSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "ZCL_TEST", objectType: "CLASS", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.state).not.toBe("PARKED");
      expect(program.auditLog.some((a) => a.action === "object-type-not-supported")).toBe(false);
    } finally {
      process.env.SAP_INTEGRATION_MODE = prior;
    }
  });
});

/** Returns a different dependency set on each successive getDependencies() call — models a real system where a re-scan can pick up a newly added Include. */
class ChangingDependenciesSapClient extends MockSapClient implements SapClient {
  private calls = 0;
  async getDependencies(): Promise<DependencyObject[]> {
    this.calls += 1;
    return this.calls === 1 ? [] : [{ name: "ZCL_NEW_INCL", type: "INCLUDE", usedBy: "primary" }];
  }
}

describe("orchestrator.rerunAnalysis re-runs discovery/analysis in place", () => {
  it("discards prior findings/dependencies and re-derives them without creating a new program row", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new ChangingDependenciesSapClient());

    const [first] = await orchestrator.ingest([
      { programName: "ZRERUNTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(first.dependencies).toHaveLength(0);

    const rerun = await orchestrator.rerunAnalysis(first.id);

    expect(rerun.id).toBe(first.id);
    expect(rerun.dependencies.map((d) => d.name)).toContain("ZCL_NEW_INCL");
    expect(rerun.state).toBe("AWAITING_HUMAN_REVIEW_1");
    expect(rerun.auditLog.some((a) => a.action === "rerun-requested")).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it("can rerun a program that already reached AWAITING_HUMAN_REVIEW_2, resetting transport/remediation state", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZRERUNDONE", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    await orchestrator.gate1Decision(program.id, "approve", undefined, "go");
    await orchestrator.fixReviewDecision(program.id, "approve", undefined, "write it", "TR12345");

    const rerun = await orchestrator.rerunAnalysis(program.id);
    expect(rerun.id).toBe(program.id);
    expect(rerun.state).toBe("AWAITING_HUMAN_REVIEW_1");
    expect(rerun.transportNumber).toBeUndefined();
    expect(rerun.remediationAttempts).toBe(0);
    expect(rerun.validationReport).toBeUndefined();
    expect(rerun.proposedSource).toBeUndefined();
  });
});

/**
 * A real ATC finding's containerObject is often derived from the finding's
 * own location URI (always normalized to uppercase — see
 * atcFindingClassifier.ts's extractContainerFromLocation), regardless of
 * what casing the object was entered with at intake. This models exactly
 * that: the program is ingested as "zlowercasetest" (lowercase), but its
 * own findings come back attributed to "ZLOWERCASETEST" (uppercase) — a
 * real, reproducible scenario (confirmed live against ztest_vk2), not a
 * contrived edge case.
 */
class UppercaseAttributionSapClient extends MockSapClient implements SapClient {
  async readObjectSource(name: string) {
    return { name, type: "PROG", source: "REPORT zlowercasetest.\nSELECT * FROM mara INTO TABLE @DATA(lt_mara) UP TO 100 ROWS." };
  }
  async getDependencies(): Promise<DependencyObject[]> {
    return [];
  }
  async runAtcCheck(): Promise<AtcRawFinding[]> {
    return [
      {
        atcCheckId: "REAL_MARA_FINDING",
        checkName: "Usage of Released APIs",
        message: "Direct SELECT on table MARA is not released for Clean Core.",
        objectName: "ZLOWERCASETEST",
        foundInObject: "ZLOWERCASETEST",
        priority: 2,
        extensibilityLevel: "C",
        fixOrigin: "native_quick_fix",
        fixDescription: "Replace direct SELECT on MARA with released CDS view I_Product.",
        replacementObject: "I_Product",
        fixConfidence: "high",
      },
    ];
  }
}

describe("orchestrator treats a finding's own containerObject as case-insensitively equal to the intake name", () => {
  it("does not misclassify the primary object's own finding as cross-object just because intake casing differs from ATC's uppercase attribution", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new UppercaseAttributionSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "zlowercasetest", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const finding = program.findings.find((f) => f.atcCheckId === "REAL_MARA_FINDING");
    expect(finding?.containerObject).toBe("ZLOWERCASETEST");

    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");

    expect(proposed.findings.find((f) => f.id === finding!.id)?.status).toBe("fixed");
    expect(proposed.auditLog.some((a) => a.action === "no-automated-fix")).toBe(false);
    expect(proposed.proposedSource).not.toBe(proposed.baselineSource);
  });
});

/** Fake AiRemediationClient — never makes a real network call. Lets tests exercise the orchestrator's wiring without depending on live SAP AI Core. */
class FakeAiRemediationClient implements AiRemediationClient {
  calls: { programName: string; findingIds: string[] }[] = [];
  constructor(private readonly result: AiFixResult | undefined | ((findings: Finding[]) => AiFixResult | undefined)) {}
  async proposeFixes(programName: string, _source: string, findings: Finding[]): Promise<AiFixResult | undefined> {
    this.calls.push({ programName, findingIds: findings.map((f) => f.id) });
    return typeof this.result === "function" ? this.result(findings) : this.result;
  }
}

describe("orchestrator's optional AI Core remediation pass", () => {
  it("only calls AI remediation for findings the mechanical pass couldn't resolve, and marks its successes fixed", async () => {
    const store = new InMemoryProgramStore();
    // MockSapClient's default findings: MARA/VBAK/MATERIAL_READ/REFRESH all
    // get mechanically fixed by the hardcoded mock branches; "Missing ORDER
    // BY" (origin "none") is the one left over for the AI pass to see.
    const ai = new FakeAiRemediationClient((findings) => ({
      newSource: "REPORT ztest.\n* AI-fixed the ORDER BY issue.",
      appliedFindingIds: findings.map((f) => f.id),
      changeLog: ["[AI-fix] Added explicit ORDER BY."],
    }));
    const orchestrator = new Orchestrator(store, new MockSapClient(), ai);

    const [program] = await orchestrator.ingest([
      { programName: "ZAITEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");

    expect(ai.calls).toHaveLength(1);
    const orderByFinding = program.findings.find((f) => f.checkName === "Missing ORDER BY");
    expect(ai.calls[0].findingIds).toEqual([orderByFinding!.id]);
    expect(proposed.findings.find((f) => f.id === orderByFinding!.id)?.status).toBe("fixed");
    expect(proposed.proposedSource).toBe("REPORT ztest.\n* AI-fixed the ORDER BY issue.");
    expect(proposed.auditLog.some((a) => a.action === "no-automated-fix")).toBe(false);
  });

  it("falls back to the honest 'no automated fix' outcome when the AI pass returns nothing (failure or declined)", async () => {
    const store = new InMemoryProgramStore();
    const ai = new FakeAiRemediationClient(undefined);
    const orchestrator = new Orchestrator(store, new MockSapClient(), ai);

    const [program] = await orchestrator.ingest([
      { programName: "ZAIFAILTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");

    expect(ai.calls).toHaveLength(1);
    const orderByFinding = program.findings.find((f) => f.checkName === "Missing ORDER BY");
    expect(proposed.findings.find((f) => f.id === orderByFinding!.id)?.status).toBe("deferred");
    expect(proposed.auditLog.some((a) => a.action === "no-automated-fix")).toBe(true);
  });

  it("never invokes AI remediation when no client is configured (existing 2-arg construction, e.g. mock mode)", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZNOAITEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");

    const orderByFinding = program.findings.find((f) => f.checkName === "Missing ORDER BY");
    expect(proposed.findings.find((f) => f.id === orderByFinding!.id)?.status).toBe("deferred");
  });
});
