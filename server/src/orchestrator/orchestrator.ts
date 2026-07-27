import { v4 as uuidv4 } from "uuid";
import { AuditEntry, DependencyObject, ExcelIntakeRow, Finding, Program, WorkflowState } from "../domain/types";
import { ProgramStore } from "../store/store";
import { ObjectSource, SapClient } from "../sap/SapClient";
import { runDiscovery } from "../agents/discoveryAgent";
import { runCleanCoreAnalysis } from "../agents/cleanCoreAnalysisAgent";
import { runBaselineTests } from "../agents/baselineTestAgent";
import { runRemediation } from "../agents/remediationAgent";
import { runValidation } from "../agents/validationAgent";
import { generateReport } from "../agents/reportingAgent";
import { commitRemediation, diffAgainstBaseline, runGitSync } from "../agents/gitSyncAgent";
import { computeRiskScore, worstExtensibilityLevel } from "../risk/riskScore";
import { assertTransitionAllowed } from "./stateMachine";

const MAX_REMEDIATION_ATTEMPTS = 2;

function audit(program: Program, actor: string, action: string, from?: WorkflowState, to?: WorkflowState, details?: string) {
  const entry: AuditEntry = { timestamp: new Date().toISOString(), actor, action, fromState: from, toState: to, details };
  program.auditLog.push(entry);
}

function moveTo(program: Program, to: WorkflowState, actor: string, action: string, details?: string) {
  assertTransitionAllowed(program.state, to);
  const from = program.state;
  program.state = to;
  audit(program, actor, action, from, to, details);
}

/**
 * Which of the primary object's dependencies are eligible for real
 * findings analysis, per docs/design/multi-object-dependency-remediation.md
 * §0/§3.2: only Includes and Classes (the closure types that are actually
 * part of the same compiled unit or a direct custom dependency), only
 * custom (Y/Z-namespace) objects — standard objects are never analyzed as
 * "ours to fix", only ever referenced as replacement targets — and only
 * ones whose real source was actually retrieved (discoveryAgent falls back
 * to a placeholder string on a read failure; analyzing that placeholder as
 * if it were real code would manufacture false findings).
 *
 * Real-mode only: mock mode fabricates a handful of generic-named
 * dependencies whose "source" is always the same fixed template
 * regardless of name (see MockSapClient), so expanding analysis to them
 * would multiply the same findings across fake objects — a pure
 * demo-mode artifact, not a real signal. Gating this to real mode keeps
 * every existing mock-mode test and demo behavior exactly as it was.
 */
function resolveClosureObjects(
  dependencies: DependencyObject[],
  dependencySources: ObjectSource[]
): { name: string; source: string; type: "INCLUDE" | "CLASS" }[] {
  if ((process.env.SAP_INTEGRATION_MODE ?? "mock") !== "real") return [];
  const byName = new Map(dependencySources.map((s) => [s.name, s]));
  return dependencies
    .filter((d): d is DependencyObject & { type: "INCLUDE" | "CLASS" } => (d.type === "INCLUDE" || d.type === "CLASS") && /^[YZ]/i.test(d.name))
    .map((d) => {
      const source = byName.get(d.name);
      return source && !source.source.startsWith("-- source not retrieved") ? { name: source.name, source: source.source, type: d.type } : null;
    })
    .filter((s): s is { name: string; source: string; type: "INCLUDE" | "CLASS" } => !!s);
}

export class Orchestrator {
  constructor(private readonly store: ProgramStore, private readonly sap: SapClient) {}

