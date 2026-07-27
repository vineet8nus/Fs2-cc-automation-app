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

// The ADT collection prefixes a finding's `atcfinding:location` URI can
// resolve through, mapped to how many path segments after the prefix name
// the object itself (vs. e.g. a class's own sub-include path, or the
// trailing /source/main). Confirmed empirically (see chat / ATC review
// findings against Z_TEST_GST_REP1) that a real ATC run's *block-level*
// adtcore:name is USELESS for per-Include attribution — every one of 4
// separate real ATC runs scoped to a report's own URI and each of its 3
// Includes' own URIs came back attributed to the *report's* name uniformly,
// never the queried object's own name. Classic Report+Includes are one
// compilation unit for ATC's purposes; it always reports against the
// owning report's identity regardless of which piece you scope the run to.
// This makes the finding's own `atcfinding:location` the only remaining
// candidate for genuine per-Include precision — unverified whether it
// actually varies usefully (no live ATC access to confirm at the time this
// was written; the ATC RFC destination is only up during business hours),
// so this is attempted defensively with a safe fallback, not relied upon.
const LOCATION_COLLECTION_PATTERNS: RegExp[] = [
  /\/programs\/includes\/([^/]+)\//,
  /\/programs\/programs\/([^/]+)\//,
  /\/oo\/classes\/([^/]+)\//,
  /\/oo\/interfaces\/([^/]+)\//,
];

/**
 * Extracts the real object a finding's location points into, from its
 * `atcfinding:location` URI — e.g.
 * ".../programs/includes/z_test_gst_rep1_c01/source/main#start=12,4"
 * -> "Z_TEST_GST_REP1_C01". Returns undefined (not a guess) if the URI is
 * absent or doesn't match any recognized ADT collection shape — callers
 * should fall back to their own calling-context container in that case,
 * NOT coerce to the primary object, since an unrecognized-but-present
 * location is still informative (a genuinely different, possibly
 * out-of-closure object) and must be preserved as-is so the existing
 * containerObject !== program.name deferral path (never auto-remediated)
 * handles it safely rather than risking a fix applied to the wrong object.
 */
export function extractContainerFromLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  for (const pattern of LOCATION_COLLECTION_PATTERNS) {
    const match = location.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return undefined;
}

/**
 * Extracts the 1-based source line a finding's `atcfinding:location`
 * points at (the `#start=<line>,<col>` fragment) — e.g.
 * ".../source/main#start=45,10" -> 45. Used to show an LLM-based
 * remediation pass the actual surrounding lines for a finding instead of
 * the whole object's source, since most real ATC messages ("Usage of not
 * released application API.") name no specific table/API at all — the
 * location is often the ONLY way to know where in the file a generic
 * finding actually is.
 */
export function extractLineFromLocation(location: string | undefined): number | undefined {
  if (!location) return undefined;
  const match = location.match(/#start=(\d+),\d+/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Parses an ATC worklist XML response (see RealAdtClient.triggerAtcRun) into
 * our AtcRawFinding shape. `objectName` keeps its existing (block-level,
 * confirmed-uniform-per-run) meaning; `foundInObject` is the best-effort,
 * per-finding location-derived container — see extractContainerFromLocation.
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
      const location = attrs.match(/atcfinding:location="([^"]*)"/)?.[1];
      const classified = classifyAtcFinding(checkTitle, messageTitle, priority);
      findings.push({
        atcCheckId: checkId,
        checkName: checkTitle,
        message: messageTitle,
        objectName,
        foundInObject: extractContainerFromLocation(location),
        line: extractLineFromLocation(location),
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
