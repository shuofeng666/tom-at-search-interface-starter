import {
  CandidateEvaluation,
  CandidateProject,
  CandidateSourceType,
  CostEstimate,
  CostTier,
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
  results,
  // Cap how many results are evaluated in parallel. Option B over-fetches
  // (~20 results) and scores ALL of them, so firing every Gemini call at once
  // risks 429 rate-limit errors. Batching keeps it safe. Lower if you still
  // hit limits; raise it if your Gemini quota is comfortable.
  batchSize = 5
}: {
  needProfile: NeedProfile;
  results: ExaSearchResult[];
  batchSize?: number;
}): Promise<CandidateProject[]> {
  const candidates: CandidateProject[] = [];

  for (let start = 0; start < results.length; start += batchSize) {
    const batch = results.slice(start, start + batchSize);

    const evaluated = await Promise.all(
      batch.map((result, offset) =>
        evaluateSingleResult({
          needProfile,
          result,
          index: start + offset
        })
      )
    );

    candidates.push(...evaluated);
  }

  return sortCandidates(candidates);
}

// Source diversity: after every candidate is scored, keep at most
// `maxPerDomain` per source so one prolific site (e.g. github, instructables)
// can't dominate the results. Input is sorted by score first, so the ones we
// keep per domain are always that domain's highest-scoring candidates.
export function diversifyByDomain(
  candidates: CandidateProject[],
  maxPerDomain = 2
): CandidateProject[] {
  const sorted = sortCandidates(candidates);
  const perDomainCount = new Map<string, number>();
  const kept: CandidateProject[] = [];

  for (const candidate of sorted) {
    const domain = candidate.source || "unknown source";
    const count = perDomainCount.get(domain) || 0;

    if (count >= maxPerDomain) continue;

    perDomainCount.set(domain, count + 1);
    kept.push(candidate);
  }

  return kept;
}

export function sortCandidates(candidates: CandidateProject[]) {
  return [...candidates].sort((a, b) => {
    if (a.rejected && !b.rejected) return 1;
    if (!a.rejected && b.rejected) return -1;

    return b.evaluation.overallScore - a.evaluation.overallScore;
  });
}

// Build a CandidateProject from an Exa result WITHOUT calling the LLM. The
// evaluation starts empty; scoring happens later (on demand) via
// evaluateCandidate. This lets us fetch a pool fast and only score what's shown.
export function buildCandidateFromExa(
  result: ExaSearchResult,
  index: number
): CandidateProject {
  const title = result.title || "Untitled project";
  const url = result.url || "";
  const sourceType = detectSourceType(url);
  const source = sourceLabelFromUrl(url);
  const rawText = buildRawText(result);

  return {
    id: result.id || stableId(url || `${title}-${index}`),
    title,
    url,
    source,
    sourceType,
    image: pickImage(result),
    summary: result.summary || result.highlights?.join(" ") || trimText(rawText, 420),
    rawText,
    evaluation: emptyCandidateEvaluation()
  };
}

export function buildCandidatesFromExa(results: ExaSearchResult[]): CandidateProject[] {
  return results.map((result, index) => buildCandidateFromExa(result, index));
}

// Score a single already-built candidate with Gemini. Returns the candidate with
// its evaluation filled in (id/title/image/etc. preserved).
export async function evaluateCandidate({
  needProfile,
  candidate
}: {
  needProfile: NeedProfile;
  candidate: CandidateProject;
}): Promise<CandidateProject> {
  const parsed = await generateGeminiJson<RawEvaluation>({
    prompt: buildEvaluationPrompt({
      needProfile,
      title: candidate.title,
      url: candidate.url,
      source: candidate.source,
      sourceType: candidate.sourceType,
      rawText: candidate.rawText || ""
    })
  });

  return {
    ...candidate,
    evaluation: normalizeEvaluation(parsed)
  };
}

