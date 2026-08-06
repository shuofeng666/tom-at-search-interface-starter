import fs from "node:fs";
import path from "node:path";
import {
  CandidateProject,
  emptyCandidateEvaluation,
  NeedProfile
} from "./types";
import { generateGeminiJson, toStringArray } from "./gemini";

// TOM's own search API did literal keyword matching against a live endpoint,
// which was slow (one HTTP round trip per guessed keyword), incomplete (only
// ever sampled a page of results at a time), and frequently missed projects
// whose title/description just didn't contain the exact guessed word (e.g. a
// project literally named "Lefty - One Hand Diaper Changer" never surfaced
// for "diaper" style queries). This is now a static export TOM provided
// (data/tom-solutions.csv) that we load once and score entirely locally —
// no network calls, no guessing, no missed pages.
const CSV_PATH = path.join(process.cwd(), "data", "tom-solutions.csv");
const CSV_META_PATH = path.join(
  process.cwd(),
  "data",
  "tom-solutions.meta.json"
);

let catalogCache: CandidateProject[] | null = null;
let catalogFetchInFlight: Promise<CandidateProject[]> | null = null;
let snapshotDateCache: string | null | undefined;

// The date TOM exported data/tom-solutions.csv, so the UI can be upfront
// that this is a snapshot, not a live feed. Update data/tom-solutions.meta.json
// whenever the CSV is refreshed; falls back to the CSV file's own mtime if
// that metadata file is missing.
export function getTomCatalogSnapshotDate(): string | null {
  if (snapshotDateCache !== undefined) return snapshotDateCache;

  try {
    const raw = fs.readFileSync(CSV_META_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { snapshotDate?: string };

    if (parsed.snapshotDate) {
      snapshotDateCache = parsed.snapshotDate;
      return snapshotDateCache;
    }
  } catch {
    // fall through to mtime
  }

  try {
    snapshotDateCache = fs
      .statSync(CSV_PATH)
      .mtime.toISOString()
      .slice(0, 10);
  } catch {
    snapshotDateCache = null;
  }

  return snapshotDateCache;
}

export async function searchTomProjects({
  needProfile,
  limit = 15
}: {
  needProfile: NeedProfile;
  limit?: number;
}): Promise<CandidateProject[]> {
  const catalog = await getTomCatalog();

  if (!catalog.length) {
    console.warn(
      `TOM solutions catalog is empty. Check ${CSV_PATH} exists and is readable.`
    );
    return [];
  }

  const expandedTerms = await expandTomSearchTerms(needProfile);
  const keywords = buildLocalMatchTerms(needProfile);

  const ranked = rankTomCandidatesByNeed(catalog, keywords, expandedTerms);
  const topCandidates = ranked.slice(0, limit);

  // Only fetch photos for the handful of candidates we're actually about to
  // show (not the whole catalog) — see attachTomImages for why.
  const withImages = await attachTomImages(topCandidates);

  console.log("TOM catalog match", {
    catalogSize: catalog.length,
    expandedTerms,
    keywords,
    top: withImages.map((candidate) => candidate.title),
    withImages: withImages.filter((candidate) => candidate.image).length
  });

  return withImages;
}

async function getTomCatalog(): Promise<CandidateProject[]> {
  if (catalogCache) return catalogCache;
  if (catalogFetchInFlight) return catalogFetchInFlight;

  catalogFetchInFlight = (async () => {
    try {
      const raw = fs.readFileSync(CSV_PATH, "utf-8");
      const rows = parseCsv(raw);
      const records = rowsToRecords(rows);

      const items = records
        .map(buildTomCandidateFromRecord)
        .filter((candidate): candidate is CandidateProject => candidate !== null);

      console.log("TOM catalog loaded", { rows: items.length });

      catalogCache = items;
      return items;
    } catch (error) {
      console.error("Failed to load TOM solutions CSV:", error);
      catalogCache = [];
      return catalogCache;
    } finally {
      catalogFetchInFlight = null;
    }
  })();

  return catalogFetchInFlight;
}

type TomImageProject = {
  _id: string;
  imagesUrls?: string[];
  thumbnailImageUrl?: string;
  additionalInformation?: {
    challengeImage?: string;
  };
};

type TomImageSearchResponse = {
  projects?: {
    items?: TomImageProject[];
  };
};

const IMAGE_LOOKUP_TTL_MS = 30 * 60 * 1000;
const IMAGE_FETCH_TIMEOUT_MS = 4000;

type ImageLookupEntry = { images: string[] | null; fetchedAt: number };
const imageLookupCache = new Map<string, ImageLookupEntry>();

// The CSV export has no image columns, but TOM's own project data does
// (imagesUrls / thumbnailImageUrl). An earlier version of this fetched
// TOM's ENTIRE catalog's images up front (paginating hundreds of items)
// before a search could return anything — on a serverless function that
// risks the platform timing the whole request out before it ever gets to
// scoring, which silently drops images with no visible error. This instead
// only looks up images for the ~20 candidates a search is actually about to
// show, one small targeted request per candidate, run in parallel with a
// short per-request timeout so one slow lookup can't stall the rest. A no-op
// if TOM_SEARCH_API_URL isn't configured; never affects search/ranking,
// which is CSV-only (see searchTomProjects above).
async function attachTomImages(
  candidates: CandidateProject[]
): Promise<CandidateProject[]> {
  const endpoint = process.env.TOM_SEARCH_API_URL;
  if (!endpoint) return candidates;

  const results = await Promise.allSettled(
    candidates.map((candidate) =>
      getTomProjectImages(endpoint, candidate.id, candidate.title)
    )
  );

  return candidates.map((candidate, index) => {
    const result = results[index];
    const images = result.status === "fulfilled" ? result.value : null;
    if (!images || !images.length) return candidate;
    return { ...candidate, image: images[0], images };
  });
}

async function getTomProjectImages(
  endpoint: string,
  id: string,
  title: string
): Promise<string[] | null> {
  const cached = imageLookupCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < IMAGE_LOOKUP_TTL_MS) {
    return cached.images;
  }

  const images = await fetchTomProjectImages(endpoint, id, title);
  imageLookupCache.set(id, { images, fetchedAt: Date.now() });
  return images;
}

