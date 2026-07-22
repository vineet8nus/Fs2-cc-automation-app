import { DependencyObject, DependencyObjectType } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "./SapClient";

// Deterministic PRNG (mulberry32) seeded from the program name so mock runs
// are reproducible for the same object, but vary across programs.
function seededRandom(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Each rule's `matchPattern` is checked against the object's *current*
// source text, and each has a corresponding transform in remediationAgent.ts
// — so once a fix is applied and the pattern no longer matches, a re-run of
// runAtcCheck genuinely stops reporting it, exactly like a real ATC re-run
// would after the underlying code actually changed.
const CATALOG: Array<{
  atcCheckId: string;
  checkName: string;
  message: string;
  extensibilityLevel: "B" | "C" | "D";
  fixOrigin: "native_quick_fix" | "ai_generated" | "none";
  fixDescription: string;
  replacementObject?: string;
  fixConfidence: "high" | "medium" | "low";
  matchPattern: RegExp;
}> = [
  {
    atcCheckId: "CL_CI_TEST_USAGE_API",
    checkName: "Usage of APIs",
    message: "Direct SELECT on table MARA is not released for Clean Core; use a released successor.",
    extensibilityLevel: "C",
    fixOrigin: "native_quick_fix",
    fixDescription: "Replace direct SELECT on MARA with released CDS view I_Product.",
    replacementObject: "I_Product",
    fixConfidence: "high",
    matchPattern: /SELECT \* FROM mara\b/i,
  },
  {
    atcCheckId: "CL_CI_TEST_USAGE_API",
    checkName: "Usage of APIs",
    message: "UPDATE on database table VBAK is not allowed; SAP-internal object.",
    extensibilityLevel: "D",
    fixOrigin: "ai_generated",
    fixDescription: "Replace direct table UPDATE with released BAPI BAPI_SALESORDER_CHANGE.",
    replacementObject: "BAPI_SALESORDER_CHANGE",
    fixConfidence: "medium",
    matchPattern: /UPDATE vbak\b/i,
  },
  {
    atcCheckId: "CL_CI_TEST_OBSOLETE_STMT",
    checkName: "Obsolete statement",
    message: "Obsolete statement REFRESH used; replace with CLEAR/FREE per ABAP Cloud syntax.",
    extensibilityLevel: "B",
    fixOrigin: "native_quick_fix",
    fixDescription: "Quick fix: replace REFRESH itab with CLEAR itab.",
    fixConfidence: "high",
    matchPattern: /REFRESH lt_mara\./i,
  },
  {
    atcCheckId: "CL_CI_TEST_USAGE_API",
    checkName: "Usage of APIs",
    message: "Call to SAP-internal function module MATERIAL_READ is not released.",
    extensibilityLevel: "D",
    fixOrigin: "ai_generated",
    fixDescription: "Replace with released API method I_Product / BAPI_MATERIAL_GET_DETAIL.",
    replacementObject: "BAPI_MATERIAL_GET_DETAIL",
    fixConfidence: "medium",
    matchPattern: /CALL FUNCTION 'MATERIAL_READ'/i,
  },
  {
    atcCheckId: "CL_CI_TEST_ORDER_BY",
    checkName: "Missing ORDER BY",
    message: "SELECT without ORDER BY has an undefined result order on HANA.",
    extensibilityLevel: "B",
    fixOrigin: "none",
    fixDescription: "No automated fix available yet — requires manual review of the intended sort order.",
    fixConfidence: "low",
    matchPattern: /UP TO \d+ ROWS\.(?!\s*ORDER BY)/i,
  },
];

const DEP_TYPES: DependencyObjectType[] = ["INCLUDE", "CLASS", "FUNCTION_MODULE", "TABLE", "CDS_VIEW"];

export class MockSapClient implements SapClient {
  async readObjectSource(programName: string, _objectType?: string): Promise<ObjectSource> {
    return {
      name: programName,
      type: "PROG",
      source: [
        `REPORT ${programName.toLowerCase()}.`,
        "",
        "* mock source snapshot (SAP_INTEGRATION_MODE=mock)",
        "SELECT * FROM mara INTO TABLE @DATA(lt_mara) UP TO 100 ROWS.",
        "UPDATE vbak SET netwr = 0 WHERE vbeln = '0000000001'.",
        "CALL FUNCTION 'MATERIAL_READ'.",
        "REFRESH lt_mara.",
      ].join("\n"),
    };
  }

  async getDependencies(programName: string): Promise<DependencyObject[]> {
    const rnd = seededRandom(programName);
    const count = 3 + Math.floor(rnd() * 5);
    const deps: DependencyObject[] = [];
    for (let i = 0; i < count; i++) {
      const type = DEP_TYPES[Math.floor(rnd() * DEP_TYPES.length)];
      deps.push({
        name: `${type === "TABLE" ? "Z" : "ZCL_"}${programName.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}_${i}`,
        type,
        usedBy: programName,
      });
    }
    return deps;
  }

  async runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    const programName = objectNames[0] ?? "UNKNOWN";
    return CATALOG.filter((rule) => rule.matchPattern.test(currentSource)).map((rule) => {
      const priority = rule.extensibilityLevel === "D" ? 1 : rule.extensibilityLevel === "C" ? 2 : 3;
      const { matchPattern, ...rest } = rule;
      return { ...rest, priority: priority as AtcRawFinding["priority"], objectName: programName };
    });
  }

  async runAbapUnit(programName: string): Promise<UnitTestCaseResult[]> {
    const rnd = seededRandom(`unit-${programName}`);
    const names = ["test_happy_path", "test_boundary_qty", "test_error_handling"];
    return names.map((n) => ({ name: n, pass: rnd() > 0.05 }));
  }

  async syntaxCheckAndActivate(objectName: string, source: string) {
    const hasObviousError = /SYNTAX_ERROR_MARKER/.test(source);
    return {
      syntaxOk: !hasObviousError,
      activated: !hasObviousError,
      messages: hasObviousError
        ? [`Syntax error in ${objectName}: unexpected token`]
        : [`${objectName} activated successfully (mock)`],
    };
  }

  async objectExists(objectName: string): Promise<boolean> {
    // In mock mode, released replacement objects referenced by the fix
    // catalog above are treated as existing; anything else is deemed to
    // exist unless it looks deliberately invalid (used by tests).
    return !/DOES_NOT_EXIST/.test(objectName);
  }
}
