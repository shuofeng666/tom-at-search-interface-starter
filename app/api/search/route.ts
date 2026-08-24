import { NextRequest, NextResponse } from "next/server";
import { buildSearchQuery, fetchPrioritizedPool } from "@/lib/exa";
import { buildCandidatesFromExa } from "@/lib/evaluate";
import { getTomCatalogSnapshotDate, searchTomProjects } from "@/lib/tom";
import { CandidateProject, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

// Phase 1: FETCH ONLY. Pull a pool from TOM + external sources.
// The frontend scores PAGE_SIZE candidates at a time via /api/evaluate.
const TOM_LIMIT = 20;
// Live Exa search of tomglobal.org (EXA_PRIMARY_DOMAINS) is now the
// preferred source for TOM candidates - see the priority ordering below.
// Fetch a decent-sized batch so it has a real chance of covering
// MIN_TOM_VISIBLE_TARGET (app/page.tsx) on its own before the CSV catalog
// ever needs to fill in.
const PRIMARY_PER_DOMAIN = 12;
const SECONDARY_PER_DOMAIN = 3;
const COMMERCIAL_PER_DOMAIN = 3;

const FIRST_PAGE_SIZE = 10;
const TOM_FIRST_PAGE_SLOTS = 5;

export type SearchPoolResponse = {
  query: string;
  pool: CandidateProject[];
  tomCatalogSnapshotDate: string | null;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile | undefined;
    const customQuery = typeof body.query === "string" ? body.query : undefined;

    if (!needProfile) {
      return NextResponse.json(
        { error: "Missing needProfile." },
        { status: 400 }
      );
    }

    if (!process.env.EXA_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Missing EXA_API_KEY. Add it to .env.local and restart the dev server."
        },
        { status: 500 }
      );
    }

    const query = buildSearchQuery(needProfile, customQuery);

    const [csvTomCandidates, exaResults] = await Promise.all([
      searchTomProjects({
        needProfile,
        limit: TOM_LIMIT
      }),
      fetchPrioritizedPool({
        query,
        needProfile,
        primaryPerDomain: PRIMARY_PER_DOMAIN,
        secondaryPerDomain: SECONDARY_PER_DOMAIN,
        commercialPerDomain: COMMERCIAL_PER_DOMAIN
      })
    ]);

    const exaCandidates = buildCandidatesFromExa(exaResults);

    // TOM candidates come from two places now: live Exa search of
    // tomglobal.org (part of exaCandidates, sourceType "TOM project" - see
    // detectSourceType) and the CSV catalog. Live search is the preferred
    // source - put it first so buildBalancedSearchPool's first page draws
    // from it before the CSV, and the CSV only ever gets scored/shown if
    // live search didn't turn up enough to satisfy the frontend's
    // MIN_TOM_VISIBLE_TARGET guarantee (app/page.tsx).
    const liveTomCandidates = exaCandidates.filter(
      (candidate) => candidate.sourceType === "TOM project"
    );
    const externalCandidates = exaCandidates.filter(
      (candidate) => candidate.sourceType !== "TOM project"
    );
    // dedupeCandidatesById (in buildBalancedSearchPool) dedupes by
    // candidate.id, but a live-search candidate's id is Exa's own result id
    // while a CSV candidate's id is the project id extracted from its URL -
    // different strings for the exact same TOM project, so that dedupe pass
    // alone wouldn't catch the same project showing up from both sources.
    // Drop CSV rows whose underlying tomglobal.org project id is already
    // covered by a live-search hit, since live search is preferred.
    const liveTomProjectIds = new Set(
      liveTomCandidates
        .map((candidate) => extractTomProjectId(candidate.url))
        .filter((id): id is string => id !== null)
    );
    const csvTomCandidatesNotAlreadyLive = csvTomCandidates.filter((candidate) => {
      const projectId = extractTomProjectId(candidate.url);
      return !projectId || !liveTomProjectIds.has(projectId);
    });

    const tomCandidates = [...liveTomCandidates, ...csvTomCandidatesNotAlreadyLive];

    const pool = buildBalancedSearchPool(tomCandidates, externalCandidates);

    console.log("Search pool source counts", {
      tomLive: liveTomCandidates.length,
      tomCsv: csvTomCandidatesNotAlreadyLive.length,
      tomCsvDroppedAsDuplicate:
        csvTomCandidates.length - csvTomCandidatesNotAlreadyLive.length,
      external: externalCandidates.length,
      total: pool.length
    });

    return NextResponse.json({
      query,
      pool,
      tomCatalogSnapshotDate: getTomCatalogSnapshotDate()
    } satisfies SearchPoolResponse);
  } catch (error) {
    console.error("search route error", error);

    return NextResponse.json(
      { error: "Search failed. Check the server console for the API error." },
      { status: 500 }
    );
  }
}

