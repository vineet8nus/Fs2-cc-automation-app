export type WorkflowState =
  | "UPLOADED"
  | "GIT_BASELINED"
  | "DISCOVERED"
  | "ANALYZED"
  | "BASELINING_TESTS"
  | "AWAITING_HUMAN_REVIEW_1"
  | "PARKED"
  | "REMEDIATING"
  | "VALIDATING"
  | "ESCALATED"
  | "AWAITING_HUMAN_REVIEW_2"
  | "TRANSPORT_RELEASED"
  | "DOCUMENTED"
  | "DONE";

export type ExtensibilityLevel = "A" | "B" | "C" | "D";

export interface RiskScoreBreakdown {
  total: number;
  band: "Critical" | "High" | "Medium" | "Low";
  atcPriorityScore: number;
  extensibilityLevelScore: number;
  usageFrequencyScore: number;
  businessCriticalityScore: number;
  fixConfidencePenalty: number;
  dependencyFanOutScore: number;
}

export interface ProgramSummary {
  id: string;
  name: string;
  package: string;
  businessArea: string;
  criticality: "H" | "M" | "L";
  owner: string;
  state: WorkflowState;
  findingsCount: number;
  worstExtensibilityLevel?: ExtensibilityLevel;
  riskScore?: RiskScoreBreakdown;
  updatedAt: string;
}

export interface SuggestedFix {
  origin: "native_quick_fix" | "ai_generated" | "none";
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
  priority: 1 | 2 | 3 | 4;
  extensibilityLevel: ExtensibilityLevel;
  suggestedFix: SuggestedFix;
  status: "open" | "approved" | "rejected" | "deferred" | "fixed" | "validated";
}

export interface DependencyObject {
  name: string;
  type: string;
  usedBy?: string;
}

export interface TestCase {
  id: string;
  name: string;
  kind: "existing" | "generated_characterization";
  status: "pass" | "fail" | "not_run";
  humanConfirmed: boolean;
}

export interface ValidationReport {
  runAt: string;
  syntaxCheckPassed: boolean;
  activationPassed: boolean;
  replacedObjectsExist: boolean;
  atcFindingCleared: boolean;
  baselineTestsStillPass: boolean;
  newTestsPass: boolean;
  sideEffectChecks: { name: string; passed: boolean; detail: string }[];
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

export interface ProgramDetail extends ProgramSummary {
  dependencies: DependencyObject[];
  findings: Finding[];
  baselineTests?: { runAt: string; cases: TestCase[] };
  validationReport?: ValidationReport;
  gitBaseline?: GitBaseline;
  report?: { generatedAt: string; markdown: string };
  remediationAttempts: number;
  auditLog: AuditEntry[];
}

export interface RetroMetrics {
  totalPrograms: number;
  byState: Record<string, number>;
  parkedRate: number;
  gate1RejectionRate: number;
  nativeQuickFixRatio: number;
  aiFixRatio: number;
  validationFailRate: number;
  avgFindingsPerProgram: number;
  recommendations: string[];
}
