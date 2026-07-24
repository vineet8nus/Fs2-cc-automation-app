import { v4 as uuidv4 } from "uuid";
import { Finding } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, usedRealAtc } from "../sap/SapClient";

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

/**
 * Prefers the finding's own real, per-finding location-derived container
 * (`foundInObject` — see atcFindingClassifier.ts's extractContainerFromLocation)
 * over the calling context's fallback name. Only ATC-sourced real findings
 * ever carry `foundInObject`; the static engine and custom rules have no
 * location data and always fall through to `fallback` unchanged (their
 * existing, already-correct single-object-scoped behavior).
 */
function pickContainer(raw: AtcRawFinding, fallback: string): string {
  return raw.foundInObject ?? fallback;
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
 *
 * INCLUDE-type closure members are deliberately NOT re-queried against real
 * ATC here when the primary object's own run already succeeded — confirmed
 * live against a real multi-Include program that a classic Report and its
 * Includes are one compilation unit for ATC's purposes: separately scoping
 * a run to the report's own URI and to each of its 3 Includes' own URIs
 * returned the exact same finding set attributed to the report's identity
 * every time, never the queried Include's own name. Re-querying per Include
 * added zero coverage and was the direct cause of a real production bug
 * (the same findings duplicated once per Include, each copy mislabeled with
 * a different containerObject). CLASS-type members remain their own
 * independent real ATC call below — a class is its own compilation/
 * activation unit, unlike an Include, so it does need its own run.
 *
 * If the primary run itself fell back to the static engine (no real ATC
 * available — e.g. outside business hours, see RealAdtClient.runAtcCheck),
 * each Include still gets its own static-engine pass over its own source,
 * exactly as before: the fallback engine has no cross-file awareness at
 * all, so skipping it would silently lose Include-level static coverage
 * whenever real ATC happens to be down.
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
  const primaryUsedRealAtc = usedRealAtc(atcFindings);
  const customFindings = runCustomRules(programName, programSource.source);
  const findings = [
    ...atcFindings.map((f) => toFinding(f, pickContainer(f, programName))),
    ...customFindings.map((f) => toFinding(f, programName)),
  ];

  for (const obj of closureObjects) {
    const needsOwnAtcRun = obj.type === "CLASS" || !primaryUsedRealAtc;
    if (needsOwnAtcRun) {
      const objAdtType = obj.type === "CLASS" ? "CLAS" : "INCL";
      const objAtcFindings = await sap.runAtcCheck([obj.name], obj.source, objAdtType);
      findings.push(...objAtcFindings.map((f) => toFinding(f, pickContainer(f, obj.name))));
    }
    const objCustomFindings = runCustomRules(obj.name, obj.source);
    findings.push(...objCustomFindings.map((f) => toFinding(f, obj.name)));
  }

  return findings;
}
