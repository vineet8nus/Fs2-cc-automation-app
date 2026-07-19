import { AtcPriority, DependencyObject, DependencyObjectType, ExtensibilityLevel } from "../domain/types";
import { AtcRawFinding } from "./SapClient";

/**
 * Real-mode stand-in for the central ATC clean-core check variant (design
 * doc §1: "ATC first, custom rules as a gap-filler"). The real ATC REST
 * surface (`/atc/runs`-style endpoints, worklist XML) isn't wired up yet —
 * until it is, this static rule engine runs directly against real source
 * text pulled via RealAdtClient.readObjectSource, so real programs get real
 * (if narrower) findings instead of either mock data or nothing.
 *
 * The specific checks mirror the DB001-004 / PF001 style guard tests found
 * embedded in ZTEST_VK2's own ABAP Unit test class on SHD200SYSTEM: direct
 * access to SAP standard tables, obsolete statements, JOINs on obsolete
 * pool/cluster tables, and the SELECT-in-LOOP performance antipattern.
 *
 * All rules run against comment-stripped source (see stripComments) — a
 * live run against ZTEST_VK2 caught this the hard way: its own test class
 * *describes*, in comments, exactly the antipatterns it guards against
 * ("...instead of SELECT * FROM mara", "not inside a LOOP over materials"),
 * and an earlier version of this engine flagged those comments as if they
 * were executable code. Comment stripping is a line-based heuristic (`*`
 * at line start, or `"` to end of line) — it doesn't parse ABAP string
 * literals, so a `"` inside a backtick-delimited string would be
 * mis-treated as a comment start. Rare enough in practice to accept as a
 * known limitation rather than a full ABAP lexer.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*\*/.test(line)) return "";
      const quoteIdx = line.indexOf('"');
      return quoteIdx >= 0 ? line.slice(0, quoteIdx) : line;
    })
    .join("\n");
}

// Known released CDS successors for common standard tables — used to offer
// a native_quick_fix suggestion instead of a lower-confidence AI fix when a
// direct, well-known mapping exists.
const RELEASED_CDS_SUCCESSOR: Record<string, string> = {
  MARA: "I_Product",
  MAKT: "I_ProductDescription",
  VBAK: "I_SalesOrder",
  VBRK: "I_BillingDocument",
  KNA1: "I_Customer",
  LFA1: "I_Supplier",
  EKKO: "I_PurchaseOrder",
  EKPO: "I_PurchaseOrderItem",
  BSEG: "I_OperationalAcctgDocItem",
  FAGLFLEXA: "I_GLAccountLineItem",
};

function isLikelyStandardTable(name: string): boolean {
  return !/^[YZ]/i.test(name) && /^[A-Z][A-Z0-9_]{2,}$/i.test(name);
}

interface Rule {
  atcCheckId: string;
  checkName: string;
  extensibilityLevel: ExtensibilityLevel;
  test: (source: string) => { objectName: string; detail?: string }[];
  fixFor: (objectName: string) => { origin: AtcRawFinding["fixOrigin"]; description: string; replacementObject?: string; confidence: AtcRawFinding["fixConfidence"] };
}

