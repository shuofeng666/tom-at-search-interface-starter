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

Evaluate the candidate using TOM's official Judging Criteria. Score ONLY these
six criteria — do not invent additional dimensions.

FIRST, decide what the candidate actually is:
- A concrete assistive-technology SOLUTION = a specific device, product, build,
  or project that a person could actually obtain or make to address a need.
- NON-SOLUTION content = guidelines, judging criteria, rules, "about"/org pages,
  category / listing / search-result pages, or blog/marketing posts that do not
  contain an obtainable or buildable solution.

If the candidate is NON-SOLUTION content, it CANNOT score well:
- Set every dimension score to 0 or 1.
- Set overallScore to 1 or below.
- Set pathway to "reference only" or "not recommended yet".
- Add "not an actual solution" to riskFlags.

Do NOT give credit just because a page lists, defines, mentions, or "emphasizes"
a criterion. A page that DEFINES "Documentation" as a judging criterion has not
itself produced documentation of a solution. Score the SOLUTION ITSELF, not the
page's talk about the criteria. If there is no solution, there is nothing to
score highly.

1. innovation: How clearly innovative, novel, or surprising the solution is.
2. qualityOfSolution: How well the solution is constructed — use of materials,
   durability, and craftsmanship.
3. accessibility: How easy it is to find the tools and materials used, and how
   easy the solution is to make.
4. affordability: How affordable the solution is to make (relative to a typical
   geographical location).
5. documentation: How well the solution is documented — how easy it is to
   understand the tools, materials, and assembly steps needed to replicate it.
6. impact: The potential to transform a single person's life (individual
   impact) AND the potential to change the lives of many people around the
   world (global impact). Consider how well it fits this Need Profile for the
   individual side.

Use scores from 0 to 3:
0 = no evidence or does not satisfy
1 = weak / unclear / partial
2 = mostly satisfies but needs confirmation or adaptation
3 = strong fit with useful evidence

Return ONLY valid JSON with this shape:
{
  "overallScore": number,
  "innovation": { "score": number, "explanation": "string", "evidence": ["string"] },
  "qualityOfSolution": { "score": number, "explanation": "string", "evidence": ["string"] },
  "accessibility": { "score": number, "explanation": "string", "evidence": ["string"] },
  "affordability": { "score": number, "explanation": "string", "evidence": ["string"] },
  "documentation": { "score": number, "explanation": "string", "evidence": ["string"] },
  "impact": { "score": number, "explanation": "string", "evidence": ["string"] },
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
- If the result is only keyword-related, give a low impact score.
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

    innovation: normalizeDimension(value.innovation, empty.innovation),
    qualityOfSolution: normalizeDimension(value.qualityOfSolution, empty.qualityOfSolution),
    accessibility: normalizeDimension(value.accessibility, empty.accessibility),
    affordability: normalizeDimension(value.affordability, empty.affordability),
    documentation: normalizeDimension(value.documentation, empty.documentation),
    impact: normalizeDimension(value.impact, empty.impact),

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
  // TOM publishes the six criteria without weights, so we treat them equally.
  const total =
    evaluation.innovation.score +
    evaluation.qualityOfSolution.score +
    evaluation.accessibility.score +
    evaluation.affordability.score +
    evaluation.documentation.score +
    evaluation.impact.score;

  return Math.round((total / 6) * 10) / 10;
}

function computeOverallFromDimensions(value: Record<string, unknown>) {
  const dimensions = [
    "innovation",
    "qualityOfSolution",
    "accessibility",
    "affordability",
    "documentation",
    "impact"
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