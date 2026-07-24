import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { InMemoryProgramStore } from "../src/store/store";
import { AbapObjectType, DependencyObject } from "../src/domain/types";
import { MockSapClient } from "../src/sap/MockSapClient";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "../src/sap/SapClient";

/**
 * Full-app scenario coverage for the clean-core migration pipeline, run
 * entirely against dummy in-memory SapClient fakes — never against
 * RealAdtClient or any real SAP destination. This is the "review the whole
 * app end to end" pass: every fake here plays the role a real SAP landscape
 * would (real ATC success, real ATC unavailable/fallback, Includes, global
 * Classes, standard vs custom namespace objects, function modules,
 * interfaces...), so the orchestrator's actual decision logic is exercised,
 * not just each agent in isolation. No object is ever written to a real
 * system in this file; the human-gated write path (fixReviewDecision
 * "approve" -> syntaxCheckAndActivate) is exercised only against these
 * fakes, exactly like every other test in this suite.
 */

function withRealMode<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.SAP_INTEGRATION_MODE;
  process.env.SAP_INTEGRATION_MODE = "real";
  return fn().finally(() => {
    process.env.SAP_INTEGRATION_MODE = prior;
  });
}

// ---------------------------------------------------------------------------
// Scenario group B: closure objects (Includes / Classes / FMs / Interfaces)
// ---------------------------------------------------------------------------

/**
 * A classic "shell report" — REPORT + three logic-carrying Includes, the
 * common real-world pattern that originally motivated the multi-object
 * design (see docs/design/multi-object-dependency-remediation.md §1). Models
 * real ATC's actual one-compilation-unit behavior: a single real ATC run
 * scoped to the report already returns findings for all three Includes
 * (each with its own foundInObject), so this fake's runAtcCheck must only
 * ever be called once for the whole set — the dedup-fix regression case at
 * full-orchestrator scale (previously: 4 objects x 8 findings = 32 total).
 */
class ShellReportSapClient extends MockSapClient implements SapClient {
  calls: string[] = [];
  async getDependencies(): Promise<DependencyObject[]> {
    return [
      { name: "Z_SHELL_TOP", type: "INCLUDE" },
      { name: "Z_SHELL_F01", type: "INCLUDE" },
      { name: "Z_SHELL_F02", type: "INCLUDE" },
    ];
  }
  async readObjectSource(name: string, objectType?: string): Promise<ObjectSource> {
    if (objectType === "INCLUDE") return { name, type: "INCL", source: `* logic for ${name}` };
    return super.readObjectSource(name, objectType);
  }
  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    this.calls.push(objectNames[0]);
    if (objectNames[0] !== "Z_SHELL_REPORT") return super.runAtcCheck(objectNames, currentSource);
    return ["Z_SHELL_TOP", "Z_SHELL_F01", "Z_SHELL_F02"].map((incl, i) => ({
      atcCheckId: `SHELL_FINDING_${i}`,
      checkName: "Test finding",
      message: `Finding located in ${incl}`,
      objectName: "Z_SHELL_REPORT",
      foundInObject: incl,
      priority: 2,
      extensibilityLevel: "C",
      fixOrigin: "none",
      fixDescription: "n/a",
      fixConfidence: "low",
    }));
  }
}

