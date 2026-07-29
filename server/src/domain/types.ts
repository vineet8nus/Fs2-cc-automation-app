// Domain model for the clean core migration workflow.
// Mirrors docs/design/clean-core-migration-design.md §4-6.

export type WorkflowState =
  | "UPLOADED"
  | "GIT_BASELINED"
  | "DISCOVERED"
  | "ANALYZED"
  | "BASELINING_TESTS"
  | "AWAITING_HUMAN_REVIEW_1"
  | "PARKED"
  | "REMEDIATING"
  | "AWAITING_FIX_REVIEW"
  | "VALIDATING"
  | "ESCALATED"
  | "AWAITING_HUMAN_REVIEW_2"
  | "TRANSPORT_RELEASED"
  | "DOCUMENTED"
  | "DONE";

export type ExtensibilityLevel = "A" | "B" | "C" | "D";

export type AtcPriority = 1 | 2 | 3 | 4; // 1 = error, 2 = warning, 3 = info, 4 = note

export type Criticality = "H" | "M" | "L";

// The kind of repository object being migrated. Only PROGRAM is actually
// read/written against the live system today (RealAdtClient hard-codes the
// ADT "programs/programs" endpoint) — the others are accepted as intake
// metadata so the backlog is honest about what's coming, and are parked with
// an explanation rather than silently mis-processed as a program.
export type AbapObjectType = "PROGRAM" | "CLASS" | "FUNCTION_GROUP" | "INCLUDE" | "INTERFACE" | "CDS_VIEW";

export type DependencyObjectType =
  | "INCLUDE"
  | "CLASS"
  | "INTERFACE"
  | "FUNCTION_MODULE"
  | "FUNCTION_GROUP"
  | "TABLE"
  | "CDS_VIEW";

export interface DependencyObject {
  name: string;
  type: DependencyObjectType;
  usedBy?: string;
}

export type FixOrigin = "native_quick_fix" | "ai_generated" | "none";

export interface SuggestedFix {
  origin: FixOrigin;
  description: string;
  replacementObject?: string;
  confidence: "high" | "medium" | "low";
}

export interface Finding {
  id: string;
  atcCheckId: string;
  checkName: string;
  message: string;
  /** The violation's target — e.g. the table/FM being misused. Not the object the finding was found in; see containerObject. */
  objectName: string;
  /**
   * The repository object this finding actually occurs in — the primary
   * object being migrated, or (per the multi-object design,
   * docs/design/multi-object-dependency-remediation.md §3.2) one of its own
   * Includes/Classes. Remediation today only ever fixes the primary
   * object's source, so a finding whose containerObject differs from the
   * program being migrated is always deferred with an explanation rather
   * than silently attempted.
   */
  containerObject: string;
  /** 1-based source line within containerObject the finding points at, when ATC's own location data was parseable. Lets AI-based remediation see the actual surrounding code instead of guessing from a generic message alone. */
  line?: number;
  priority: AtcPriority;
  extensibilityLevel: ExtensibilityLevel;
  suggestedFix: SuggestedFix;
  status: "open" | "approved" | "rejected" | "deferred" | "fixed" | "validated";
}

export interface TestCase {
  id: string;
  name: string;
  kind: "existing" | "generated_characterization";
  status: "pass" | "fail" | "not_run";
  humanConfirmed: boolean;
}

export interface TestRunResult {
  runAt: string;
  cases: TestCase[];
}

export interface SideEffectCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  runAt: string;
  syntaxCheckPassed: boolean;
  activationPassed: boolean;
  replacedObjectsExist: boolean;
  atcFindingCleared: boolean;
  newFindingsIntroduced: number;
  baselineTestsStillPass: boolean;
  newTestsPass: boolean;
  sideEffectChecks: SideEffectCheck[];
  overallPass: boolean;
  messages: string[];
}

export interface GitBaseline {
  repo: string;
  baselineBranch: string;
  baselineCommit: string;
  fixBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "changes_requested";
}

export interface AuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  fromState?: WorkflowState;
  toState?: WorkflowState;
  details?: string;
}

export interface RiskScoreBreakdown {
  atcPriorityScore: number;
  extensibilityLevelScore: number;
  usageFrequencyScore: number;
  businessCriticalityScore: number;
  fixConfidencePenalty: number;
  dependencyFanOutScore: number;
  total: number;
  band: "Critical" | "High" | "Medium" | "Low";
}

export interface TechSpecReport {
  generatedAt: string;
  markdown: string;
}

/**
 * TSD/Unit Test doc generated from an uploaded NUS template (docxtemplater
 * for the .docx TSD, `xlsx` cell-fill for the Unit Test workbook) — stored
 * as base64 on the Program record, same durability model as `report`, so
 * it's downloadable again after the fact without regenerating.
 */
export interface GeneratedDocument {
  generatedAt: string;
  filename: string;
  /** Base64-encoded file bytes (.docx or .xlsx). */
  base64: string;
}

export interface Program {
  id: string;
  name: string;
  objectType: AbapObjectType;
  package: string;
  /** Which central ATC check variant to run against this object — see CleanCoreAnalysisAgent / RealAdtClient.runAtcCheck. Defaults to the clean-core variant (ZNUS_SCI_CC_CENTRAL) when not set. */
  atcCheckVariant?: string;
  businessArea: string;
  criticality: Criticality;
  owner: string;
  state: WorkflowState;
  dependencies: DependencyObject[];
  findings: Finding[];
  worstExtensibilityLevel?: ExtensibilityLevel;
  riskScore?: RiskScoreBreakdown;
  baselineTests?: TestRunResult;
  gitBaseline?: GitBaseline;
  /** Original source as discovered, kept alongside proposedSource for a direct side-by-side compare in the UI. */
  baselineSource?: string;
  /**
   * The remediation agent's proposed fixed source, awaiting human review at
   * AWAITING_FIX_REVIEW. Editable by the approver before the write path
   * (syntaxCheckAndActivate) runs against it — see orchestrator's
   * fixReviewDecision.
   */
  proposedSource?: string;
  validationReport?: ValidationReport;
  /** The real workbench transport request the human approver names at Gate 2 — captured, not merely a state label, since every fix eventually needs a transport (docs/design/clean-core-migration-design.md §6). */
  transportNumber?: string;
  report?: TechSpecReport;
  tsdDocument?: GeneratedDocument;
  unitTestDocument?: GeneratedDocument;
  remediationAttempts: number;
  createdAt: string;
  updatedAt: string;
  auditLog: AuditEntry[];
}

export interface ExcelIntakeRow {
  programName: string;
  objectType?: AbapObjectType;
  package: string;
  atcCheckVariant?: string;
  businessArea: string;
  criticality: Criticality;
  owner: string;
}
