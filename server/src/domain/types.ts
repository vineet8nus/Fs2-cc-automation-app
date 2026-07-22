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
  objectName: string;
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

export interface Program {
  id: string;
  name: string;
  package: string;
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
  report?: TechSpecReport;
  remediationAttempts: number;
  createdAt: string;
  updatedAt: string;
  auditLog: AuditEntry[];
}

export interface ExcelIntakeRow {
  programName: string;
  package: string;
  businessArea: string;
  criticality: Criticality;
  owner: string;
}
