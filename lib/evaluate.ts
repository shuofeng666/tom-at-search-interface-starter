import {
  CandidateEvaluation,
  CandidateProject,
  CandidateSourceType,
  emptyCandidateEvaluation,
  EvaluationDimension,
  ExaSearchResult,
  NeedProfile,
  TomPathway
} from "./types";
import { detectSourceType, sourceLabelFromUrl } from "./exa";
import { generateGeminiJson, toScore, toStringArray } from "./gemini";

type RawEvaluation = Partial<CandidateEvaluation>;

export async function evaluateSearchResults({
  needProfile,
  results
}: {
  needProfile: NeedProfile;
  results: ExaSearchResult[];
}): Promise<CandidateProject[]> {
  const candidates = await Promise.all(
    results.map((result, index) =>
      evaluateSingleResult({
        needProfile,
        result,
        index
      })
    )
  );

  return sortCandidates(candidates);
}

export function sortCandidates(candidates: CandidateProject[]) {
  return [...candidates].sort((a, b) => {
    if (a.rejected && !b.rejected) return 1;
    if (!a.rejected && b.rejected) return -1;

    return b.evaluation.overallScore - a.evaluation.overallScore;
  });
}

async function evaluateSingleResult({
  needProfile,
  result,
  index
}: {
  needProfile: NeedProfile;
  result: ExaSearchResult;
  index: number;
}): Promise<CandidateProject> {
  const title = result.title || "Untitled project";
  const url = result.url || "";
  const sourceType = detectSourceType(url);
  const source = sourceLabelFromUrl(url);
  const rawText = buildRawText(result);

  const parsed = await generateGeminiJson<RawEvaluation>({
    prompt: buildEvaluationPrompt({
      needProfile,
      title,
      url,
      source,
      sourceType,
      rawText
    })
  });

  const evaluation = normalizeEvaluation(parsed);

  return {
    id: result.id || stableId(url || `${title}-${index}`),
    title,
    url,
    source,
    sourceType,
    image: pickImage(result),
    summary: result.summary || result.highlights?.join(" ") || trimText(rawText, 420),
    rawText,
    evaluation
  };
}

// Prefer the page's social preview image (og:image). If there isn't one,
// fall back to the first usable in-page image from Exa's imageLinks, while
// skipping tiny badges/shields/icons that READMEs commonly start with.
function pickImage(result: ExaSearchResult): string | undefined {
  if (result.image && isUsableImage(result.image)) {
    return result.image;
  }

  const links = result.extras?.imageLinks || [];
  const usable = links.find((link) => isUsableImage(link));

  return usable || result.image || links[0];
}

function isUsableImage(url: string): boolean {
  if (!url) return false;

  const lower = url.toLowerCase();

  const looksLikeBadge =
    lower.includes("shields.io") ||
    lower.includes("img.shields") ||
    lower.includes("/badge") ||
    lower.includes("badgen.net") ||
    lower.includes("badge.fury") ||
    lower.includes("travis-ci") ||
    lower.includes("circleci.com") ||
    lower.includes("codecov.io") ||
    lower.includes("sponsor") ||
    lower.endsWith(".svg") ||
    lower.includes(".svg?");

  return !looksLikeBadge;
}

function buildEvaluationPrompt({
  needProfile,
  title,
  url,
  source,
  sourceType,
  rawText
}: {
  needProfile: NeedProfile;
  title: string;
  url: string;
  source: string;
  sourceType: CandidateSourceType;
  rawText: string;
}) {
  return `
You are evaluating a search result for TOM, an organization that works on assistive technology projects.

Need Profile:
${JSON.stringify(needProfile, null, 2)}

Candidate:
${JSON.stringify(
  {
    title,
    url,
    source,
    sourceType,
    rawText: trimText(rawText, 6000)
  },
  null,
  2
)}

Evaluate the candidate using TOM-style review criteria.

Use scores from 0 to 3:
0 = no evidence or does not satisfy
1 = weak / unclear / partial
2 = mostly satisfies but needs confirmation or adaptation
3 = strong fit with useful evidence

Return ONLY valid JSON with this shape:
{
  "overallScore": number,
  "needMatch": { "score": number, "explanation": "string", "evidence": ["string"] },
  "functionalFit": { "score": number, "explanation": "string", "evidence": ["string"] },
  "accessibilityManufacturability": { "score": number, "explanation": "string", "evidence": ["string"] },
  "affordabilityAvailability": { "score": number, "explanation": "string", "evidence": ["string"] },
  "qualityOfSolution": { "score": number, "explanation": "string", "evidence": ["string"] },
  "documentationQuality": { "score": number, "explanation": "string", "evidence": ["string"] },
  "userTestingEvidence": { "score": number, "explanation": "string", "evidence": ["string"] },
  "safetyRisk": { "score": number, "explanation": "string", "evidence": ["string"] },
  "customizationPotential": { "score": number, "explanation": "string", "evidence": ["string"] },
  "matchedCriteria": ["string"],
  "unmatchedCriteria": ["string"],
  "missingInformation": ["string"],
  "riskFlags": ["string"],
  "pathway": "can recommend | needs more information | reference only | needs adaptation | maker team review | possible new TOM challenge | not recommended yet",
  "pathwayReason": "string"
}

Important:
- Do not over-recommend.
- If documentation is weak, say so.
- If safety is unclear, flag it.
- If the result is only keyword-related, give a low fit score.
- Mention missing information clearly.
`;
}

