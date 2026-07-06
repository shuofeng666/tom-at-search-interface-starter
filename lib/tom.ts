import {
  CandidateProject,
  emptyCandidateEvaluation,
  NeedProfile
} from "./types";
import { generateGeminiJson, toStringArray } from "./gemini";

type TomSearchResponse = {
  projects?: {
    totalNumberOfPages?: number;
    items?: TomProject[];
  };
};

type TomProject = {
  _id: string;
  projectName?: string;
  challengeName?: string;
  description?: string;
  resources?: string;
  downloadLink?: string;
  thumbnailImageUrl?: string;
  imagesUrls?: string[];
  type?: number;
  technicalRequirements?: string[];
  additionalInformation?: {
    challengeDetails?: string;
    disabledPersonDetails?: string;
    teamRequirements?: string;
    teamName?: string;
    challengeImage?: string;
  };
};

const MIN_TOM_RESULTS = 3;
const MIN_FALLBACK_LOCAL_SCORE = 3;
const MAX_KEYWORD_QUERIES = 8;

export async function searchTomProjects({
  needProfile,
  limit = 15
}: {
  needProfile: NeedProfile;
  limit?: number;
}): Promise<CandidateProject[]> {
  const endpoint = process.env.TOM_SEARCH_API_URL;

  if (!endpoint) {
    console.warn("Missing TOM_SEARCH_API_URL. TOM projects will be skipped.");
    return [];
  }

  const expandedTerms = await expandTomSearchTerms(needProfile);
  const heuristicTerms = buildTomSearchTerms(needProfile);

  const keywordQueries = dedupeTerms([
    ...expandedTerms,
    ...heuristicTerms
  ]).slice(0, MAX_KEYWORD_QUERIES);

  console.log("TOM keyword queries", {
    fromLLM: expandedTerms,
    fromHeuristic: heuristicTerms,
    used: keywordQueries
  });

  const keywordBatches = await Promise.all(
    keywordQueries.map((userInput) =>
      fetchTomProjectCandidates({ endpoint, userInput, limit })
    )
  );

  const keywordMatched = mergeTomCandidates(keywordBatches.flat(), []);

  let merged = keywordMatched;

  if (merged.length < MIN_TOM_RESULTS) {
    const broadBatch = await fetchTomProjectCandidates({
      endpoint,
      userInput: "",
      limit
    });

    const fallbackRanked = rankTomCandidatesByNeed(
      broadBatch,
      needProfile,
      expandedTerms
    ).filter((candidate) => {
      return (
        scoreTomCandidate(
          candidate,
          buildTomKeywords(needProfile),
          expandedTerms
        ) >= MIN_FALLBACK_LOCAL_SCORE
      );
    });

    merged = mergeTomCandidates(merged, fallbackRanked);
  }

  const ranked = rankTomCandidatesByNeed(merged, needProfile, expandedTerms);

  console.log("TOM merged/ranked results", {
    keywordMatched: keywordMatched.length,
    returned: ranked.slice(0, limit).length
  });

  return ranked.slice(0, limit);
}

/**
 * Short, high-recall search terms. TOM search works best with single nouns
 * ("wheelchair", "walker", "grip") or two-word device names.
 */
function buildTomSearchTerms(needProfile: NeedProfile): string[] {
  const terms: string[] = [];

  const push = (term: string | undefined) => {
    const clean = (term || "").trim().toLowerCase();
    if (!clean) return;
    if (clean.length < 3 || clean.length > 40) return;
    if (GENERIC_TERMS.has(clean)) return;
    if (!terms.includes(clean)) terms.push(clean);
  };

  // 1) Device names are the strongest signal: use the full phrase AND its
  //    head noun ("manual wheelchair" -> "manual wheelchair", "wheelchair").
  for (const device of needProfile.currentDevices) {
    push(device);
    const words = device.trim().split(/\s+/);
    if (words.length > 1) push(words[words.length - 1]);
  }

  // 2) Body function terms often map to TOM categories ("grip", "hand").
  for (const fn of needProfile.bodyFunction) {
    const words = fn.trim().split(/\s+/);
    if (words.length <= 2) push(fn);
    for (const word of words) push(word);
  }

  // 3) High-value single words from the rest of the profile.
  for (const keyword of buildTomKeywords(needProfile)) {
    push(keyword);
  }

  return terms.slice(0, MAX_KEYWORD_QUERIES);
}

// Words that are true but useless as TOM search terms.
const GENERIC_TERMS = new Set([
  "device",
  "devices",
  "solution",
  "assistive",
  "adaptive",
  "technology",
  "equipment",
  "manual",
  "electric",
  "help",
  "daily",
  "independence",
  "independent",
  "unknown",
  "none"
]);

function rankTomCandidatesByNeed(
  candidates: CandidateProject[],
  needProfile: NeedProfile,
  expandedTerms: string[] = []
) {
  const keywords = buildTomKeywords(needProfile);

  if (!keywords.length && !expandedTerms.length) return candidates;

  return [...candidates].sort((a, b) => {
    return (
      scoreTomCandidate(b, keywords, expandedTerms) -
      scoreTomCandidate(a, keywords, expandedTerms)
    );
  });
}

function scoreTomCandidate(
  candidate: CandidateProject,
  keywords: string[],
  expandedTerms: string[] = []
) {
  const title = candidate.title.toLowerCase();
  const body = [candidate.summary, candidate.rawText].join(" ").toLowerCase();

  let score = 0;

  // LLM-expanded category phrases are the strongest relevance signal:
  // a title literally containing "cup holder" is almost certainly on-topic.
  for (const term of expandedTerms) {
    if (title.includes(term)) score += 6;
    else if (body.includes(term)) score += 2;
  }

  for (const keyword of keywords) {
    if (title.includes(keyword)) score += 3;
    else if (body.includes(keyword)) score += 1;
  }

  return score;
}