function buildBalancedSearchPool(
  tomCandidates: CandidateProject[],
  externalCandidates: CandidateProject[]
) {
  // First page should include TOM, but TOM should not dominate the whole page.
  const firstTom = tomCandidates.slice(0, TOM_FIRST_PAGE_SLOTS);
  const firstExternal = externalCandidates.slice(
    0,
    FIRST_PAGE_SIZE - firstTom.length
  );

  const firstPage = interleaveOneTomThenExternal(firstTom, firstExternal);

  const remainingTom = tomCandidates.slice(firstTom.length);
  const remainingExternal = externalCandidates.slice(firstExternal.length);

  const rest = interleaveByRatio({
    tom: remainingTom,
    external: remainingExternal,
    tomEvery: 4
  });

  return dedupeCandidatesById([...firstPage, ...rest]);
}

function interleaveOneTomThenExternal(
  tom: CandidateProject[],
  external: CandidateProject[]
) {
  const result: CandidateProject[] = [];
  let tomIndex = 0;
  let externalIndex = 0;

  while (tomIndex < tom.length || externalIndex < external.length) {
    if (tomIndex < tom.length) {
      result.push(tom[tomIndex]);
      tomIndex += 1;
    }

    for (let i = 0; i < 2 && externalIndex < external.length; i += 1) {
      result.push(external[externalIndex]);
      externalIndex += 1;
    }
  }

  return result.slice(0, FIRST_PAGE_SIZE);
}

function interleaveByRatio({
  tom,
  external,
  tomEvery
}: {
  tom: CandidateProject[];
  external: CandidateProject[];
  tomEvery: number;
}) {
  const result: CandidateProject[] = [];
  let tomIndex = 0;
  let externalIndex = 0;

  while (tomIndex < tom.length || externalIndex < external.length) {
    for (
      let i = 0;
      i < tomEvery - 1 && externalIndex < external.length;
      i += 1
    ) {
      result.push(external[externalIndex]);
      externalIndex += 1;
    }

    if (tomIndex < tom.length) {
      result.push(tom[tomIndex]);
      tomIndex += 1;
    }

    if (externalIndex >= external.length && tomIndex < tom.length) {
      result.push(...tom.slice(tomIndex));
      break;
    }

    if (tomIndex >= tom.length && externalIndex < external.length) {
      result.push(...external.slice(externalIndex));
      break;
    }
  }

  return result;
}

// Both live-search and CSV TOM candidates link to the same
// tomglobal.org/project?id=... URL shape for the same real project - this
// is the stable identifier to dedupe on, unlike candidate.id (which differs
// by source: Exa's own result id vs. the id extracted from the CSV link).
function extractTomProjectId(url: string): string | null {
  try {
    return new URL(url).searchParams.get("id");
  } catch {
    return null;
  }
}

function dedupeCandidatesById(candidates: CandidateProject[]) {
  const seen = new Set<string>();
  const deduped: CandidateProject[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;

    seen.add(candidate.id);
    deduped.push(candidate);
  }

  return deduped;
}