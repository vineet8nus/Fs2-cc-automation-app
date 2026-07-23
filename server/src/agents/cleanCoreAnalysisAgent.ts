import { v4 as uuidv4 } from "uuid";
import { Finding } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient } from "../sap/SapClient";

/**
 * Gap-filler custom rules for things the central ATC clean-core variant
 * doesn't cover (per docs/design/clean-core-migration-design.md §1: "ATC
 * first, custom rules as a gap-filler, not a replacement"). Kept small and
 * additive — ATC remains the primary source of findings.
 */
function runCustomRules(programName: string, source: string): AtcRawFinding[] {
  const findings: AtcRawFinding[] = [];
  if (!/^[ZY]/i.test(programName)) {
    findings.push({
      atcCheckId: "CUSTOM_RULE_NAMING",
      checkName: "Custom naming convention",
      message: `Object ${programName} does not follow the Z*/Y* custom namespace convention.`,
      objectName: programName,
      priority: 4,
      extensibilityLevel: "B",
      fixOrigin: "none",
      fixDescription: "Governance flag only — no automated fix; rename requires a dedicated migration.",
      fixConfidence: "low",
    });
  }
  if (/SY-MANDT|CLIENT SPECIFIED/i.test(source)) {
    findings.push({
      atcCheckId: "CUSTOM_RULE_CLIENT_HANDLING",
      checkName: "Explicit client handling",
      message: "Explicit client handling (SY-MANDT / CLIENT SPECIFIED) found; review against multi-tenant clean core guidance.",
      objectName: programName,
      priority: 3,
      extensibilityLevel: "B",
      fixOrigin: "none",
      fixDescription: "Manual review recommended — no automated fix.",
      fixConfidence: "low",
    });
  }
  return findings;
}

function toFinding(raw: AtcRawFinding, containerObject: string): Finding {
  return {
    id: uuidv4(),
    atcCheckId: raw.atcCheckId,
    checkName: raw.checkName,
    message: raw.message,
    objectName: raw.objectName,
    containerObject,
    priority: raw.priority,
    extensibilityLevel: raw.extensibilityLevel,
    suggestedFix: {
      origin: raw.fixOrigin,
      description: raw.fixDescription,
      replacementObject: raw.replacementObject,
      confidence: raw.fixConfidence,
    },
    status: "open",
  };
}

/**
 * `closureObjects` are the primary object's own Includes/Classes whose real
 * source could be fetched (see discoveryAgent + RealAdtClient's
 * type-routed readObjectSource) — findings from them are attributed to the
 * actual container they occur in via `containerObject`, instead of being
 * invisible (per docs/design/multi-object-dependency-remediation.md §1/§3.2).
 * Defaults to empty so every existing call site behaves exactly as before.
 * Remediation still only ever fixes the primary object's source — a
 * finding whose containerObject differs from `programName` is always
 * deferred with an explanation (orchestrator.ts), never silently attempted.
 */
export async function runCleanCoreAnalysis(
  objectNames: string[],
  programName: string,
  programSource: ObjectSource,
  sap: SapClient,
  closureObjects: { name: string; source: string; type: "INCLUDE" | "CLASS" }[] = []
): Promise<Finding[]> {
  const primaryAdtType = programSource.type === "CLAS" || programSource.type === "INCL" ? programSource.type : "PROG";
  const atcFindings = await sap.runAtcCheck(objectNames, programSource.source, primaryAdtType);
  const customFindings = runCustomRules(programName, programSource.source);
  const findings = [...atcFindings, ...customFindings].map((f) => toFinding(f, programName));

  for (const obj of closureObjects) {
    const objAdtType = obj.type === "CLASS" ? "CLAS" : "INCL";
    const objAtcFindings = await sap.runAtcCheck([obj.name], obj.source, objAdtType);
    const objCustomFindings = runCustomRules(obj.name, obj.source);
    findings.push(...[...objAtcFindings, ...objCustomFindings].map((f) => toFinding(f, obj.name)));
  }

  return findings;
}