/**
 * One cheap Gemini call: need profile -> concrete device-category search
 * terms. Cached per profile so "load more" / re-renders don't re-call it.
 */
const expansionCache = new Map<string, string[]>();

async function expandTomSearchTerms(
  needProfile: NeedProfile
): Promise<string[]> {
  const cacheKey = JSON.stringify([
    needProfile.activity,
    needProfile.problem,
    needProfile.desiredOutcome,
    needProfile.currentDevices,
    needProfile.bodyFunction,
    needProfile.mustHave
  ]);

  const cached = expansionCache.get(cacheKey);
  if (cached) return cached;

  const prompt = [
    "You translate an assistive-technology need into search keywords for a",
    "small database (~1000 items) of open-source maker projects. The",
    "database search only matches short literal keywords against project",
    "titles and descriptions.",
    "",
    "Return JSON: {\"terms\": [...]} with 5-8 search terms. Rules:",
    "- Each term is 1-3 words, lowercase, English.",
    "- Each term names a CONCRETE product/device category, attachment, or",
    "  mechanism that could solve the need. Include synonyms.",
    "- Think like a maker naming a project, not like the user describing",
    "  the problem.",
    "",
    "Example need: 'hold a phone or a drink hands-free while propelling a",
    "manual wheelchair' ->",
    "{\"terms\": [\"cup holder\", \"phone mount\", \"phone holder\",",
    "\"bottle holder\", \"wheelchair attachment\", \"wheelchair tray\"]}",
    "",
    "Need profile:",
    `- activity: ${needProfile.activity}`,
    `- problem: ${needProfile.problem}`,
    `- desired outcome: ${needProfile.desiredOutcome}`,
    `- current devices: ${needProfile.currentDevices.join(", ") || "none"}`,
    `- body function: ${needProfile.bodyFunction.join(", ") || "unknown"}`,
    `- must have: ${needProfile.mustHave.join(", ") || "none"}`
  ].join("\n");

  try {
    const parsed = await generateGeminiJson<{ terms?: unknown }>({
      prompt,
      temperature: 0.3
    });

    const terms = toStringArray(parsed?.terms)
      .map((term) => term.toLowerCase().trim())
      .filter((term) => term.length >= 3 && term.length <= 30)
      .slice(0, 8);

    expansionCache.set(cacheKey, terms);
    return terms;
  } catch (error) {
    console.error("TOM query expansion failed, using heuristics only", error);
    return [];
  }
}

function dedupeTerms(terms: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.toLowerCase().trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function buildTomKeywords(needProfile: NeedProfile) {
  const rawText = [
    needProfile.activity,
    needProfile.problem,
    needProfile.desiredOutcome,
    ...needProfile.currentDevices,
    ...needProfile.bodyFunction,
    ...needProfile.mustHave,
    ...needProfile.preferences
  ]
    .join(" ")
    .toLowerCase();

  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "without",
    "assistive",
    "adaptive",
    "device",
    "solution",
    "user",
    "person",
    "people",
    "need",
    "needs",
    "use",
    "using",
    "easy",
    "attach",
    "remove",
    "when",
    "while",
    "unknown"
  ]);

  return Array.from(
    new Set(
      rawText
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 4)
        .filter((word) => !stopwords.has(word))
    )
  ).slice(0, 12);
}

async function fetchTomProjectCandidates({
  endpoint,
  userInput,
  limit
}: {
  endpoint: string;
  userInput: string;
  limit: number;
}): Promise<CandidateProject[]> {
  try {
    const url = new URL(endpoint);

    url.searchParams.set("skip", "0");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("selectedTypes", "5");
    url.searchParams.set("userInput", userInput);

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("TOM API error:", res.status, text.slice(0, 300));
      return [];
    }

    const data = (await res.json()) as TomSearchResponse;
    const items = data.projects?.items || [];

    console.log(
      `TOM query "${userInput || "(broad fallback)"}" ->`,
      items.map((item) => item.projectName || item.challengeName)
    );

    return items.map(buildTomCandidate);
  } catch (error) {
    console.error("TOM fetch failed for query:", userInput, error);
    return [];
  }
}

function buildTomCandidate(project: TomProject): CandidateProject {
  const title =
    project.projectName ||
    project.challengeName ||
    project.additionalInformation?.teamName ||
    "Untitled TOM project";

  const url = `https://tomglobal.org/project?id=${project._id}`;

  const image =
    project.imagesUrls?.[0] ||
    project.additionalInformation?.challengeImage ||
    project.thumbnailImageUrl ||
    undefined;

  const rawText = [
    title,
    project.challengeName,
    project.description,
    project.additionalInformation?.disabledPersonDetails,
    project.additionalInformation?.challengeDetails,
    project.additionalInformation?.teamRequirements,
    project.technicalRequirements?.length
      ? `Technical requirements: ${project.technicalRequirements.join(", ")}`
      : "",
    project.downloadLink ? `Download link: ${project.downloadLink}` : "",
    stripHtml(project.resources || "")
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    id: project._id,
    title,
    url,
    source: "tomglobal.org",
    sourceType: "TOM project",
    image,
    summary:
      project.description ||
      project.additionalInformation?.challengeDetails ||
      trimText(rawText, 420),
    rawText,
    evaluation: emptyCandidateEvaluation()
  };
}

function mergeTomCandidates(
  primary: CandidateProject[],
  fallback: CandidateProject[]
) {
  const seen = new Set<string>();
  const merged: CandidateProject[] = [];

  for (const candidate of [...primary, ...fallback]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
  }

  return merged;
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}