describe("scenario: classic shell report (REPORT + 3 Includes), real ATC succeeds", () => {
  it("queries real ATC exactly once for the whole compilation unit and attributes each Include's finding without duplication", async () => {
    await withRealMode(async () => {
      const store = new InMemoryProgramStore();
      const sap = new ShellReportSapClient();
      const orchestrator = new Orchestrator(store, sap);

      const [program] = await orchestrator.ingest([
        { programName: "Z_SHELL_REPORT", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(sap.calls).toEqual(["Z_SHELL_REPORT"]);
      for (const [i, incl] of ["Z_SHELL_TOP", "Z_SHELL_F01", "Z_SHELL_F02"].entries()) {
        const matches = program.findings.filter((f) => f.atcCheckId === `SHELL_FINDING_${i}`);
        expect(matches).toHaveLength(1);
        expect(matches[0].containerObject).toBe(incl);
      }
    });
  });
});

/**
 * A primary Program depending on both a Y/Z Include and a Y/Z global Class —
 * proves the CLASS/INCLUDE asymmetry end-to-end through the real
 * Orchestrator, not just at the cleanCoreAnalysisAgent unit level: the
 * Include's finding rides in on the primary's own real ATC run (one
 * compilation unit), while the Class — its own independent compilation/
 * activation unit — still gets its own real ATC call.
 */
class MixedClosureSapClient extends MockSapClient implements SapClient {
  calls: string[] = [];
  async getDependencies(): Promise<DependencyObject[]> {
    return [
      { name: "Z_MIXED_TOP", type: "INCLUDE" },
      { name: "ZCL_MIXED_HELPER", type: "CLASS" },
    ];
  }
  async readObjectSource(name: string, objectType?: string): Promise<ObjectSource> {
    if (name === "Z_MIXED_TOP" && objectType === "INCLUDE") {
      return { name, type: "INCL", source: "SELECT * FROM vbrk INTO TABLE @DATA(lt_vbrk)." };
    }
    if (name === "ZCL_MIXED_HELPER" && objectType === "CLASS") {
      return { name, type: "CLAS", source: "CLASS zcl_mixed_helper IMPLEMENTATION.\n  METHOD run.\n    UPDATE vbak SET netwr = 0 WHERE vbeln = '1'.\n  ENDMETHOD.\nENDCLASS." };
    }
    return super.readObjectSource(name, objectType);
  }
  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    this.calls.push(objectNames[0]);
    if (objectNames[0] === "Z_TEST_MIXED_CLOSURE") {
      return [
        {
          atcCheckId: "REAL_INCLUDE_FINDING",
          checkName: "Direct SELECT on vbrk",
          message: "Direct SELECT on vbrk in include",
          objectName: "VBRK",
          foundInObject: "Z_MIXED_TOP",
          priority: 2,
          extensibilityLevel: "C",
          fixOrigin: "ai_generated",
          fixDescription: "Identify a released CDS view for vbrk.",
          fixConfidence: "low",
        },
      ];
    }
    if (objectNames[0] === "ZCL_MIXED_HELPER") {
      return [
        {
          atcCheckId: "REAL_CLASS_FINDING",
          checkName: "Direct write to vbak",
          message: "Direct UPDATE on vbak in class",
          objectName: "VBAK",
          priority: 1,
          extensibilityLevel: "D",
          fixOrigin: "ai_generated",
          fixDescription: "Replace direct write to vbak with a released BAPI.",
          fixConfidence: "medium",
        },
      ];
    }
    return super.runAtcCheck(objectNames, currentSource);
  }
}

describe("scenario: mixed Include+Class closure (real ATC succeeds for the primary)", () => {
  it("re-queries real ATC for the Class but not the Include, attributes both correctly, and defers both as cross-object at Gate 1", async () => {
    await withRealMode(async () => {
      const store = new InMemoryProgramStore();
      const sap = new MixedClosureSapClient();
      const orchestrator = new Orchestrator(store, sap);

      const [program] = await orchestrator.ingest([
        { programName: "Z_TEST_MIXED_CLOSURE", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(sap.calls).toEqual(["Z_TEST_MIXED_CLOSURE", "ZCL_MIXED_HELPER"]);
      const includeFinding = program.findings.find((f) => f.atcCheckId === "REAL_INCLUDE_FINDING");
      const classFinding = program.findings.find((f) => f.atcCheckId === "REAL_CLASS_FINDING");
      expect(includeFinding?.containerObject).toBe("Z_MIXED_TOP");
      expect(classFinding?.containerObject).toBe("ZCL_MIXED_HELPER");

      const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "proceed");
      expect(proposed.findings.find((f) => f.id === includeFinding!.id)?.status).toBe("deferred");
      expect(proposed.findings.find((f) => f.id === classFinding!.id)?.status).toBe("deferred");
      expect(proposed.auditLog.some((a) => a.action === "no-automated-fix" && a.details?.includes("Z_MIXED_TOP"))).toBe(true);
      expect(proposed.auditLog.some((a) => a.action === "no-automated-fix" && a.details?.includes("ZCL_MIXED_HELPER"))).toBe(true);
    });
  });
});

/**
 * Same mixed Include+Class closure, but the primary's real ATC run itself
 * falls back to the static engine (ATC RFC unavailable — the exact
 * "night-time" scenario). Both closure members must still get their own
 * static-engine pass: the fallback engine has no cross-file awareness, so
 * skipping either would silently lose coverage whenever real ATC is down.
 */
class MixedClosureFallbackSapClient extends MockSapClient implements SapClient {
  async getDependencies(): Promise<DependencyObject[]> {
    return [
      { name: "Z_FB_TOP", type: "INCLUDE" },
      { name: "ZCL_FB_HELPER", type: "CLASS" },
    ];
  }
  async readObjectSource(name: string, objectType?: string): Promise<ObjectSource> {
    // Uses the exact fixed-template substrings MockSapClient's own CATALOG
    // rules match on (see MockSapClient.ts) so the static-engine stand-in
    // actually fires per closure member, the same way runStaticAtcRules
    // would fire against real source text in RealAdtClient's fallback path.
    if (name === "Z_FB_TOP" && objectType === "INCLUDE") return { name, type: "INCL", source: "SELECT * FROM mara INTO TABLE @DATA(lt_mara) UP TO 100 ROWS." };
    if (name === "ZCL_FB_HELPER" && objectType === "CLASS") return { name, type: "CLAS", source: "UPDATE vbak SET netwr = 0 WHERE vbeln = '1'." };
    return super.readObjectSource(name, objectType);
  }
  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    if (objectNames[0] === "Z_TEST_FALLBACK_MIXED") {
      return [
        {
          atcCheckId: "SYSTEM_ATC_FALLBACK",
          checkName: "Live ATC unavailable",
          message: "ATC RFC destination offline (simulated night-time outage).",
          objectName: "Z_TEST_FALLBACK_MIXED",
          priority: 4,
          extensibilityLevel: "A",
          fixOrigin: "none",
          fixDescription: "Re-run once ATC RFC is back online.",
          fixConfidence: "low",
        },
      ];
    }
    // Each closure member's own static-engine pass over its own source.
    return super.runAtcCheck(objectNames, currentSource);
  }
}

describe("scenario: mixed Include+Class closure when real ATC is unavailable (fallback)", () => {
  it("still runs the static engine over each closure member's own source, preserving coverage while ATC RFC is down", async () => {
    await withRealMode(async () => {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new MixedClosureFallbackSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "Z_TEST_FALLBACK_MIXED", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.findings.some((f) => f.atcCheckId === "SYSTEM_ATC_FALLBACK")).toBe(true);
      const includeFinding = program.findings.find((f) => f.containerObject === "Z_FB_TOP");
      const classFinding = program.findings.find((f) => f.containerObject === "ZCL_FB_HELPER");
      expect(includeFinding?.checkName).toBe("Usage of APIs");
      expect(classFinding?.checkName).toBe("Usage of APIs");
    });
  });
});

/**
 * A closure candidate list mixing a standard (non-Z/Y) Include, a Y-Include
 * whose source can't be fetched, and a genuinely analyzable Y-Include —
 * only the last should ever be treated as "ours to fix" (see
 * resolveClosureObjects in orchestrator.ts). Custom-rule findings (which run
 * unconditionally per closure object, independent of ATC mode) are used as
 * the observable signal here: only the analyzable Include's own source
 * (deliberately containing a client-handling anti-pattern) should ever
 * produce a finding attributed to it.
 */
class FilteredClosureSapClient extends MockSapClient implements SapClient {
  async getDependencies(): Promise<DependencyObject[]> {
    return [
      { name: "SAPMV45A", type: "INCLUDE" }, // standard namespace -> excluded
      { name: "Z_UNREADABLE_INCL", type: "INCLUDE" }, // Y/Z but source unfetchable -> excluded
      { name: "Z_REAL_INCL", type: "INCLUDE" }, // Y/Z and fetchable -> included
    ];
  }
  async readObjectSource(name: string, objectType?: string): Promise<ObjectSource> {
    if (name === "Z_UNREADABLE_INCL") throw new Error("simulated ADT 404 — source not readable");
    if (name === "SAPMV45A" && objectType === "INCLUDE") return { name, type: "INCL", source: "* standard SAP include, not ours to fix" };
    if (name === "Z_REAL_INCL" && objectType === "INCLUDE") return { name, type: "INCL", source: "IF SY-MANDT = '100'.\n  WRITE 'client specific'.\nENDIF." };
    return super.readObjectSource(name, objectType);
  }
}

describe("scenario: closure resolution excludes standard-namespace and unretrievable dependencies", () => {
  it("only analyzes the genuinely custom, source-retrievable Include", async () => {
    await withRealMode(async () => {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new FilteredClosureSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "Z_FILTER_TEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.dependencies.map((d) => d.name)).toEqual(
        expect.arrayContaining(["SAPMV45A", "Z_UNREADABLE_INCL", "Z_REAL_INCL"])
      );
      const clientHandlingFinding = program.findings.find((f) => f.atcCheckId === "CUSTOM_RULE_CLIENT_HANDLING");
      expect(clientHandlingFinding?.containerObject).toBe("Z_REAL_INCL");
      expect(program.findings.some((f) => f.containerObject === "SAPMV45A")).toBe(false);
      expect(program.findings.some((f) => f.containerObject === "Z_UNREADABLE_INCL")).toBe(false);
    });
  });
});

/**
 * Function Modules and Interfaces are tracked as dependencies (discovery
 * surfaces them so the backlog is honest about what's coming) but are NOT
 * expanded into their own findings today — resolveClosureObjects only
 * handles INCLUDE/CLASS (docs/design/multi-object-dependency-remediation.md
 * §0/§3.2). This documents that as current, intentional-scope behavior
 * rather than a silent gap: a custom Z function module with its own clean-
 * core violations would not surface them until FM support is built.
 */
class FmAndInterfaceDepsSapClient extends MockSapClient implements SapClient {
  async getDependencies(): Promise<DependencyObject[]> {
    return [
      { name: "Z_CUSTOM_FM", type: "FUNCTION_MODULE" },
      { name: "BAPI_MATERIAL_GET_DETAIL", type: "FUNCTION_MODULE" },
      { name: "ZIF_CUSTOM_INTERFACE", type: "INTERFACE" },
    ];
  }
}

describe("scenario: Function Module and Interface dependencies (known scope gap)", () => {
  it("tracks FM/Interface dependencies but does not analyze their own source (not yet in scope)", async () => {
    await withRealMode(async () => {
      const store = new InMemoryProgramStore();
      const orchestrator = new Orchestrator(store, new FmAndInterfaceDepsSapClient());

      const [program] = await orchestrator.ingest([
        { programName: "Z_FM_TEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
      ]);

      expect(program.dependencies.map((d) => d.name)).toEqual(
        expect.arrayContaining(["Z_CUSTOM_FM", "BAPI_MATERIAL_GET_DETAIL", "ZIF_CUSTOM_INTERFACE"])
      );
      expect(program.findings.some((f) => f.containerObject === "Z_CUSTOM_FM")).toBe(false);
      expect(program.findings.some((f) => f.containerObject === "BAPI_MATERIAL_GET_DETAIL")).toBe(false);
      expect(program.findings.some((f) => f.containerObject === "ZIF_CUSTOM_INTERFACE")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario group C: unsupported primary object types are parked, untouched
// ---------------------------------------------------------------------------

/** Throws on every SAP call — proves the object-type guard parks BEFORE any discovery/ATC call is attempted, not merely alongside one that happens to fail gracefully. */
class NeverCalledSapClient extends MockSapClient implements SapClient {
  async readObjectSource(): Promise<ObjectSource> {
    throw new Error("must not be called for a parked object type");
  }
  async getDependencies(): Promise<DependencyObject[]> {
    throw new Error("must not be called for a parked object type");
  }
}

describe.each<AbapObjectType>(["CLASS", "FUNCTION_GROUP", "INCLUDE", "INTERFACE", "CDS_VIEW"])(
  "scenario: real-mode guard parks unsupported primary object type %s",
  (objectType) => {
    it(`parks a ${objectType} without making any SAP call`, async () => {
      await withRealMode(async () => {
        const store = new InMemoryProgramStore();
        const orchestrator = new Orchestrator(store, new NeverCalledSapClient());

        const [program] = await orchestrator.ingest([
          { programName: `Z_${objectType}_TEST`, objectType, package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
        ]);

        expect(program.state).toBe("PARKED");
        expect(program.auditLog.some((a) => a.action === "object-type-not-supported")).toBe(true);
      });
    });
  }
);

// ---------------------------------------------------------------------------
// Scenario group D: workflow / gate mechanics
// ---------------------------------------------------------------------------

describe("scenario: Gate 1 partial approval only remediates the approved subset", () => {
  it("leaves un-approved findings deferred and untouched by remediation", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZPARTIALTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(program.findings.length).toBeGreaterThanOrEqual(2);
    const [toApprove, ...rest] = program.findings;

    const proposed = await orchestrator.gate1Decision(program.id, "approve", [toApprove.id], "only this one");

    expect(proposed.findings.find((f) => f.id === toApprove.id)?.status).not.toBe("deferred");
    for (const f of rest) {
      expect(proposed.findings.find((x) => x.id === f.id)?.status).toBe("deferred");
    }
  });
});

describe("scenario: a clean program with zero findings still completes the pipeline with no proposed changes", () => {
  class CleanProgramSapClient extends MockSapClient implements SapClient {
    async readObjectSource(name: string): Promise<ObjectSource> {
      return { name, type: "PROG", source: "REPORT z_clean.\nWRITE 'hello, clean core'." };
    }
    async getDependencies(): Promise<DependencyObject[]> {
      return [];
    }
  }

  it("produces zero findings and a byte-identical proposed source", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new CleanProgramSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZCLEANTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    expect(program.findings).toHaveLength(0);
    expect(program.riskScore?.total).toBe(0);
    expect(program.riskScore?.band).toBe("Low");

    const proposed = await orchestrator.gate1Decision(program.id, "approve", undefined, "nothing to fix");
    expect(proposed.state).toBe("AWAITING_FIX_REVIEW");
    expect(proposed.proposedSource).toBe(proposed.baselineSource);
  });
});

describe("scenario: Fix Review 'request changes' loops back and re-proposes", () => {
  it("increments remediationAttempts and returns to AWAITING_FIX_REVIEW with a fresh proposal", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZREQCHANGETEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const firstProposal = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");
    expect(firstProposal.remediationAttempts).toBe(1);

    const reproposed = await orchestrator.fixReviewDecision(program.id, "request_changes", undefined, "not quite right, redo it");

    expect(reproposed.state).toBe("AWAITING_FIX_REVIEW");
    expect(reproposed.remediationAttempts).toBe(2);
  });
});

/** ATC keeps reporting the same finding after every fix attempt — models a real system where the underlying issue genuinely isn't resolved by the mechanical fix. */
class AlwaysReflagsSapClient extends MockSapClient implements SapClient {
  async syntaxCheckAndActivate() {
    return { syntaxOk: true, activated: true, messages: ["activated (mock)"] };
  }
  async runAtcCheck(): Promise<AtcRawFinding[]> {
    return [
      {
        atcCheckId: "STATIC_USAGE_API_SELECT_STAR",
        checkName: "Usage of APIs (direct table read)",
        message: "SELECT * FROM mara persists",
        objectName: "MARA",
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

describe("scenario: validation keeps failing across every retry until the retry cap escalates", () => {
  it("escalates once remediationAttempts reaches MAX_REMEDIATION_ATTEMPTS, without ever pretending the fix worked", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new AlwaysReflagsSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZALWAYSFAILTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const attempt1 = await orchestrator.gate1Decision(program.id, "approve", undefined, "go");
    expect(attempt1.state).toBe("AWAITING_FIX_REVIEW");

    const afterAttempt1 = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "write it");
    expect(afterAttempt1.state).toBe("AWAITING_FIX_REVIEW"); // auto-retried, not yet escalated
    expect(afterAttempt1.remediationAttempts).toBe(2);

    const afterAttempt2 = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "write it again");
    expect(afterAttempt2.state).toBe("ESCALATED");
    expect(afterAttempt2.auditLog.some((a) => a.action === "validation-failed-escalated")).toBe(true);
  });
});

/** ATC reports the finding through the first validation attempt, then reports it cleared — a transient failure that a retry genuinely resolves. */
class FlakyThenClearsSapClient extends MockSapClient implements SapClient {
  private atcCalls = 0;
  async syntaxCheckAndActivate() {
    return { syntaxOk: true, activated: true, messages: ["activated (mock)"] };
  }
  async runAtcCheck(): Promise<AtcRawFinding[]> {
    this.atcCalls += 1;
    if (this.atcCalls <= 2) {
      return [
        {
          atcCheckId: "STATIC_USAGE_API_SELECT_STAR",
          checkName: "Usage of APIs (direct table read)",
          message: "SELECT * FROM mara",
          objectName: "MARA",
          priority: 2,
          extensibilityLevel: "C",
          fixOrigin: "native_quick_fix",
          fixDescription: "Replace direct SELECT on MARA with released CDS view I_Product.",
          replacementObject: "I_Product",
          fixConfidence: "high",
        },
      ];
    }
    return [];
  }
  async runAbapUnit(): Promise<UnitTestCaseResult[]> {
    return [
      { name: "test_a", pass: true },
      { name: "test_b", pass: true },
      { name: "test_c", pass: true },
    ];
  }
}

describe("scenario: validation recovers on retry before the cap is reached", () => {
  it("reaches AWAITING_HUMAN_REVIEW_2 on the second attempt instead of escalating", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new FlakyThenClearsSapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZFLAKYTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);
    const attempt1 = await orchestrator.fixReviewDecision(
      (await orchestrator.gate1Decision(program.id, "approve", undefined, "go")).id,
      "approve",
      undefined,
      "write it"
    );
    expect(attempt1.state).toBe("AWAITING_FIX_REVIEW");

    const attempt2 = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "retry");
    expect(attempt2.state).toBe("AWAITING_HUMAN_REVIEW_2");
    expect(attempt2.validationReport?.overallPass).toBe(true);
  });
});

/** Guaranteed to reach AWAITING_HUMAN_REVIEW_2 deterministically, for Gate 2 scenarios that don't care about the validation path itself. */
class AlwaysPassesSapClient extends MockSapClient implements SapClient {
  private atcCalls = 0;
  async readObjectSource(name: string): Promise<ObjectSource> {
    return { name, type: "PROG", source: "REPORT z_always_pass.\nSELECT * FROM mara INTO TABLE @DATA(lt_mara) UP TO 100 ROWS." };
  }
  async getDependencies(): Promise<DependencyObject[]> {
    return [];
  }
  async runAtcCheck(): Promise<AtcRawFinding[]> {
    this.atcCalls += 1;
    if (this.atcCalls === 1) {
      return [
        {
          atcCheckId: "STATIC_USAGE_API_SELECT_STAR",
          checkName: "Usage of APIs (direct table read)",
          message: "SELECT * FROM mara",
          objectName: "MARA",
          priority: 2,
          extensibilityLevel: "C",
          fixOrigin: "native_quick_fix",
          fixDescription: "Replace direct SELECT on MARA with released CDS view I_Product.",
          replacementObject: "I_Product",
          fixConfidence: "high",
        },
      ];
    }
    return [];
  }
  async runAbapUnit(): Promise<UnitTestCaseResult[]> {
    return [
      { name: "test_a", pass: true },
      { name: "test_b", pass: true },
      { name: "test_c", pass: true },
    ];
  }
}

async function walkToGate2(orchestrator: Orchestrator, programName: string, store: InMemoryProgramStore) {
  const [program] = await orchestrator.ingest([
    { programName, package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
  ]);
  await orchestrator.gate1Decision(program.id, "approve", undefined, "go");
  const validated = await orchestrator.fixReviewDecision(program.id, "approve", undefined, "write it");
  expect(validated.state).toBe("AWAITING_HUMAN_REVIEW_2");
  return validated;
}

describe("scenario: Gate 2 requires a transport request number to approve", () => {
  it("rejects an approval with no transport number and leaves the program awaiting Gate 2", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new AlwaysPassesSapClient());
    const program = await walkToGate2(orchestrator, "ZNOTPTEST", store);

    await expect(orchestrator.gate2Decision(program.id, "approve", "ship it", undefined)).rejects.toThrow(/transport/i);
    const stillWaiting = await store.get(program.id);
    expect(stillWaiting?.state).toBe("AWAITING_HUMAN_REVIEW_2");
  });
});

describe("scenario: Gate 2 approval with a transport number completes the workflow", () => {
  it("reaches DONE with the transport number recorded in the program and the generated report", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new AlwaysPassesSapClient());
    const program = await walkToGate2(orchestrator, "ZTPTEST", store);

    const done = await orchestrator.gate2Decision(program.id, "approve", "ship it", "SHDK900123");
    expect(done.state).toBe("DONE");
    expect(done.transportNumber).toBe("SHDK900123");
    expect(done.report?.markdown).toContain("SHDK900123");
  });
});

describe("scenario: Gate 2 'request changes' loops back for another remediation round", () => {
  it("returns to AWAITING_FIX_REVIEW with an incremented remediation attempt count", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new AlwaysPassesSapClient());
    const program = await walkToGate2(orchestrator, "ZGATE2REDOTEST", store);
    const attemptsBefore = program.remediationAttempts;

    const reproposed = await orchestrator.gate2Decision(program.id, "request_changes", "needs another look");
    expect(reproposed.state).toBe("AWAITING_FIX_REVIEW");
    expect(reproposed.remediationAttempts).toBe(attemptsBefore + 1);
  });
});

