import { Criticality, ExtensibilityLevel, Finding, RiskScoreBreakdown } from "../domain/types";

// Configurable weights per docs/design/clean-core-migration-design.md §6.3.
// Not hardcoded business policy — override via env if a customer's own
// governance model uses different weightings.
export interface RiskWeights {
  atcPriority: number;
  extensibilityLevel: number;
  usageFrequency: number;
  businessCriticality: number;
  fixConfidencePenalty: number;
  dependencyFanOut: number;
}

export const DEFAULT_WEIGHTS: RiskWeights = {
  atcPriority: 3,
  extensibilityLevel: 4,
  usageFrequency: 2,
  businessCriticality: 3,
  fixConfidencePenalty: 2,
  dependencyFanOut: 1,
};

const EXTENSIBILITY_SCORE: Record<ExtensibilityLevel, number> = { A: 0, B: 1, C: 2, D: 3 };
const CRITICALITY_SCORE: Record<Criticality, number> = { L: 1, M: 2, H: 3 };

export function worstExtensibilityLevel(findings: Finding[]): ExtensibilityLevel | undefined {
  if (findings.length === 0) return undefined;
  return findings.reduce<ExtensibilityLevel>((worst, f) => {
    return EXTENSIBILITY_SCORE[f.extensibilityLevel] > EXTENSIBILITY_SCORE[worst] ? f.extensibilityLevel : worst;
  }, "A");
}

export function computeRiskScore(
  findings: Finding[],
  criticality: Criticality,
  dependencyCount: number,
  usageFrequency: number = 1,
  weights: RiskWeights = DEFAULT_WEIGHTS
): RiskScoreBreakdown {
  if (findings.length === 0) {
    return {
      atcPriorityScore: 0,
      extensibilityLevelScore: 0,
      usageFrequencyScore: 0,
      businessCriticalityScore: 0,
      fixConfidencePenalty: 0,
      dependencyFanOutScore: 0,
      total: 0,
      band: "Low",
    };
  }

  const worstPriority = Math.min(...findings.map((f) => f.priority)); // 1 = worst
  const atcPriorityScore = weights.atcPriority * (5 - worstPriority);

  const worstLevel = worstExtensibilityLevel(findings) ?? "A";
  const extensibilityLevelScore = weights.extensibilityLevel * EXTENSIBILITY_SCORE[worstLevel];

  const usageFrequencyScore = weights.usageFrequency * Math.min(usageFrequency, 5);

  const businessCriticalityScore = weights.businessCriticality * CRITICALITY_SCORE[criticality];

  const aiFixCount = findings.filter((f) => f.suggestedFix.origin === "ai_generated").length;
  const fixConfidencePenalty = weights.fixConfidencePenalty * Math.min(aiFixCount, 5);

  const dependencyFanOutScore = weights.dependencyFanOut * Math.min(dependencyCount, 10);

  const total =
    atcPriorityScore +
    extensibilityLevelScore +
    usageFrequencyScore +
    businessCriticalityScore +
    fixConfidencePenalty +
    dependencyFanOutScore;

  let band: RiskScoreBreakdown["band"] = "Low";
  if (total >= 40) band = "Critical";
  else if (total >= 28) band = "High";
  else if (total >= 15) band = "Medium";

  return {
    atcPriorityScore,
    extensibilityLevelScore,
    usageFrequencyScore,
    businessCriticalityScore,
    fixConfidencePenalty,
    dependencyFanOutScore,
    total: Math.round(total * 10) / 10,
    band,
  };
}
