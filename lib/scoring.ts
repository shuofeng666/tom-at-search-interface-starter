import { CandidateProject, ProjectEvaluation, Score, TOMPathway } from "./types";

const weights: Record<keyof Omit<ProjectEvaluation, "overallScore" | "pathway" | "pathwayReason" | "riskFlags" | "missingInformation" | "matchedCriteria" | "unmatchedCriteria">, number> = {
  needMatch: 1.4,
  functionalFit: 1.4,
  accessibilityManufacturability: 1,
  documentationQuality: 1,
  safetyRisk: 1.2,
  affordabilityAvailability: 0.7,
  userTestingEvidence: 0.8,
  customizationPotential: 0.6
};

export function computeOverallScore(evaluation: ProjectEvaluation): number {
  let total = 0;
  let weightTotal = 0;

  for (const key of Object.keys(weights) as Array<keyof typeof weights>) {
    total += evaluation[key].score * weights[key];
    weightTotal += weights[key];
  }

  return Number((total / weightTotal).toFixed(2));
}

export function inferPathway(evaluation: ProjectEvaluation): TOMPathway {
  const score = computeOverallScore(evaluation);
  const documentation = evaluation.documentationQuality.score;
  const safety = evaluation.safetyRisk.score;
  const fit = evaluation.functionalFit.score;
  const evidence = evaluation.userTestingEvidence.score;

  if (fit >= 2 && safety >= 2 && documentation >= 2 && score >= 2.4) return "recommendable";
  if (fit >= 2 && safety < 2) return "maker_team_review";
  if (fit >= 2 && documentation < 2) return "needs_more_information";
  if (fit >= 2 && evidence < 2) return "needs_more_information";
  if (fit === 1 && score >= 1.4) return "reference_only";
  if (fit === 0) return "not_recommended";
  return "needs_adaptation";
}

export function scoreLabel(score: Score): "none" | "low" | "medium" | "high" {
  if (score === 3) return "high";
  if (score === 2) return "medium";
  if (score === 1) return "low";
  return "none";
}

export function sortCandidates(candidates: CandidateProject[]): CandidateProject[] {
  return [...candidates].sort((a, b) => b.evaluation.overallScore - a.evaluation.overallScore);
}
