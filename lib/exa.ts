import {
  CandidateSourceType,
  ExaSearchResponse,
  ExaSearchResult,
  NeedProfile
} from "./types";

export async function searchExaProjects({
  query,
  needProfile,
  numResults = 15,
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

export async function fetchPrioritizedPool({
  query,
  needProfile,
  primaryPerDomain = 15,
  secondaryPerDomain = 3,
  commercialPerDomain = 2
}: {
  query: string;
  needProfile: NeedProfile;
  primaryPerDomain?: number;
  secondaryPerDomain?: number;
  commercialPerDomain?: number;
}): Promise<ExaSearchResult[]> {
  const primaryDomains = parseDomainList(process.env.EXA_PRIMARY_DOMAINS);
  const secondaryDomains = parseDomainList(process.env.EXA_SECONDARY_DOMAINS);
  const commercialDomains = parseDomainList(process.env.EXA_COMMERCIAL_DOMAINS);

  console.log("EXA domain groups", {
    primaryDomains,
    secondaryDomains,
    commercialDomains
  });

  // One Exa call per configured domain, across all three groups. That's
  // grown past what used to be a handful of domains to 10+ now that more
  // sources have been added - firing them all via unbounded Promise.all (as
  // three separate groups previously did) crossed Exa's 10-requests/second
  // plan limit, and a rate-limited call just silently returns [] for that
  // domain (searchExaProjects logs the error and swallows it) rather than
  // failing loudly. Run every domain through one shared concurrency-limited
  // queue instead, so no matter how many domains get added later, no more
  // than EXA_MAX_CONCURRENT_REQUESTS calls are ever in flight at once.
  const EXA_MAX_CONCURRENT_REQUESTS = 6;

  const domainJobs = [
    ...primaryDomains.map((domain) => ({ domain, perDomain: primaryPerDomain })),
    ...secondaryDomains.map((domain) => ({ domain, perDomain: secondaryPerDomain })),
    ...commercialDomains.map((domain) => ({ domain, perDomain: commercialPerDomain }))
  ];

  const domainResults = await mapWithConcurrencyLimit(
    domainJobs,
    EXA_MAX_CONCURRENT_REQUESTS,
    ({ domain, perDomain }) =>
      perDomain > 0
        ? searchExaProjects({
            query,
            needProfile,
            numResults: perDomain,
            includeDomainsOverride: [domain]
          })
        : Promise.resolve([])
  );

  const primaryResultsRaw = interleave(
    domainResults.slice(0, primaryDomains.length)
  );
  const secondaryResults = interleave(
    domainResults.slice(
      primaryDomains.length,
      primaryDomains.length + secondaryDomains.length
    )
  );
  const commercialResults = interleave(
    domainResults.slice(primaryDomains.length + secondaryDomains.length)
  );

  const primaryResults = primaryResultsRaw.filter((result) =>
    isTomProjectUrl(result.url || "")
  );

  console.log(
    "TOM primary raw results",
    primaryResultsRaw.map((result) => result.url)
  );

  console.log(
    "TOM primary project results",
    primaryResults.map((result) => result.url)
  );

  console.log("EXA result counts", {
    primaryRaw: primaryResultsRaw.length,
    primaryProjects: primaryResults.length,
    secondary: secondaryResults.length,
    commercial: commercialResults.length
  });

  const merged = [
    ...primaryResults,
    ...secondaryResults,
    ...commercialResults
  ];

  return dedupeByUrl(merged);
}

function isTomProjectUrl(url: string) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");

    return (
      hostname === "tomglobal.org" &&
      parsed.pathname === "/project" &&
      parsed.searchParams.has("id")
    );
  } catch {
    return false;
  }
}

function isTomDomainUrl(url: string) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");

    return hostname === "tomglobal.org";
  } catch {
    return false;
  }
}

function dedupeByUrl(results: ExaSearchResult[]) {
  const seen = new Set<string>();
  const deduped: ExaSearchResult[] = [];

  for (const result of results) {
    const key = normalizeUrlKey(result.url || result.id || result.title || "");

    if (!key || seen.has(key)) continue;

    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function normalizeUrlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().toLowerCase();
  }
}

// Runs `fn` over `items` with at most `limit` calls in flight at once,
// preserving input order in the returned array regardless of which call
// finishes first. Used to keep total simultaneous Exa requests under its
// per-second rate limit without capping how many domains can be searched.
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
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

  const location = [
    needProfile.location?.cityOrRegion,
    needProfile.location?.country,
  ]
    .filter(Boolean)
    .join(" ");

  const parts = [
    needProfile.activity,
    needProfile.problem,
    needProfile.desiredOutcome,

    needProfile.userAge ? `age ${needProfile.userAge}` : "",
    location,

    ...needProfile.userContext,
    ...needProfile.bodyFunction,
    ...needProfile.currentDevices,
    ...needProfile.environment,

    ...needProfile.mustHave,
    ...needProfile.preferences,
    ...needProfile.safetyConcerns,

    ...needProfile.mustAvoid.map((item) => `without ${item}`),

    "assistive technology",
    "adaptive device",
    "DIY",
    "open source",
    "TOM project",
  ];

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part) =>
        part !== "unknown activity" &&
        part !== "unknown problem" &&
        part !== "unknown desired outcome",
    )
    .join(" ");
}

export function detectSourceType(url: string): CandidateSourceType {
  const lower = url.toLowerCase();

  if (lower.includes("instructables.com")) return "DIY project";

  if (
    lower.includes("thingiverse.com") ||
    lower.includes("printables.com") ||
    lower.includes("github.com") ||
    lower.includes("atmakers.org") ||
    lower.includes("makersmakingchange.com") ||
    isTomProjectUrl(url) ||
    isTomDomainUrl(url)
  ) {
    // TOM's own site, but reached via the live Exa web-search layer, not the
    // curated CSV catalog (lib/tom.ts hardcodes sourceType: "TOM project"
    // for CSV rows, completely separate from this function). Deliberately
    // NOT "TOM project" here - isTomCandidate() in page.tsx groups by
    // sourceType, and mixing web-search hits into that section made it
    // impossible to tell whether this layer was contributing anything at
    // all (it silently blended into the CSV's 20 results). Filed under
    // "Other related work" instead so a live-search hit is visible on its
    // own, distinguishable from the CSV - temporary, for verifying this
    // layer actually works before deciding whether to fold it back in.
    return "open-source project";
  }

  if (
    lower.includes("amazon.") ||
    lower.includes("walmart.") ||
    lower.includes("etsy.") ||
    lower.includes("aliexpress.") ||
    lower.includes("enablingdevices.com")
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
- what activity it supports
- how it works
- whether it matches the user's age/location/context when relevant
- materials, tools, CAD files, STL files, or build instructions if available
- safety concerns
- cleaning, portability, compatibility, and maintenance
- missing documentation
- whether it matches this Need Profile:

${JSON.stringify(needProfile, null, 2)}
`;
}