  /** Creates one workflow instance per Excel row and runs it through the fully-automatic phases (Phase 2-4). */
  async ingest(rows: ExcelIntakeRow[]): Promise<Program[]> {
    const created: Program[] = [];
    for (const row of rows) {
      const now = new Date().toISOString();
      let program: Program = {
        id: uuidv4(),
        name: row.programName,
        objectType: row.objectType ?? "PROGRAM",
        package: row.package,
        businessArea: row.businessArea,
        criticality: row.criticality,
        owner: row.owner,
        state: "UPLOADED",
        dependencies: [],
        findings: [],
        remediationAttempts: 0,
        createdAt: now,
        updatedAt: now,
        auditLog: [],
      };
      audit(program, "system", "excel-intake", undefined, "UPLOADED", `Row: ${row.programName}`);
      await this.store.save(program);

      const isRealMode = (process.env.SAP_INTEGRATION_MODE ?? "mock") === "real";
      if (isRealMode && program.objectType !== "PROGRAM") {
        moveTo(
          program,
          "PARKED",
          "system",
          "object-type-not-supported",
          `${program.objectType} objects aren't read/written against the live system yet — only ABAP Programs/Includes are. Parked without touching SAP.`
        );
        await this.store.save(program);
        created.push(program);
        continue;
      }

      try {
        program = await this.runAutomaticPipeline(program);
      } catch (err) {
        audit(program, "system", "pipeline-error", program.state, program.state, String(err));
        await this.store.save(program);
      }
      created.push(program);
    }
    return created;
  }

  /**
   * Re-runs the fully-automatic pipeline (Git baseline -> Discovery ->
   * Analysis -> Baseline tests) against the SAME existing Program record,
   * instead of leaving the only path to a fresh check be re-uploading and
   * accumulating a duplicate backlog row per re-check (the real symptom
   * this fixes: repeatedly re-analyzing a program by re-creating it left a
   * growing pile of stale rows, none of which reflected a genuine re-scan
   * of the same object). Every pipeline-derived field is discarded and
   * freshly recomputed against whatever the SapClient returns right now —
   * this is the only way to pick up newly-added Includes/Classes, or a
   * real ATC result once the RFC destination is back online, instead of
   * being stuck with whatever was captured on the very first run. Intake
   * metadata (name, package, business area, criticality, owner, id) and
   * the full audit history are preserved, not reset.
   *
   * Allowed from any state — this is an explicit human reset action, not a
   * normal linear workflow step, so it deliberately bypasses
   * assertTransitionAllowed (via moveTo) for the reset hop itself, exactly
   * like ingest() starting a brand new program from UPLOADED.
   */
  async rerunAnalysis(programId: string): Promise<Program> {
    const program = await this.mustGet(programId);
    const fromState = program.state;

    audit(
      program,
      "human:rerun",
      "rerun-requested",
      fromState,
      "UPLOADED",
      `Discarding prior analysis (was ${fromState}) and re-running discovery/analysis from scratch.`
    );
    program.state = "UPLOADED";
    program.dependencies = [];
    program.findings = [];
    program.worstExtensibilityLevel = undefined;
    program.riskScore = undefined;
    program.baselineTests = undefined;
    program.gitBaseline = undefined;
    program.baselineSource = undefined;
    program.proposedSource = undefined;
    program.validationReport = undefined;
    program.transportNumber = undefined;
    program.report = undefined;
    program.remediationAttempts = 0;
    await this.store.save(program);

    const isRealMode = (process.env.SAP_INTEGRATION_MODE ?? "mock") === "real";
    if (isRealMode && program.objectType !== "PROGRAM") {
      moveTo(
        program,
        "PARKED",
        "system",
        "object-type-not-supported",
        `${program.objectType} objects aren't read/written against the live system yet — only ABAP Programs/Includes are. Parked without touching SAP.`
      );
      await this.store.save(program);
      return program;
    }

    try {
      return await this.runAutomaticPipeline(program);
    } catch (err) {
      audit(program, "system", "pipeline-error", program.state, program.state, String(err));
      await this.store.save(program);
      return program;
    }
  }