// Score a batch of candidates. Order is preserved (no sorting) so the UI can
// show results grouped/interleaved by source exactly as they were fetched.
export async function evaluateCandidates({
  needProfile,
  candidates,
  batchSize = 5
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  batchSize?: number;
}): Promise<CandidateProject[]> {
  const scored: CandidateProject[] = [];

  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);

    const evaluated = await Promise.all(
      batch.map((candidate) => evaluateCandidate({ needProfile, candidate }))
    );

    scored.push(...evaluated);
  }

  return scored;
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
  const candidate = buildCandidateFromExa(result, index);
  return evaluateCandidate({ needProfile, candidate });
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
You are evaluating a search result for an assistive technology matching workflow.

This is NOT a competition judging task. Do NOT evaluate whether the project is
innovative or impressive. Evaluate whether this candidate is a practical fit for
this specific Need Profile.

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

FIRST, decide what the candidate actually is:
- A concrete assistive-technology solution = a specific product, project, build,
  downloadable design, or modifiable open-source artifact that a person could
  buy, make, adapt, or ask a maker team to adapt.
- Non-solution content = search pages, listing pages, organization pages,
  blog posts, judging criteria, marketing pages, or general information without
  a concrete obtainable/buildable/adaptable solution.

If it is non-solution content:
- overallScore must be 1 or below.
- pathway must be "reference only" or "not recommended yet".
- Add "not an actual solution" to hardFailures and riskFlags.

Evaluate using these dimensions from 0 to 3:

0 = no evidence, not applicable, or fails the need
1 = weak / indirect / only partially related
2 = plausible fit but needs confirmation or adaptation
3 = strong fit with clear evidence

Dimensions:

1. needFit
Does it directly address the user's activity, problem, and desired outcome?
Focus on the actual use case, not keyword overlap.

2. criticalRequirements
Does it satisfy the user's hard requirements, must-haves, must-avoids, and
safety constraints? Examples include hands-free use, easy attach/remove,
wheelchair compatibility, age suitability, or avoiding hand use.

Hard rule: if the candidate fails a critical must-have, it cannot be a strong
recommendation even if it is well documented.

3. contextFit
Does it fit the user's real context: age, region/country, current devices,
body function, environment, and usage situation? For example, a wheelchair user
who needs both hands for propulsion has a different need than a user who only
needs help gripping a cup while stationary.

4. accessPathway
How can the user realistically obtain it?
- For commercial products: is it likely purchasable in the user's country or
  region? Are sizing, price, shipping, and return uncertainty important?
- For TOM projects: are files/resources/download links available? Is it realistic
  for TOM or a maker team to fabricate it?
- For open-source/DIY projects: are files, instructions, and materials accessible?

5. adaptationFeasibility
If it is not a perfect match, can it reasonably be modified to fit?
This dimension applies to TOM projects, open-source projects, DIY projects, and
commercial products.

For TOM projects, explicitly assess whether an existing TOM solution could be
adapted by a TOM maker team for this Need Profile.

For open-source / DIY projects, assess whether there are modifiable files,
3D models, CAD files, source code, BOM, assembly instructions, or a license that
makes adaptation realistic.

For commercial products, assess whether it can be adjusted, mounted, combined,
or safely modified without unreasonable risk.

6. evidenceQuality
How much evidence supports this candidate? Consider photos, documentation,
BOM, downloadable files, model files, product specs, reviews, user stories,
measurements, installation instructions, and testing evidence.

7. safetyAndRisk
What safety risks or failure modes matter for this specific user? Consider
wheelchair propulsion, braking, balance, visibility, attachment stability,
weather exposure, choking/sharp edges, electrical risks, medical fit, and
whether use could distract from safe mobility.

Also estimate costEstimate (this is descriptive, not one of the 0-3 scored
dimensions above, and does not affect overallScore):
- For commercial products: use the actual price if mentioned or a realistic
  market estimate for that category of product.
