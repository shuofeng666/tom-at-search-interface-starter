import {
  CandidateSourceType,
  ExaSearchResponse,
  ExaSearchResult,
  NeedProfile
} from "./types";

export async function searchExaProjects({
  query,
  needProfile,
  numResults = 8,
  includeDomainsOverride
}: {
  query: string;
  needProfile: NeedProfile;
  numResults?: number;
  includeDomainsOverride?: string[];
}): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    return [];
  }

  const includeDomains =
    includeDomainsOverride ?? parseDomainList(process.env.EXA_INCLUDE_DOMAINS);

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      query,
      numResults,
      includeDomains: includeDomains.length ? includeDomains : undefined,
      contents: {
        text: {
          maxCharacters: 4000
        },
        highlights: {
          numSentences: 3
        },
        summary: {
          query: buildSummaryInstruction(needProfile)
        },
        extras: {
          imageLinks: 8
        }
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Exa API error:", text);
    return [];
  }

  const data = (await res.json()) as ExaSearchResponse;
  return data.results || [];
}

// Fetch a few results from EACH configured source (one Exa call per domain),
// then interleave them round-robin so the pool isn't dominated by one site.
// This is fast (Exa calls only, no scoring) and guarantees source diversity by
// construction. Scoring happens later, in pages, via the /api/evaluate route.
export async function fetchPoolPerDomain({
  query,
  needProfile,
  perDomain = 4
}: {
  query: string;
  needProfile: NeedProfile;
  perDomain?: number;
}): Promise<ExaSearchResult[]> {
  const domains = parseDomainList(process.env.EXA_INCLUDE_DOMAINS);

  // No domain restriction configured -> fall back to one global search.
  if (!domains.length) {
    return searchExaProjects({ query, needProfile, numResults: perDomain * 4 });
  }

  const perDomainResults = await Promise.all(
    domains.map((domain) =>
      searchExaProjects({
        query,
        needProfile,
        numResults: perDomain,
        includeDomainsOverride: [domain]
      })
    )
  );

  return interleave(perDomainResults);
}

// Round-robin merge: [a1,a2], [b1,b2,b3], [c1] -> a1,b1,c1,a2,b2,b3
function interleave<T>(groups: T[][]): T[] {
  const merged: T[] = [];
  const maxLen = groups.reduce((max, group) => Math.max(max, group.length), 0);

  for (let i = 0; i < maxLen; i += 1) {
    for (const group of groups) {
      if (i < group.length) merged.push(group[i]);
    }
  }

  return merged;
}

export function buildSearchQuery(needProfile: NeedProfile, customQuery?: string) {
  if (customQuery && customQuery.trim()) {
    return customQuery.trim();
  }

  const parts = [
    needProfile.activity,
    needProfile.problem,
    ...needProfile.userContext,
    ...needProfile.environment,
    ...needProfile.mustHave,
    ...needProfile.mustAvoid.map((item) => `without ${item}`),
    "assistive technology",
    "adaptive device",
    "DIY",
    "open source",
    "TOM project"
  ];

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "unknown activity" && part !== "unknown problem")
    .join(" ");
}

export function detectSourceType(url: string): CandidateSourceType {
  const lower = url.toLowerCase();

  if (lower.includes("tomchallenge.org")) return "TOM project";
  if (lower.includes("instructables.com")) return "DIY project";
  if (
    lower.includes("thingiverse.com") ||
    lower.includes("printables.com") ||
    lower.includes("github.com")
  ) {
    return "open-source project";
  }
  if (
    lower.includes("amazon.") ||
    lower.includes("walmart.") ||
    lower.includes("etsy.") ||
    lower.includes("aliexpress.")
  ) {
    return "commercial product";
  }
  if (
    lower.includes("pubmed") ||
    lower.includes("acm.org") ||
    lower.includes("ieee") ||
    lower.includes("springer")
  ) {
    return "research prototype";
  }

  return "unknown";
}

export function sourceLabelFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown source";
  }
}

function parseDomainList(value?: string) {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSummaryInstruction(needProfile: NeedProfile) {
  return `
Summarize this page for a TOM assistive technology reviewer.
Focus on:
- what problem the project/product solves
- who it is for
- how it works
- materials, tools, or files if available
- safety concerns
- missing documentation
- whether it matches this need:
${JSON.stringify(needProfile)}
`;
}