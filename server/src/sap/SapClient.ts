import { AtcPriority, DependencyObject, ExtensibilityLevel, FixOrigin } from "../domain/types";

export interface AtcRawFinding {
  atcCheckId: string;
  checkName: string;
  message: string;
  objectName: string;
  /**
   * Best-effort, per-finding real container (which repository object this
   * finding is actually physically located in — e.g. a specific Include —
   * derived from the finding's own ATC location, not from which object URI
   * happened to be queried to obtain it). Only ever set by RealAdtClient's
   * worklist parser; undefined for the static rule engine and MockSapClient,
   * whose callers already know the correct container from their own calling
   * context. See atcFindingClassifier.ts's extractContainerFromLocation.
   */
  foundInObject?: string;
  /** 1-based source line the finding's own ATC location points at, when parseable — see atcFindingClassifier.ts's extractLineFromLocation. */
  line?: number;
  priority: AtcPriority;
  extensibilityLevel: ExtensibilityLevel;
  fixOrigin: FixOrigin;
  fixDescription: string;
  replacementObject?: string;
  fixConfidence: "high" | "medium" | "low";
}

/** Sentinel checkId RealAdtClient.runAtcCheck prepends when it fell back to the static rule engine — see usedRealAtc. */
export const SYSTEM_ATC_FALLBACK_CHECK_ID = "SYSTEM_ATC_FALLBACK";

/** True if `findings` came from a real ATC run, not the static-engine fallback (RealAdtClient.runAtcCheck). */
export function usedRealAtc(findings: AtcRawFinding[]): boolean {
  return !findings.some((f) => f.atcCheckId === SYSTEM_ATC_FALLBACK_CHECK_ID);
}

export interface ObjectSource {
  name: string;
  type: string;
  source: string;
}

export interface UnitTestCaseResult {
  name: string;
  pass: boolean;
}

/**
 * Abstraction over everything this app needs from the SAP landscape:
 * ADT REST (source read/write, syntax check, activation, ABAP Unit) and the
 * central ATC check system. Exactly one implementation should be active per
 * deployment, selected via SAP_INTEGRATION_MODE.
 *
 * MockSapClient: deterministic fake data, used for local dev/tests/demo and
 * as the CF deployment default until real connectivity is wired up.
 *
 * RealAdtClient: the extension point for the SHD200SYSTEM BTP destination
 * (OAuth) once the exact grant type and comm scenario are confirmed —
 * see docs/design/clean-core-migration-design.md §3a/§6.5/§9.
 */
export interface SapClient {
  /**
   * `objectType` is optional and additive — omitting it (as every existing
   * call site for the primary object does) preserves the original
   * behavior exactly (reads a Program). It's used by discovery to fetch
   * real source for INCLUDE/CLASS dependencies via their own ADT
   * endpoints, distinct from a program's — see RealAdtClient.
   */
  readObjectSource(programName: string, objectType?: string): Promise<ObjectSource>;
  /**
   * `objectType` is optional and additive — omitting it preserves the
   * original behavior (a Program's own dependencies). Needed so a primary
   * object that's itself a Class/Interface/CDS view (not just a Program)
   * re-reads its OWN source via the correct ADT collection when deriving
   * its dependency list, instead of always assuming the programs/programs
   * endpoint.
   */
  getDependencies(programName: string, objectType?: string): Promise<DependencyObject[]>;
  /**
   * `currentSource` is the program's current source text. Real ATC inspects
   * whatever is actually active in the system, so a real implementation can
   * ignore this parameter — it exists so MockSapClient can behave like a
   * real check system and actually clear a finding once the underlying
   * pattern is no longer present, instead of returning static random data
   * regardless of what Remediation changed.
   */
  /**
   * `objectType` is optional and additive, same convention as
   * readObjectSource's — omitting it preserves existing call-site behavior.
   * RealAdtClient needs it to build the correct ADT collection (programs,
   * includes, classes, interfaces, CDS views) for a real ATC run against
   * `objectNames[0]`.
   */
  /**
   * `checkVariant` lets a caller pick which central ATC check variant to run
   * (e.g. the clean-core variant vs. a generic static-check-only one) —
   * omitting it preserves each implementation's own default
   * (SAP_ATC_CHECK_VARIANT env var / ZNUS_SCI_CC_CENTRAL for RealAdtClient).
   */
  runAtcCheck(
    objectNames: string[],
    currentSource: string,
    objectType?: "PROG" | "INCL" | "CLAS" | "INTF" | "DDLS",
    checkVariant?: string
  ): Promise<AtcRawFinding[]>;
  runAbapUnit(programName: string): Promise<UnitTestCaseResult[]>;
  /**
   * Best-effort lookup of the ABAP package (TADIR devclass) an existing
   * object already lives in, via its ADT object metadata (packageRef) —
   * lets intake leave Package blank for an object that already exists in
   * SAP instead of requiring it to be retyped by hand. Returns undefined
   * if the object doesn't exist yet or the lookup fails for any reason;
   * callers must not treat that as fatal.
   */
  getObjectPackage(objectName: string, objectType?: string): Promise<string | undefined>;
  /**
   * `objectType` is optional and additive — omitting it preserves the
   * original behavior (writes/activates via the Program collection).
   * RealAdtClient needs it to build the correct ADT collection for
   * non-Program primary objects (Class/Interface/CDS view).
   */
  syntaxCheckAndActivate(
    objectName: string,
    source: string,
    objectType?: string
  ): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }>;
  objectExists(objectName: string): Promise<boolean>;
}
