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

function toFinding(raw: AtcRawFinding): Finding {
  return {
    id: uuidv4(),
    atcCheckId: raw.atcCheckId,
    checkName: raw.checkName,
    message: raw.message,
    objectName: raw.objectName,
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

export async function runCleanCoreAnalysis(
  objectNames: string[],
  programName: string,
  programSource: ObjectSource,
  sap: SapClient
): Promise<Finding[]> {
  const atcFindings = await sap.runAtcCheck(objectNames, programSource.source);
  const customFindings = runCustomRules(programName, programSource.source);
  return [...atcFindings, ...customFindings].map(toFinding);
}