  /** Phases 2-4: Git baseline -> Discovery -> Analysis -> Baseline tests, up to Human Gate 1. */
  private async runAutomaticPipeline(program: Program): Promise<Program> {
    const discovery = await runDiscovery(program.name, this.sap);
    program.gitBaseline = runGitSync(program.name, discovery.programSource, discovery.dependencies, discovery.dependencySources);
    moveTo(program, "GIT_BASELINED", "GitSyncAgent", "baseline-snapshot", `commit ${program.gitBaseline.baselineCommit.slice(0, 10)}`);
    await this.store.save(program);

    program.baselineSource = discovery.programSource.source;
    program.dependencies = discovery.dependencies;
    moveTo(program, "DISCOVERED", "DiscoveryAgent", "dependency-graph-built", `${discovery.dependencies.length} dependent objects`);
    await this.store.save(program);

    const objectNames = [program.name, ...program.dependencies.map((d) => d.name)];
    const closureObjects = resolveClosureObjects(program.dependencies, discovery.dependencySources);
    program.findings = await runCleanCoreAnalysis(objectNames, program.name, discovery.programSource, this.sap, closureObjects);
    program.worstExtensibilityLevel = worstExtensibilityLevel(program.findings);
    program.riskScore = computeRiskScore(program.findings, program.criticality, program.dependencies.length);
    moveTo(program, "ANALYZED", "CleanCoreAnalysisAgent", "atc-run-complete", `${program.findings.length} findings, risk ${program.riskScore.total} (${program.riskScore.band})`);
    await this.store.save(program);

    moveTo(program, "BASELINING_TESTS", "BaselineTestAgent", "baseline-test-run-start");
    program.baselineTests = await runBaselineTests(program.name, this.sap);
    moveTo(program, "AWAITING_HUMAN_REVIEW_1", "BaselineTestAgent", "baseline-captured", `${program.baselineTests.cases.length} test cases`);
    await this.store.save(program);

    return program;
  }

  /** Human Gate 1: developer approves scope (and confirms generated baseline tests) or parks the program. */
  async gate1Decision(
    programId: string,
    decision: "approve" | "reject" | "defer",
    approvedFindingIds: string[] | undefined,
    comment: string | undefined
  ): Promise<Program> {
    const program = await this.mustGet(programId);
    if (program.state !== "AWAITING_HUMAN_REVIEW_1") {
      throw new Error(`Program is in state ${program.state}, not awaiting Gate 1 review.`);
    }

    if (decision !== "approve") {
      for (const f of program.findings) f.status = "rejected";
      moveTo(program, "PARKED", "human:gate1", `gate1-${decision}`, comment);
      await this.store.save(program);
      return program;
    }

    // "rejected" (a human explicitly did not select this finding for
    // remediation scope) is a distinct outcome from "deferred" (a finding
    // WAS approved but proposeRemediation couldn't mechanically apply a fix
    // for it) — collapsing both into "deferred" made the Fix Review
    // screen's "no automated fix" summary claim findings were "approved"
    // when most of them had simply never been selected at all.
    const idsToApprove = approvedFindingIds && approvedFindingIds.length > 0 ? new Set(approvedFindingIds) : new Set(program.findings.map((f) => f.id));
    for (const f of program.findings) {
      f.status = idsToApprove.has(f.id) ? "approved" : "rejected";
    }
    if (program.baselineTests) {
      for (const t of program.baselineTests.cases) t.humanConfirmed = true;
    }
    moveTo(program, "REMEDIATING", "human:gate1", "gate1-approve", comment ?? `${idsToApprove.size} finding(s) approved for remediation`);
    await this.store.save(program);

    return this.proposeRemediation(program);
  }