- For TOM projects, open-source, and DIY projects: estimate the cost of
  materials/parts to fabricate it (not TOM's or a maker's labor time).
  Genuinely low-material-cost builds (a few printed/laser-cut parts, basic
  hardware) should be "free-diy" or "low", not inflated.
- tier must be one of: "free-diy" (no or trivial material cost),
  "low", "moderate", "high", or "unknown" if there's no basis to estimate.
- note is one short sentence explaining the estimate or why it's unknown.

Hard scoring rules:
- Do not average away a hard failure.
- If needFit is 0, overallScore must be 0.8 or below.
- If criticalRequirements is 0, overallScore must be 1.2 or below.
- If safetyAndRisk is 0 due to a serious safety issue, overallScore must be 1.0 or below.
- If accessPathway is 0 because the user cannot realistically obtain/make it,
  overallScore must be 1.5 or below.
- If the candidate is only keyword-related but does not solve the actual need,
  overallScore must be 1.2 or below.
- A TOM project should be checked and valued as an official source, but it should
  not be recommended solely because it is from TOM.
- If a TOM project is related but not directly suitable, prefer "needs adaptation"
  or "maker team review" rather than "can recommend".

Pathway definitions:
- "can recommend": strong fit, critical requirements met, no major safety or access concern.
- "needs more information": plausible fit, but missing key size/context/access/safety info.
- "reference only": useful inspiration, but not a direct solution.
- "needs adaptation": direction is relevant but needs modification for this user.
- "maker team review": TOM/maker expertise is needed to judge feasibility or safety.
- "possible new TOM challenge": no adequate existing solution, but the need is clear.
- "not recommended yet": clearly mismatched, inaccessible, unsafe, or not a real solution.

Return ONLY valid JSON with this exact shape:
{
  "overallScore": number,
  "needFit": { "score": number, "explanation": "string", "evidence": ["string"] },
  "criticalRequirements": { "score": number, "explanation": "string", "evidence": ["string"] },
  "contextFit": { "score": number, "explanation": "string", "evidence": ["string"] },
  "accessPathway": { "score": number, "explanation": "string", "evidence": ["string"] },
  "adaptationFeasibility": { "score": number, "explanation": "string", "evidence": ["string"] },
  "evidenceQuality": { "score": number, "explanation": "string", "evidence": ["string"] },
  "safetyAndRisk": { "score": number, "explanation": "string", "evidence": ["string"] },
  "costEstimate": { "tier": "free-diy | low | moderate | high | unknown", "note": "string" },
  "hardFailures": ["string"],
  "matchedCriteria": ["string"],
  "unmatchedCriteria": ["string"],
  "missingInformation": ["string"],
  "riskFlags": ["string"],
  "pathway": "can recommend | needs more information | reference only | needs adaptation | maker team review | possible new TOM challenge | not recommended yet",
  "pathwayReason": "string"
}

Important:
- Be strict about the specific Need Profile.
- Do not say "may help" if the candidate fails the core need.
- Mention age, location, current device, must-have requirements, and access pathway when relevant.
- If the candidate could be adapted, explain exactly what adaptation would be needed.
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

    needFit: normalizeDimension(value.needFit, empty.needFit),
    criticalRequirements: normalizeDimension(
      value.criticalRequirements,
      empty.criticalRequirements
    ),
    contextFit: normalizeDimension(value.contextFit, empty.contextFit),
    accessPathway: normalizeDimension(value.accessPathway, empty.accessPathway),
    adaptationFeasibility: normalizeDimension(
      value.adaptationFeasibility,
      empty.adaptationFeasibility
    ),
    evidenceQuality: normalizeDimension(
      value.evidenceQuality,
      empty.evidenceQuality
    ),
    safetyAndRisk: normalizeDimension(value.safetyAndRisk, empty.safetyAndRisk),
    costEstimate: normalizeCostEstimate(value.costEstimate, empty.costEstimate),

    hardFailures: toStringArray(value.hardFailures),
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

  return applyHardCaps(evaluation);
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

