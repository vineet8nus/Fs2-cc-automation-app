import { AtcPriority, DependencyObject, ExtensibilityLevel, FixOrigin } from "../domain/types";

export interface AtcRawFinding {
  atcCheckId: string;
  checkName: string;
  message: string;
  objectName: string;
  priority: AtcPriority;
  extensibilityLevel: ExtensibilityLevel;
  fixOrigin: FixOrigin;
  fixDescription: string;
  replacementObject?: string;
  fixConfidence: "high" | "medium" | "low";
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
  getDependencies(programName: string): Promise<DependencyObject[]>;
  /**
   * `currentSource` is the program's current source text. Real ATC inspects
   * whatever is actually active in the system, so a real implementation can
   * ignore this parameter — it exists so MockSapClient can behave like a
   * real check system and actually clear a finding once the underlying
   * pattern is no longer present, instead of returning static random data
   * regardless of what Remediation changed.
   */
  runAtcCheck(objectNames: string[], currentSource: string): Promise<AtcRawFinding[]>;
  runAbapUnit(programName: string): Promise<UnitTestCaseResult[]>;
  syntaxCheckAndActivate(
    objectName: string,
    source: string
  ): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }>;
  objectExists(objectName: string): Promise<boolean>;
}