const RULES: Rule[] = [
  {
    atcCheckId: "STATIC_USAGE_API_SELECT_STAR",
    checkName: "Usage of APIs (direct table read)",
    extensibilityLevel: "C",
    test: (source) =>
      [...source.matchAll(/SELECT\s+\*?\s*(?:FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((m) => m[1])
        .filter(isLikelyStandardTable)
        .map((name) => ({ objectName: name })),
    fixFor: (name) => {
      const successor = RELEASED_CDS_SUCCESSOR[name.toUpperCase()];
      return successor
        ? { origin: "native_quick_fix", description: `Replace direct SELECT on ${name} with released CDS view ${successor}.`, replacementObject: successor, confidence: "high" }
        : { origin: "ai_generated", description: `Identify and use a released CDS view/API in place of direct access to ${name}.`, confidence: "low" };
    },
  },
  {
    atcCheckId: "STATIC_USAGE_API_WRITE_STD_TABLE",
    checkName: "Usage of APIs (direct table write)",
    extensibilityLevel: "D",
    test: (source) =>
      [...source.matchAll(/\b(?:UPDATE|MODIFY|DELETE|INSERT)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((m) => m[1])
        .filter((n) => isLikelyStandardTable(n) && n.toUpperCase() !== "TABLE")
        .map((name) => ({ objectName: name })),
    fixFor: (name) => ({
      origin: "ai_generated",
      description: `Replace the direct write to ${name} with a released BAPI or RAP business action.`,
      confidence: "medium",
    }),
  },
  {
    atcCheckId: "STATIC_DB002_FAGLFLEXA",
    checkName: "Obsolete FI-GL pool table (FAGLFLEXA)",
    extensibilityLevel: "D",
    // Requires actual SQL-context usage (FROM/JOIN), not just the word
    // appearing anywhere — a bare word match also fires inside string
    // literals like assertion messages ('...not FAGLFLEXA'), which is text
    // *about* the table, not a real reference to it.
    test: (source) => (/\b(?:FROM|JOIN)\s+FAGLFLEXA\b/i.test(source) ? [{ objectName: "FAGLFLEXA" }] : []),
    fixFor: () => ({
      origin: "native_quick_fix",
      description: "Replace FAGLFLEXA access with released CDS view I_GLAccountLineItem (or ACDOCA).",
      replacementObject: "I_GLAccountLineItem",
      confidence: "high",
    }),
  },
  {
    atcCheckId: "STATIC_DB003_BSEG_JOIN",
    checkName: "JOIN on obsolete cluster table (BSEG)",
    extensibilityLevel: "D",
    test: (source) => (/\b(?:FROM|JOIN)\s+BSEG\b/i.test(source) ? [{ objectName: "BSEG" }] : []),
    fixFor: () => ({
      origin: "native_quick_fix",
      description: "Replace BSEG access with released CDS view I_OperationalAcctgDocItem / ACDOCA.",
      replacementObject: "I_OperationalAcctgDocItem",
      confidence: "high",
    }),
  },
  {
    atcCheckId: "STATIC_PF001_SELECT_IN_LOOP",
    checkName: "SELECT inside LOOP (N+1 performance antipattern)",
    extensibilityLevel: "B",
    test: (source) => {
      // Requires "LOOP AT" specifically, not a bare "LOOP" — belt-and-braces
      // on top of comment stripping, since prose can still say things like
      // "the loop at the end of..." without meaning an ABAP LOOP statement.
      const loopBlocks = [...source.matchAll(/\bLOOP\s+AT\b[\s\S]*?\bENDLOOP\b/gi)];
      const hits = loopBlocks.filter((block) => /\bSELECT\b/i.test(block[0]));
      return hits.length > 0 ? [{ objectName: "(loop body)", detail: `${hits.length} loop(s) contain a SELECT` }] : [];
    },
    fixFor: () => ({
      origin: "none",
      description: "Move the SELECT outside the LOOP and fetch data set-based (e.g. FOR ALL ENTRIES with an emptiness guard) — needs manual review of the loop logic.",
      confidence: "low",
    }),
  },
  {
    atcCheckId: "STATIC_DB004_FAE_NO_GUARD",
    checkName: "FOR ALL ENTRIES without emptiness guard",
    extensibilityLevel: "B",
    test: (source) => (/FOR ALL ENTRIES IN/i.test(source) && !/IS NOT INITIAL/i.test(source) ? [{ objectName: "(FOR ALL ENTRIES)" }] : []),
    fixFor: () => ({
      origin: "none",
      description: "Add an IS NOT INITIAL guard on the driver table before the FOR ALL ENTRIES SELECT to avoid selecting the full table when empty.",
      confidence: "low",
    }),
  },
  {
    atcCheckId: "STATIC_OBSOLETE_STMT_REFRESH",
    checkName: "Obsolete statement (REFRESH)",
    extensibilityLevel: "B",
    test: (source) => [...source.matchAll(/\bREFRESH\s+([A-Za-z_][A-Za-z0-9_]*)\s*\./gi)].map((m) => ({ objectName: m[1] })),
    fixFor: (name) => ({
      origin: "native_quick_fix",
      description: `Quick fix: replace REFRESH ${name} with CLEAR ${name}.`,
      confidence: "high",
    }),
  },
];

export function runStaticAtcRules(rawSource: string): AtcRawFinding[] {
  const source = stripComments(rawSource);
  const findings: AtcRawFinding[] = [];
  for (const rule of RULES) {
    const priority: AtcPriority = rule.extensibilityLevel === "D" ? 1 : rule.extensibilityLevel === "C" ? 2 : 3;
    for (const hit of rule.test(source)) {
      const fix = rule.fixFor(hit.objectName);
      findings.push({
        atcCheckId: rule.atcCheckId,
        checkName: rule.checkName,
        message: hit.detail ? `${rule.checkName}: ${hit.detail}` : `${rule.checkName}: ${hit.objectName}`,
        objectName: hit.objectName,
        priority,
        extensibilityLevel: rule.extensibilityLevel,
        fixOrigin: fix.origin,
        fixDescription: fix.description,
        replacementObject: fix.replacementObject,
        fixConfidence: fix.confidence,
      });
    }
  }
  return findings;
}

/**
 * Lightweight, real (not fabricated) dependency extraction: scans the
 * source text for FROM/CALL FUNCTION/TYPE REF TO/static-call references,
 * excluding classes defined locally in the same source. This is a
 * static-text heuristic, not a full ADT repository-information-system
 * where-used call — good enough to drive the clean-core check and Git
 * baseline, not a substitute for a real dependency graph.
 */
export function extractDependencies(rawSource: string): DependencyObject[] {
  const source = stripComments(rawSource);
  const localClasses = new Set(
    [...source.matchAll(/\bCLASS\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:DEFINITION|IMPLEMENTATION)/gi)].map((m) => m[1].toUpperCase())
  );

  const found = new Map<string, DependencyObjectType>();

  for (const m of source.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    const name = m[1];
    if (name.toUpperCase() === "TABLE") continue;
    found.set(name.toUpperCase(), /^[IC]_/i.test(name) ? "CDS_VIEW" : "TABLE");
  }
  for (const m of source.matchAll(/CALL FUNCTION\s+'([A-Za-z0-9_]+)'/gi)) {
    found.set(m[1].toUpperCase(), "FUNCTION_MODULE");
  }
  for (const m of source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=>/g)) {
    const name = m[1].toUpperCase();
    if (!localClasses.has(name)) found.set(name, "CLASS");
  }
  for (const m of source.matchAll(/TYPE REF TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    const name = m[1].toUpperCase();
    if (!localClasses.has(name)) found.set(name, name.startsWith("IF_") || name.startsWith("ZIF_") ? "INTERFACE" : "CLASS");
  }

  return Array.from(found.entries()).map(([name, type]) => ({ name, type }));
}