async function fetchTomProjectImages(
  endpoint: string,
  id: string,
  title: string
): Promise<string[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const url = new URL(endpoint);
    url.searchParams.set("skip", "0");
    url.searchParams.set("limit", "5");
    url.searchParams.set("selectedTypes", "5");
    url.searchParams.set("userInput", title);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });

    if (!res.ok) {
      console.error("TOM image lookup API error:", res.status, title);
      return null;
    }

    const data = (await res.json()) as TomImageSearchResponse;
    const items = data.projects?.items || [];

    // Only trust an exact id match — a keyword search on the title can
    // return other projects too, and attaching the wrong project's photo
    // to this one would be worse than no photo.
    const match = items.find((item) => item._id === id);
    if (!match) return null;

    const images = Array.from(
      new Set(
        [
          ...(match.imagesUrls || []),
          match.additionalInformation?.challengeImage,
          match.thumbnailImageUrl
        ].filter((value): value is string => Boolean(value))
      )
    );

    return images.length ? images : null;
  } catch (error) {
    console.error("TOM image lookup failed for", title, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function rankTomCandidatesByNeed(
  candidates: CandidateProject[],
  keywords: string[],
  expandedTerms: string[]
) {
  if (!keywords.length && !expandedTerms.length) return candidates;

  const termWeights = buildTermSpecificityWeights(candidates, [
    ...expandedTerms,
    ...keywords
  ]);

  return [...candidates].sort(
    (a, b) =>
      scoreTomCandidate(b, keywords, expandedTerms, termWeights) -
      scoreTomCandidate(a, keywords, expandedTerms, termWeights)
  );
}

// Common words ("mobility", "home", "independently") show up across a big
// share of a disability-project catalog and carry little discriminative
// value; rare/specific words ("diaper", "card holder") are strong signals.
// Weight each term by how unusual it is *within this catalog* so a title
// match on a rare term counts far more than one on a term half the catalog
// happens to mention — otherwise something like "Toddler Mobility Trainer"
// can out-rank an actual wheelchair project just because "mobility" and
// "home" are everywhere in a disability-project catalog.
function buildTermSpecificityWeights(
  catalog: CandidateProject[],
  terms: string[]
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const term of new Set(terms)) {
    let docCount = 0;

    for (const candidate of catalog) {
      const text = `${candidate.title} ${candidate.summary} ${candidate.rawText}`.toLowerCase();
      if (text.includes(term)) docCount += 1;
    }

    const ratio = docCount / catalog.length;

    let weight = 1;
    if (ratio >= 0.15) weight = 0.2;
    else if (ratio >= 0.08) weight = 0.45;
    else if (ratio >= 0.03) weight = 0.75;

    weights.set(term, weight);
  }

  return weights;
}

function scoreTomCandidate(
  candidate: CandidateProject,
  keywords: string[],
  expandedTerms: string[],
  termWeights: Map<string, number>
) {
  const title = candidate.title.toLowerCase();
  const body = [candidate.summary, candidate.rawText].join(" ").toLowerCase();

  let score = 0;

  // LLM-expanded category phrases are the strongest relevance signal: a
  // title literally containing "cup holder" is almost certainly on-topic.
  for (const term of expandedTerms) {
    const weight = termWeights.get(term) ?? 1;
    if (title.includes(term)) score += 6 * weight;
    else if (body.includes(term)) score += 2 * weight;
  }

  for (const keyword of keywords) {
    const weight = termWeights.get(keyword) ?? 1;
    if (title.includes(keyword)) score += 3 * weight;
    else if (body.includes(keyword)) score += 1 * weight;
  }

  return score;
}

/**
 * Local match terms: device/body-function phrases kept whole (the strongest
 * signal, e.g. "manual wheelchair"), plus single high-value words pulled from
 * the rest of the need profile.
 */
function buildLocalMatchTerms(needProfile: NeedProfile): string[] {
  const terms: string[] = [];

  const push = (term?: string) => {
    const clean = (term || "").trim().toLowerCase();
    if (!clean || clean.length < 3 || clean.length > 60) return;
    if (!terms.includes(clean)) terms.push(clean);
  };

  for (const device of needProfile.currentDevices) push(device);
  for (const fn of needProfile.bodyFunction) push(fn);
  for (const keyword of buildTomKeywords(needProfile)) push(keyword);

  return terms;
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
    "small database (~500 items) of open-source maker projects. The database",
    "is matched by simple literal keyword overlap against project titles and",
    "descriptions, not semantic search.",
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

type TomSolutionRecord = {
  name: string;
  link: string;
  summary: string;
  who: string;
  why: string;
  how: string;
  what: string;
  category: string;
  tags: string;
};

function rowsToRecords(rows: string[][]): TomSolutionRecord[] {
  if (rows.length < 2) return [];

  const [header, ...dataRows] = rows;
  const indexOf = (name: string) =>
    header.findIndex((cell) => cell.trim().toLowerCase() === name.toLowerCase());

  const columns = {
    name: indexOf("Solution Name"),
    link: indexOf("Link"),
    summary: indexOf("Summary"),
    who: indexOf("Who"),
    why: indexOf("Why"),
    how: indexOf("How"),
    what: indexOf("What"),
    category: indexOf("Category"),
    tags: indexOf("Tags")
  };

  const cell = (row: string[], index: number) =>
    index >= 0 ? (row[index] || "").trim() : "";

  return dataRows
    .filter((row) => row.length > 1)
    .map((row) => ({
      name: cell(row, columns.name),
      link: cell(row, columns.link),
      summary: cell(row, columns.summary),
      who: cell(row, columns.who),
      why: cell(row, columns.why),
      how: cell(row, columns.how),
      what: cell(row, columns.what),
      category: cell(row, columns.category),
      tags: cell(row, columns.tags)
    }))
    .filter((record) => record.name && record.link);
}

function buildTomCandidateFromRecord(
  record: TomSolutionRecord
): CandidateProject | null {
  const id = extractProjectId(record.link) || stableId(record.link);
  if (!id) return null;

  const rawText = [
    record.name,
    record.summary,
    record.who ? `Who: ${record.who}` : "",
    record.why ? `Why: ${record.why}` : "",
    record.how ? `How: ${record.how}` : "",
    record.what ? `What: ${record.what}` : "",
    record.category ? `Category: ${record.category}` : "",
    record.tags ? `Tags: ${record.tags}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    id,
    title: record.name,
    url: record.link,
    source: "tomglobal.org",
    sourceType: "TOM project",
    image: undefined,
    images: undefined,
    summary: record.summary || trimText(rawText, 420),
    rawText,
    category: record.category || undefined,
    evaluation: emptyCandidateEvaluation()
  };
}

function extractProjectId(url: string): string | null {
  try {
    return new URL(url).searchParams.get("id");
  } catch {
    return null;
  }
}

// Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas,
// embedded newlines, and "" escaped quotes. Good enough for a static export
// we control; not meant as a general-purpose CSV library.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\r") continue;

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function stableId(value: string) {
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }

  return `tom-${Math.abs(hash)}`;
}

function trimText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}