  /**
   * Phase 6: apply fixes for approved findings, commit a fix branch/PR, and
   * stop — no write against the real system happens here. `sourceOverride`
   * carries a previous attempt's (possibly human-edited) source into a
   * retry so it builds on top of prior fixes rather than starting over
   * from pristine source.
   */
  private async proposeRemediation(program: Program, sourceOverride?: string): Promise<Program> {
    const approved = program.findings.filter((f) => f.status === "approved");

    // Remediation only ever writes to the primary object's source (see
    // docs/design/multi-object-dependency-remediation.md §0/§3.7 — writing
    // to Includes/Classes is Phase 2, not yet built). A finding whose
    // containerObject is a different object (surfaced per Phase 1's
    // closure-findings visibility) is deferred here explicitly, rather
    // than relying on its violation text merely happening not to match
    // during the primary object's regex-based fix — an incidental
    // non-match isn't a real guarantee if the same table/FM name were ever
    // to also appear in the primary object's own source for an unrelated
    // reason.
    const crossObjectFindings = approved.filter((f) => f.containerObject !== program.name);
    for (const f of crossObjectFindings) {
      f.status = "deferred";
      audit(
        program,
        "RemediationAgent",
        "no-automated-fix",
        undefined,
        undefined,
        `${f.checkName} (${f.objectName}): found in ${f.containerObject}, not the primary object — multi-object writes aren't supported yet; needs manual remediation.`
      );
    }

    // Verify any suggested replacement object actually exists BEFORE ever
    // proposing a fix that references it — not just at write time. A
    // finding whose replacement can't be confirmed is deferred rather than
    // silently applied on a guess.
    const verifiedFindings: Finding[] = [];
    for (const f of approved.filter((f) => f.containerObject === program.name)) {
      if (f.suggestedFix.replacementObject) {
        const exists = await this.sap.objectExists(f.suggestedFix.replacementObject).catch(() => false);
        if (!exists) {
          f.status = "deferred";
          audit(
            program,
            "RemediationAgent",
            "replacement-object-not-found",
            undefined,
            undefined,
            `${f.suggestedFix.replacementObject} does not exist or could not be confirmed — finding deferred, not auto-fixed`
          );
          continue;
        }
      }
      verifiedFindings.push(f);
    }

    const baseSource = sourceOverride ?? (await this.sap.readObjectSource(program.name)).source;
    const remediation = runRemediation(baseSource, verifiedFindings);

    for (const id of remediation.appliedFindingIds) {
      const f = program.findings.find((x) => x.id === id);
      if (f) f.status = "fixed";
    }
    // A finding can be approved yet still have no mechanical fix behind it —
    // e.g. an ai_generated suggestion with no known replacementObject (no
    // CDS/BAPI mapping was identified), or an origin of "none" (manual-only,
    // like SELECT-inside-LOOP). Leaving these as "approved" looked, in the
    // UI, like the fix had been handled even though the proposed source is
    // byte-identical for that finding — flag it as "deferred" with a reason
    // instead of silently doing nothing.
    for (const id of remediation.skippedFindingIds) {
      const f = program.findings.find((x) => x.id === id);
      if (!f) continue;
      f.status = "deferred";
      audit(
        program,
        "RemediationAgent",
        "no-automated-fix",
        undefined,
        undefined,
        `${f.checkName} (${f.objectName}): no automated fix available for this finding — needs manual remediation.`
      );
    }
    program.remediationAttempts += 1;
    program.proposedSource = remediation.newSource;

    if (!program.gitBaseline) throw new Error("Program has no git baseline to commit remediation against.");
    program.gitBaseline = commitRemediation(
      program.name,
      program.gitBaseline,
      remediation.newSource,
      remediation.changeLog.join("; ") || "no automated changes applied"
    );
    moveTo(program, "AWAITING_FIX_REVIEW", "RemediationAgent", "fix-proposed", `PR ${program.gitBaseline.prUrl}`);
    await this.store.save(program);
    return program;
  }

  /**
   * Human fix-review gate: the developer sees the proposed fix (editable)
   * alongside the original source before anything is written to the real
   * system. Approving is the only path that triggers the real write
   * (syntaxCheckAndActivate, inside runValidation) — reject parks the
   * program, request_changes regenerates a fresh proposal for review again.
   */
  async fixReviewDecision(
    programId: string,
    decision: "approve" | "request_changes" | "reject",
    editedSource: string | undefined,
    comment: string | undefined
  ): Promise<Program> {
    const program = await this.mustGet(programId);
    if (program.state !== "AWAITING_FIX_REVIEW") {
      throw new Error(`Program is in state ${program.state}, not awaiting fix review.`);
    }

    if (decision === "reject") {
      for (const f of program.findings.filter((x) => x.status === "fixed")) f.status = "approved";
      moveTo(program, "PARKED", "human:fix-review", "fix-review-reject", comment);
      await this.store.save(program);
      return program;
    }

    if (decision === "request_changes") {
      for (const f of program.findings.filter((x) => x.status === "fixed")) f.status = "approved";
      moveTo(program, "REMEDIATING", "human:fix-review", "fix-review-request-changes", comment);
      await this.store.save(program);
      return this.proposeRemediation(program);
    }

    // approve — this is the only path that writes to the real system.
    const finalSource = editedSource ?? program.proposedSource;
    if (!finalSource) throw new Error("No proposed source available to approve.");
    if (editedSource && editedSource !== program.proposedSource) {
      program.proposedSource = editedSource;
      if (!program.gitBaseline) throw new Error("Missing git baseline.");
      program.gitBaseline = commitRemediation(program.name, program.gitBaseline, editedSource, "human-edited fix before write approval");
    }
    moveTo(program, "VALIDATING", "human:fix-review", "fix-review-approve-write", comment);
    await this.store.save(program);
    return this.validateAndFinish(program, finalSource);
  }