const COST_TIERS: CostTier[] = ["free-diy", "low", "moderate", "high", "unknown"];

function normalizeCostEstimate(
  input: unknown,
  fallback: CostEstimate
): CostEstimate {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const tier =
    typeof value.tier === "string" && COST_TIERS.includes(value.tier as CostTier)
      ? (value.tier as CostTier)
      : fallback.tier;

  const note =
    typeof value.note === "string" && value.note.trim()
      ? value.note.trim()
      : fallback.note;

  return { tier, note };
}

function computeWeightedOverall(evaluation: CandidateEvaluation) {
  // AT matching should weight fit and hard requirements more than documentation.
  const weightedTotal =
    evaluation.needFit.score * 2 +
    evaluation.criticalRequirements.score * 2 +
    evaluation.contextFit.score * 1.5 +
    evaluation.safetyAndRisk.score * 1.5 +
    evaluation.accessPathway.score * 1 +
    evaluation.adaptationFeasibility.score * 1 +
    evaluation.evidenceQuality.score * 1;

  const totalWeight = 10;

  return Math.round((weightedTotal / totalWeight) * 10) / 10;
}

function applyHardCaps(evaluation: CandidateEvaluation): CandidateEvaluation {
  let cappedScore = evaluation.overallScore;

  if (evaluation.needFit.score === 0) {
    cappedScore = Math.min(cappedScore, 0.8);
  }

  if (evaluation.criticalRequirements.score === 0) {
    cappedScore = Math.min(cappedScore, 1.2);
  }

  if (evaluation.safetyAndRisk.score === 0) {
    cappedScore = Math.min(cappedScore, 1.0);
  }

  if (evaluation.accessPathway.score === 0) {
    cappedScore = Math.min(cappedScore, 1.5);
  }

  const hardText = [
    ...evaluation.hardFailures,
    ...evaluation.unmatchedCriteria,
    ...evaluation.riskFlags,
    evaluation.pathwayReason
  ]
    .join(" ")
    .toLowerCase();

  if (
    containsAny(hardText, [
      "not an actual solution",
      "non-solution",
      "completely unrelated",
      "does not address",
      "does not solve",
      "only keyword-related"
    ])
  ) {
    cappedScore = Math.min(cappedScore, 0.8);
  }

  if (
    containsAny(hardText, [
      "fails a critical",
      "critical must-have",
      "does not meet the critical",
      "does not satisfy the critical",
      "hands-free",
      "must-have"
    ]) &&
    evaluation.criticalRequirements.score <= 1
  ) {
    cappedScore = Math.min(cappedScore, 1.2);
  }

  if (
    containsAny(hardText, [
      "unsafe",
      "safety risk",
      "serious safety",
      "could interfere with wheelchair",
      "could interfere with braking",
      "could interfere with propulsion"
    ])
  ) {
    cappedScore = Math.min(cappedScore, 1.0);
  }

  if (
    containsAny(hardText, [
      "not available",
      "cannot obtain",
      "not purchasable",
      "not enough information to obtain",
      "no downloadable files",
      "no fabrication files"
    ])
  ) {
    cappedScore = Math.min(cappedScore, 1.5);
  }

  return {
    ...evaluation,
    overallScore: Math.round(Math.max(0, Math.min(3, cappedScore)) * 10) / 10
  };
}

function containsAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

function computeOverallFromDimensions(value: Record<string, unknown>) {
  const dimensions = [
    "needFit",
    "criticalRequirements",
    "contextFit",
    "accessPathway",
    "adaptationFeasibility",
    "evidenceQuality",
    "safetyAndRisk"
  ];

  const scores = dimensions
    .map((key) => {
      const dim = value[key];
      if (!dim || typeof dim !== "object") return 0;
      return toScore((dim as Record<string, unknown>).score);
    })
    .filter((score) => score > 0);

  if (!scores.length) return 0;

  return Math.round(
    (scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10
  ) / 10;
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