export function normalizeEvaluation(input: unknown): CandidateEvaluation {
  const empty = emptyCandidateEvaluation();
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const evaluation: CandidateEvaluation = {
    overallScore:
      typeof value.overallScore === "number"
        ? Math.max(0, Math.min(3, value.overallScore))
        : computeOverallFromDimensions(value),

    needMatch: normalizeDimension(value.needMatch, empty.needMatch),
    functionalFit: normalizeDimension(value.functionalFit, empty.functionalFit),
    accessibilityManufacturability: normalizeDimension(
      value.accessibilityManufacturability,
      empty.accessibilityManufacturability
    ),
    affordabilityAvailability: normalizeDimension(
      value.affordabilityAvailability,
      empty.affordabilityAvailability
    ),
    qualityOfSolution: normalizeDimension(value.qualityOfSolution, empty.qualityOfSolution),
    documentationQuality: normalizeDimension(value.documentationQuality, empty.documentationQuality),
    userTestingEvidence: normalizeDimension(value.userTestingEvidence, empty.userTestingEvidence),
    safetyRisk: normalizeDimension(value.safetyRisk, empty.safetyRisk),
    customizationPotential: normalizeDimension(
      value.customizationPotential,
      empty.customizationPotential
    ),

    matchedCriteria: toStringArray(value.matchedCriteria),
    unmatchedCriteria: toStringArray(value.unmatchedCriteria),
    missingInformation: toStringArray(value.missingInformation),
    riskFlags: toStringArray(value.riskFlags),

    pathway: normalizePathway(value.pathway),
    pathwayReason:
      typeof value.pathwayReason === "string" && value.pathwayReason.trim()
        ? value.pathwayReason.trim()
        : empty.pathwayReason
  };

  if (!evaluation.overallScore) {
    evaluation.overallScore = computeWeightedOverall(evaluation);
  }

  return evaluation;
}

function normalizeDimension(input: unknown, fallback: EvaluationDimension): EvaluationDimension {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  return {
    score: toScore(value.score),
    explanation:
      typeof value.explanation === "string" && value.explanation.trim()
        ? value.explanation.trim()
        : fallback.explanation,
    evidence: toStringArray(value.evidence)
  };
}

function computeWeightedOverall(evaluation: CandidateEvaluation) {
  const weighted =
    evaluation.needMatch.score * 1.2 +
    evaluation.functionalFit.score * 1.4 +
    evaluation.safetyRisk.score * 1.2 +
    evaluation.documentationQuality.score +
    evaluation.accessibilityManufacturability.score +
    evaluation.affordabilityAvailability.score * 0.7 +
    evaluation.userTestingEvidence.score * 0.8 +
    evaluation.customizationPotential.score * 0.7;

  return Math.round((weighted / 8) * 10) / 10;
}

function computeOverallFromDimensions(value: Record<string, unknown>) {
  const dimensions = [
    "needMatch",
    "functionalFit",
    "accessibilityManufacturability",
    "affordabilityAvailability",
    "qualityOfSolution",
    "documentationQuality",
    "userTestingEvidence",
    "safetyRisk",
    "customizationPotential"
  ];

  const scores = dimensions
    .map((key) => {
      const dim = value[key];
      if (!dim || typeof dim !== "object") return 0;
      return toScore((dim as Record<string, unknown>).score);
    })
    .filter((score) => score > 0);

  if (!scores.length) return 0;

  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
}

function normalizePathway(value: unknown): TomPathway {
  const allowed: TomPathway[] = [
    "can recommend",
    "needs more information",
    "reference only",
    "needs adaptation",
    "maker team review",
    "possible new TOM challenge",
    "not recommended yet"
  ];

  if (typeof value === "string" && allowed.includes(value as TomPathway)) {
    return value as TomPathway;
  }

  return "needs more information";
}

function buildRawText(result: ExaSearchResult) {
  return [
    result.title,
    result.summary,
    ...(result.highlights || []),
    result.text
  ]
    .filter(Boolean)
    .join("\n\n");
}

function trimText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function stableId(value: string) {
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }

  return `candidate-${Math.abs(hash)}`;
}