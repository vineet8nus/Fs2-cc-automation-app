import { AtcPriority, ExtensibilityLevel, FixOrigin } from "../domain/types";
import { AtcRawFinding } from "./SapClient";
import { RELEASED_CDS_SUCCESSOR } from "./staticCleanCoreRules";

/**
 * Real ATC gives us checkId/checkTitle/messageTitle/priority per finding —
 * none of our own extensibilityLevel/fixOrigin/fixDescription/
 * fixConfidence categorization, which is domain knowledge this app layers
 * on top (same as staticCleanCoreRules.ts's RULES table encodes for its own
 * synthetic checks). This is a best-effort text classifier over whatever
 * check/message text a real ATC variant produces, so it can cover checks
 * never seen before — not a lookup table of specific known checkIds, which
 * would silently do nothing for anything not already catalogued.
 */
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function classifyAtcFinding(
  checkTitle: string,
  message: string,
  priority: AtcPriority
): { extensibilityLevel: ExtensibilityLevel; fixOrigin: FixOrigin; fixDescription: string; replacementObject?: string; fixConfidence: "high" | "medium" | "low" } {
  const text = `${checkTitle} ${message}`;

  const knownTable = [...text.matchAll(/\b([A-Z][A-Z0-9]{2,9})\b/g)].map((m) => m[1]).find((w) => RELEASED_CDS_SUCCESSOR[w.toUpperCase()]);
  if (knownTable) {
    const successor = RELEASED_CDS_SUCCESSOR[knownTable.toUpperCase()];
    return {
      extensibilityLevel: "C",
      fixOrigin: "native_quick_fix",
      fixDescription: `Replace direct access to ${knownTable} with released CDS view ${successor}.`,
      replacementObject: successor,
      fixConfidence: "high",
    };
  }
  if (/naming convention/i.test(text)) {
    return {
      extensibilityLevel: "B",
      fixOrigin: "ai_generated",
      fixDescription: "Rename per Clean ABAP / Extended Naming Conventions.",
      fixConfidence: "low",
    };
  }
  if (/obsolete/i.test(text)) {
    return {
      extensibilityLevel: "D",
      fixOrigin: "ai_generated",
      fixDescription: "Replace the obsolete construct with its released/current equivalent.",
      fixConfidence: "medium",
    };
  }
  if (/usage of api|released api|direct.*table|database table/i.test(text)) {
    return {
      extensibilityLevel: "C",
      fixOrigin: "ai_generated",
      fixDescription: "Identify and use a released CDS view/API in place of this direct access.",
      fixConfidence: "low",
    };
  }

  // Fallback: derive extensibility from ATC's own priority rather than
  // guess at a fix — an honest "no automated classification" beats a
  // confident-looking wrong one.
  const extensibilityLevel: ExtensibilityLevel = priority === 1 ? "D" : priority === 2 ? "C" : priority === 3 ? "B" : "A";
  return {
    extensibilityLevel,
    fixOrigin: "none",
    fixDescription: "No automated fix classification available for this ATC check — manual review required.",
    fixConfidence: "low",
  };
}

/**
 * Parses an ATC worklist XML response (see RealAdtClient.triggerAtcRun) into
 * our AtcRawFinding shape, attributing each finding to the actual object
 * (adtcore:name) it was found on rather than assuming it's always the
 * queried object — a real ATC run against one object set can report
 * findings distributed across everything ATC considers in scope.
 */
export function parseAtcWorklistFindings(worklistXml: string): AtcRawFinding[] {
  const findings: AtcRawFinding[] = [];
  const objectBlocks = [...worklistXml.matchAll(/<atcobject:object\b([^>]*)>([\s\S]*?)<\/atcobject:object>/g)];
  for (const block of objectBlocks) {
    const objAttrs = block[1];
    const objBody = block[2];
    const objectName = decodeXmlEntities(objAttrs.match(/adtcore:name="([^"]*)"/)?.[1] ?? "UNKNOWN");

    const findingMatches = [...objBody.matchAll(/<atcfinding:finding\b([^>]*?)\/?>/g)];
    for (const fm of findingMatches) {
      const attrs = fm[1];
      const priority = (Number(attrs.match(/atcfinding:priority="(\d)"/)?.[1]) || 3) as AtcPriority;
      const checkId = attrs.match(/atcfinding:checkId="([^"]*)"/)?.[1] ?? "UNKNOWN";
      const checkTitle = decodeXmlEntities(attrs.match(/atcfinding:checkTitle="([^"]*)"/)?.[1] ?? "ATC finding");
      const messageTitle = decodeXmlEntities(attrs.match(/atcfinding:messageTitle="([^"]*)"/)?.[1] ?? checkTitle);
      const classified = classifyAtcFinding(checkTitle, messageTitle, priority);
      findings.push({
        atcCheckId: checkId,
        checkName: checkTitle,
        message: messageTitle,
        objectName,
        priority,
        extensibilityLevel: classified.extensibilityLevel,
        fixOrigin: classified.fixOrigin,
        fixDescription: classified.fixDescription,
        replacementObject: classified.replacementObject,
        fixConfidence: classified.fixConfidence,
      });
    }
  }
  return findings;
}
