import { Program } from "../domain/types";

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

/**
 * Standing agent (not a one-off exercise) answering "validate this process
 * and advise on improvements": aggregates run metrics across every program
 * and surfaces process-improvement recommendations, per
 * docs/design/clean-core-migration-design.md agent roster.
 */
export function computeRetroMetrics(programs: Program[]): RetroMetrics {
  const totalPrograms = programs.length;
  const byState: Record<string, number> = {};
  for (const p of programs) byState[p.state] = (byState[p.state] ?? 0) + 1;

  const parked = programs.filter((p) => p.state === "PARKED").length;
  const parkedRate = totalPrograms ? parked / totalPrograms : 0;

  const reviewed1 = programs.filter((p) =>
    p.auditLog.some((a) => a.action.includes("gate1"))
  ).length;
  const rejected1 = programs.filter((p) =>
    p.auditLog.some((a) => a.action.includes("gate1") && a.action.includes("reject"))
  ).length;
  const gate1RejectionRate = reviewed1 ? rejected1 / reviewed1 : 0;

  const allFindings = programs.flatMap((p) => p.findings);
  const fixableFindings = allFindings.filter((f) => f.suggestedFix.origin !== "none");
  const nativeCount = fixableFindings.filter((f) => f.suggestedFix.origin === "native_quick_fix").length;
  const aiCount = fixableFindings.filter((f) => f.suggestedFix.origin === "ai_generated").length;
  const nativeQuickFixRatio = fixableFindings.length ? nativeCount / fixableFindings.length : 0;
  const aiFixRatio = fixableFindings.length ? aiCount / fixableFindings.length : 0;

  const validated = programs.filter((p) => p.validationReport);
  const validationFails = validated.filter((p) => p.validationReport && !p.validationReport.overallPass);
  const validationFailRate = validated.length ? validationFails.length / validated.length : 0;

  const avgFindingsPerProgram = totalPrograms ? allFindings.length / totalPrograms : 0;

  const recommendations: string[] = [];
  if (parkedRate > 0.3) {
    recommendations.push(
      `${Math.round(parkedRate * 100)}% of programs are parked — review whether Gate 1 criteria are too strict or findings need better context for developers.`
    );
  }
  if (aiFixRatio > 0.6) {
    recommendations.push(
      `AI-authored fixes account for ${Math.round(aiFixRatio * 100)}% of applied fixes — consider expanding the native quick-fix catalog for the most common recurring ATC check IDs to reduce reliance on AI-generated changes.`
    );
  }
  if (validationFailRate > 0.2) {
    recommendations.push(
      `${Math.round(validationFailRate * 100)}% of validation runs fail — investigate whether remediation logic needs tightening for the most common failure reasons before Human Gate 2 sees them.`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("No process anomalies detected in the current run set.");
  }

  return {
    totalPrograms,
    byState,
    parkedRate,
    gate1RejectionRate,
    nativeQuickFixRatio,
    aiFixRatio,
    validationFailRate,
    avgFindingsPerProgram,
    recommendations,
  };
}
