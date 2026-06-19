import {
  CandidateSourceType,
  ExaSearchResponse,
  ExaSearchResult,
  NeedProfile
} from "./types";

export async function searchExaProjects({
  query,
  needProfile,
  numResults = 8
}: {
  query: string;
  needProfile: NeedProfile;
  numResults?: number;
}): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    return [];
  }

  const includeDomains = parseDomainList(process.env.EXA_INCLUDE_DOMAINS);

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