import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  CandidateProject,
  emptyCandidateEvaluation,
  NeedProfile
} from "./types";

export const DEFAULT_TOM_CSV_PATH = "data/tom-global-solutions.csv";

const CSV_CACHE_TTL_MS = 60 * 1000;
const MIN_CSV_LOCAL_SCORE = 2;

type CsvCache = {
  path: string;
  mtime: number;
  rows: TomCsvRow[];
};

type TomCsvRow = {
  solutionName: string;
  link: string;
  summary: string;
  who: string;
  why: string;
  how: string;
  what: string;
  category: string;
  tags: string;
};

let csvCache: CsvCache | null = null;
let csvCacheReadAt = 0;

export function searchTomCsvProjects({
  needProfile,
  limit = 20,
  csvPath = process.env.TOM_PROJECTS_CSV_PATH || DEFAULT_TOM_CSV_PATH
}: {
  needProfile: NeedProfile;
  limit?: number;
  csvPath?: string;
}): CandidateProject[] {
  const rows = readTomCsvRows(csvPath);
  if (!rows.length) return [];

  const keywords = buildNeedKeywords(needProfile);
  const phrases = buildNeedPhrases(needProfile);

  return rows
    .map((row, index) => ({
      candidate: buildTomCsvCandidate(row, index, csvPath),
      score: scoreTomCsvRow(row, keywords, phrases)
    }))
    .filter(({ score }) => score >= MIN_CSV_LOCAL_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function readTomCsvRows(csvPath: string): TomCsvRow[] {
  const resolvedPath = resolveCsvPath(csvPath);

  if (!existsSync(resolvedPath)) return [];

  const now = Date.now();
  const fileStats = statSync(resolvedPath);
  const mtime = fileStats.mtimeMs;

  if (
    csvCache &&
    csvCache.path === resolvedPath &&
    csvCache.mtime === mtime &&
    now - csvCacheReadAt < CSV_CACHE_TTL_MS
  ) {
    return csvCache.rows;
  }

  const rows = parseTomCsv(readFileSync(resolvedPath, "utf8"));
  csvCache = { path: resolvedPath, mtime, rows };
  csvCacheReadAt = now;

  console.log("TOM CSV loaded", {
    file: basename(resolvedPath),
    rows: rows.length
  });

  return rows;
}

function resolveCsvPath(csvPath: string) {
  if (isAbsolute(csvPath)) return csvPath;

  const normalizedPath = csvPath.replace(/^\.\//, "");
  if (normalizedPath.startsWith("data/")) {
    return join(process.cwd(), "data", normalizedPath.slice("data/".length));
  }

  return join(/* turbopackIgnore: true */ process.cwd(), normalizedPath);
}

function parseTomCsv(csvText: string): TomCsvRow[] {
  const records = parseDelimitedText(csvText.replace(/^\uFEFF/, ""));
  if (records.length < 2) return [];

  const headers = records[0].map(normalizeHeader);

  return records
    .slice(1)
    .map((record) => {
      const get = (name: string) => record[headers.indexOf(name)]?.trim() || "";

      return {
        solutionName: get("solution name") || get("solution"),
        link: get("link"),
        summary: get("summary"),
        who: get("who"),
        why: get("why"),
        how: get("how"),
        what: get("what"),
        category: get("category"),
        tags: get("tags")
      };
    })
    .filter((row) => row.solutionName || row.summary || row.link);
}

function parseDelimitedText(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((record) => record.some((value) => value.trim()));
}

function detectDelimiter(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;

  return tabs > commas ? "\t" : ",";
}

function buildTomCsvCandidate(
  row: TomCsvRow,
  index: number,
  csvPath: string
): CandidateProject {
  const title = row.solutionName || row.what || "Untitled TOM solution";
  const rawText = [
    `Solution Name: ${row.solutionName}`,
    `Summary: ${row.summary}`,
    `Who: ${row.who}`,
    `Why: ${row.why}`,
    `How: ${row.how}`,
    `What: ${row.what}`,
    `Category: ${row.category}`,
    `Tags: ${row.tags}`
  ]
    .filter((line) => !line.endsWith(": "))
    .join("\n");

  return {
    id: `tom-csv-${slugify(title)}-${index}`,
    title,
    url: row.link || "https://tomglobal.org/projects",
    source: `TOM CSV (${basename(csvPath)})`,
    sourceType: "TOM project",
    summary: row.summary || row.why || row.what || rawText,
    rawText,
    evaluation: emptyCandidateEvaluation()
  };
}

function scoreTomCsvRow(row: TomCsvRow, keywords: string[], phrases: string[]) {
  const title = row.solutionName.toLowerCase();
  const highValueText = [row.summary, row.why, row.what, row.tags, row.category]
    .join(" ")
    .toLowerCase();
  const allText = [highValueText, row.who, row.how].join(" ").toLowerCase();

  let score = 0;

  for (const phrase of phrases) {
    if (title.includes(phrase)) score += 8;
    else if (highValueText.includes(phrase)) score += 4;
    else if (allText.includes(phrase)) score += 2;
  }

  for (const keyword of keywords) {
    if (title.includes(keyword)) score += 4;
    else if (highValueText.includes(keyword)) score += 2;
    else if (allText.includes(keyword)) score += 1;
  }

  return score;
}

function buildNeedPhrases(needProfile: NeedProfile) {
  return [
    needProfile.activity,
    needProfile.problem,
    needProfile.desiredOutcome,
    ...needProfile.currentDevices,
    ...needProfile.bodyFunction,
    ...needProfile.mustHave,
    ...needProfile.preferences,
    ...needProfile.searchDirections
  ]
    .map((phrase) => phrase.toLowerCase().trim())
    .filter((phrase) => phrase.length >= 3 && phrase !== "unknown")
    .slice(0, 20);
}

function buildNeedKeywords(needProfile: NeedProfile) {
  const stopwords = new Set([
    "about",
    "after",
    "also",
    "and",
    "assistive",
    "device",
    "easy",
    "for",
    "from",
    "have",
    "help",
    "need",
    "needs",
    "person",
    "solution",
    "technology",
    "that",
    "the",
    "this",
    "unknown",
    "user",
    "using",
    "with",
    "without"
  ]);

  return Array.from(
    new Set(
      buildNeedPhrases(needProfile)
        .join(" ")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 4)
        .filter((word) => !stopwords.has(word))
    )
  ).slice(0, 40);
}

function normalizeHeader(header: string) {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
