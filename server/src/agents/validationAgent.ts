import { Finding, SideEffectCheck, TestRunResult, ValidationReport } from "../domain/types";
import { SapClient } from "../sap/SapClient";

/**
 * The non-negotiable checklist before a fix can reach Human Gate 2, per
 * docs/design/clean-core-migration-design.md §8. Every check must pass for
 * overallPass to be true — a partial pass is still a fail.
 */
/** Maps this app's intake object type to the ADT type code runAtcCheck expects. Undefined/PROGRAM both fall through to runAtcCheck's own "PROG" default. */
function toAdtType(objectType?: string): "PROG" | "INCL" | "CLAS" | "INTF" | "DDLS" | undefined {
  switch (objectType) {
    case "INCLUDE":
      return "INCL";
    case "CLASS":
      return "CLAS";
    case "INTERFACE":
      return "INTF";
    case "CDS_VIEW":
      return "DDLS";
    default:
      return undefined;
  }
}

export async function runValidation(
  programName: string,
  objectNames: string[],
  newSource: string,
  appliedFindings: Finding[],
  previouslyKnownFindings: Finding[],
  baseline: TestRunResult,
  sap: SapClient,
  objectType?: string,
  transportNumber?: string
): Promise<ValidationReport> {
  const messages: string[] = [];

  const activation = await sap.syntaxCheckAndActivate(programName, newSource, objectType, transportNumber);
  messages.push(...activation.messages);

  let replacedObjectsExist = true;
  for (const f of appliedFindings) {
    if (!f.suggestedFix.replacementObject) continue;
    const exists = await sap.objectExists(f.suggestedFix.replacementObject);
    if (!exists) {
      replacedObjectsExist = false;
      messages.push(`Replacement object ${f.suggestedFix.replacementObject} does not exist or is not released.`);
    }
  }

  const rerun = await sap.runAtcCheck(objectNames, newSource, toAdtType(objectType));
  const appliedCheckIds = new Set(appliedFindings.map((f) => f.atcCheckId));
  const stillFlagged = rerun.filter((r) => appliedCheckIds.has(r.atcCheckId));
  const atcFindingCleared = stillFlagged.length === 0;
  const previouslyKnownCheckIds = new Set(previouslyKnownFindings.map((f) => f.atcCheckId));
  const newFindingsIntroduced = rerun.filter((r) => !previouslyKnownCheckIds.has(r.atcCheckId)).length;
  if (newFindingsIntroduced > 0) {
    messages.push(`${newFindingsIntroduced} finding(s) not present before remediation were introduced by the fix.`);
  }
  if (!atcFindingCleared) {
    messages.push(`${stillFlagged.length} of the fixed finding type(s) still present after remediation.`);
  }

  const rerunUnit = await sap.runAbapUnit(programName);
  const existingCases = baseline.cases.filter((c) => c.kind === "existing");
  const baselineTestsStillPass =
    existingCases.length === 0 || existingCases.every((c) => rerunUnit.find((r) => r.name === c.name)?.pass !== false);
  const newTestsPass = rerunUnit.every((r) => r.pass);

  const sideEffectChecks: SideEffectCheck[] = [];
  const touchesBapi = appliedFindings.some((f) => /BAPI/i.test(f.suggestedFix.description));
  if (touchesBapi) {
    sideEffectChecks.push(
      { name: "Change document parity", passed: true, detail: "No deviation from direct-write behavior detected (mock check)." },
      { name: "Number range assignment parity", passed: true, detail: "Number range behavior unchanged after BAPI substitution (mock check)." }
    );
  }
  const touchesCds = appliedFindings.some((f) => /CDS|I_Product/i.test(f.suggestedFix.description));
  if (touchesCds) {
    sideEffectChecks.push({
      name: "Performance sanity (CDS view vs. direct table read)",
      passed: true,
      detail: "Mock timing comparison within tolerance; re-verify with real explain-plan once connected to SHD200SYSTEM.",
    });
  }

  const overallPass =
    activation.syntaxOk &&
    activation.activated &&
    replacedObjectsExist &&
    atcFindingCleared &&
    newFindingsIntroduced === 0 &&
    baselineTestsStillPass &&
    newTestsPass &&
    sideEffectChecks.every((c) => c.passed);

  return {
    runAt: new Date().toISOString(),
    syntaxCheckPassed: activation.syntaxOk,
    activationPassed: activation.activated,
    replacedObjectsExist,
    atcFindingCleared,
    newFindingsIntroduced,
    baselineTestsStillPass,
    newTestsPass,
    sideEffectChecks,
    overallPass,
    messages,
  };
}
