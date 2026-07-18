import { Program, TechSpecReport } from "../domain/types";

/**
 * Generates the tech spec + unit test report delivered back to the
 * developer, per docs/design/clean-core-migration-design.md agent roster.
 * Rendered as markdown so it can be attached to the PR and/or exported.
 */
export function generateReport(program: Program): TechSpecReport {
  const lines: string[] = [];
  lines.push(`# Clean Core Remediation — ${program.name}`);
  lines.push("");
  if ((process.env.SAP_INTEGRATION_MODE ?? "mock") !== "real") {
    lines.push(
      "> ⚠️ **SIMULATED DATA.** This run used `SAP_INTEGRATION_MODE=mock` — no connection was made to " +
        "SHD200SYSTEM or any SAP system. The source, findings, and fixes below are a fixed demonstration " +
        "template, not a real analysis of this program. Do not act on this report as if it reflects real code."
    );
    lines.push("");
  }
  lines.push(`**Package:** ${program.package}  `);
  lines.push(`**Business area:** ${program.businessArea}  `);
  lines.push(`**Criticality:** ${program.criticality}  `);
  lines.push(`**Owner:** ${program.owner}  `);
  lines.push(`**Worst extensibility level found:** ${program.worstExtensibilityLevel ?? "N/A"}  `);
  lines.push(`**Risk score:** ${program.riskScore?.total ?? "N/A"} (${program.riskScore?.band ?? "N/A"})  `);
  lines.push("");

  lines.push("## Findings & fixes");
  lines.push("");
  lines.push("| Finding | ATC check | Priority | Level | Status | Fix |");
  lines.push("|---|---|---|---|---|---|");
  for (const f of program.findings) {
    lines.push(
      `| ${f.message} | ${f.atcCheckId} | P${f.priority} | ${f.extensibilityLevel} | ${f.status} | ${f.suggestedFix.description} |`
    );
  }
  lines.push("");

  lines.push("## Baseline & regression tests");
  lines.push("");
  if (program.baselineTests) {
    lines.push("| Test | Kind | Status | Human-confirmed baseline |");
    lines.push("|---|---|---|---|");
    for (const t of program.baselineTests.cases) {
      lines.push(`| ${t.name} | ${t.kind} | ${t.status} | ${t.humanConfirmed ? "yes" : "no"} |`);
    }
  } else {
    lines.push("_No baseline tests captured._");
  }
  lines.push("");

  lines.push("## Validation report");
  lines.push("");
  if (program.validationReport) {
    const v = program.validationReport;
    lines.push(`- Syntax check: ${v.syntaxCheckPassed ? "PASS" : "FAIL"}`);
    lines.push(`- Activation: ${v.activationPassed ? "PASS" : "FAIL"}`);
    lines.push(`- Replaced objects exist & released: ${v.replacedObjectsExist ? "PASS" : "FAIL"}`);
    lines.push(`- ATC finding cleared, no regressions: ${v.atcFindingCleared ? "PASS" : "FAIL"}`);
    lines.push(`- Baseline tests still pass: ${v.baselineTestsStillPass ? "PASS" : "FAIL"}`);
    lines.push(`- New tests pass: ${v.newTestsPass ? "PASS" : "FAIL"}`);
    for (const s of v.sideEffectChecks) {
      lines.push(`- ${s.name}: ${s.passed ? "PASS" : "FAIL"} — ${s.detail}`);
    }
    lines.push("");
    lines.push(`**Overall: ${v.overallPass ? "PASS ✅" : "FAIL ❌"}**`);
  } else {
    lines.push("_Not yet validated._");
  }
  lines.push("");

  if (program.gitBaseline) {
    lines.push("## Change tracking");
    lines.push("");
    lines.push(`- Baseline branch: \`${program.gitBaseline.baselineBranch}\` (commit \`${program.gitBaseline.baselineCommit.slice(0, 10)}\`)`);
    if (program.gitBaseline.fixBranch) {
      lines.push(`- Fix branch: \`${program.gitBaseline.fixBranch}\``);
      lines.push(`- PR: ${program.gitBaseline.prUrl} (${program.gitBaseline.prState})`);
    }
    lines.push("");
  }

  lines.push("## Audit trail");
  lines.push("");
  for (const a of program.auditLog) {
    lines.push(`- \`${a.timestamp}\` **${a.actor}** — ${a.action}${a.fromState ? ` (${a.fromState} → ${a.toState})` : ""}${a.details ? `: ${a.details}` : ""}`);
  }

  return { generatedAt: new Date().toISOString(), markdown: lines.join("\n") };
}