  /** Phase 7: the real write (via runValidation -> syntaxCheckAndActivate) plus the rest of the validation checklist. */
  private async validateAndFinish(program: Program, finalSource: string): Promise<Program> {
    const objectNames = [program.name, ...program.dependencies.map((d) => d.name)];
    const fixedFindings = program.findings.filter((f) => f.status === "fixed");
    try {
      program.validationReport = await runValidation(
        program.name,
        objectNames,
        finalSource,
        fixedFindings,
        program.findings,
        program.baselineTests ?? { runAt: new Date().toISOString(), cases: [] },
        this.sap
      );
    } catch (err) {
      // A failure here (e.g. an unimplemented write-path method in real
      // mode) must not leave the program stuck in VALIDATING with no way
      // to retry — escalate immediately with the real cause on record,
      // rather than letting the exception bubble out of an already-
      // persisted state transition.
      moveTo(program, "ESCALATED", "ValidationAgent", "validation-error", err instanceof Error ? err.message : String(err));
      await this.store.save(program);
      return program;
    }

    if (program.validationReport.overallPass) {
      for (const f of fixedFindings) f.status = "validated";
      moveTo(program, "AWAITING_HUMAN_REVIEW_2", "ValidationAgent", "validation-passed");
      await this.store.save(program);
      return program;
    }

    if (program.remediationAttempts >= MAX_REMEDIATION_ATTEMPTS) {
      moveTo(program, "ESCALATED", "ValidationAgent", "validation-failed-escalated", program.validationReport.messages.join("; "));
      await this.store.save(program);
      return program;
    }

    moveTo(program, "REMEDIATING", "ValidationAgent", "validation-failed-retry", program.validationReport.messages.join("; "));
    await this.store.save(program);
    return this.proposeRemediation(program, finalSource);
  }

  /** Human Gate 2: standard PR review — approve/merge, or request changes. */
  async gate2Decision(
    programId: string,
    decision: "approve" | "request_changes",
    comment: string | undefined,
    transportNumber?: string
  ): Promise<Program> {
    const program = await this.mustGet(programId);
    if (program.state !== "AWAITING_HUMAN_REVIEW_2") {
      throw new Error(`Program is in state ${program.state}, not awaiting Gate 2 review.`);
    }

    if (decision === "request_changes") {
      if (!program.gitBaseline) throw new Error("Missing git baseline.");
      program.gitBaseline.prState = "changes_requested";
      for (const f of program.findings.filter((x) => x.status === "validated")) f.status = "approved";
      moveTo(program, "REMEDIATING", "human:gate2", "gate2-request-changes", comment);
      await this.store.save(program);
      return this.proposeRemediation(program);
    }

    // A merged PR is only "ready for transport" (§6 of the design doc) once
    // a real transport request is actually named — TRANSPORT_RELEASED was
    // previously just a state label with no number ever captured.
    if (!transportNumber || !transportNumber.trim()) {
      throw new Error("A transport request number is required to approve Gate 2.");
    }
    program.transportNumber = transportNumber.trim();

    if (program.gitBaseline) program.gitBaseline.prState = "merged";
    moveTo(program, "TRANSPORT_RELEASED", "human:gate2", "gate2-approve-merge", `TR ${program.transportNumber}${comment ? ` — ${comment}` : ""}`);
    moveTo(program, "DOCUMENTED", "ReportingAgent", "report-generated");
    program.report = generateReport(program);
    moveTo(program, "DONE", "system", "workflow-complete");
    await this.store.save(program);
    return program;
  }

  async diff(programId: string): Promise<string> {
    const program = await this.mustGet(programId);
    if (!program.gitBaseline) return "";
    return diffAgainstBaseline(program.name, program.gitBaseline);
  }

  private async mustGet(programId: string): Promise<Program> {
    const program = await this.store.get(programId);
    if (!program) throw new Error(`Program ${programId} not found`);
    return program;
  }
}