describe("scenario: bulk ingest processes multiple programs independently", () => {
  it("does not let one program's dependencies/findings leak into another's", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new MockSapClient());

    const programs = await orchestrator.ingest([
      { programName: "ZBULK_A", package: "ZSD", businessArea: "Sales", criticality: "H", owner: "dev1" },
      { programName: "ZBULK_B", package: "ZMM", businessArea: "Materials", criticality: "M", owner: "dev2" },
      { programName: "ZBULK_C", package: "ZFI", businessArea: "Finance", criticality: "L", owner: "dev3" },
    ]);

    expect(programs).toHaveLength(3);
    expect(new Set(programs.map((p) => p.id)).size).toBe(3);
    for (const p of programs) {
      expect(p.state).toBe("AWAITING_HUMAN_REVIEW_1");
      expect(p.findings.every((f) => f.containerObject === p.name)).toBe(true);
    }
    expect(programs[0].package).toBe("ZSD");
    expect(programs[1].package).toBe("ZMM");
    expect(programs[2].package).toBe("ZFI");
  });
});

describe("scenario: a mid-pipeline SAP failure is recorded, not left crashed", () => {
  class ThrowsOnDiscoverySapClient extends MockSapClient implements SapClient {
    async readObjectSource(): Promise<ObjectSource> {
      throw new Error("simulated SAP connectivity failure during discovery");
    }
  }

  it("keeps the program in its last-known state with a pipeline-error audit entry, and does not throw out of ingest()", async () => {
    const store = new InMemoryProgramStore();
    const orchestrator = new Orchestrator(store, new ThrowsOnDiscoverySapClient());

    const [program] = await orchestrator.ingest([
      { programName: "ZPIPELINEFAILTEST", package: "ZPKG", businessArea: "Test", criticality: "M", owner: "tester" },
    ]);

    expect(program.state).toBe("UPLOADED");
    expect(program.auditLog.some((a) => a.action === "pipeline-error")).toBe(true);
    const persisted = await store.get(program.id);
    expect(persisted?.state).toBe("UPLOADED");
  });
});
