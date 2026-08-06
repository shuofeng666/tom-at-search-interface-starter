import { NextRequest, NextResponse } from "next/server";
import { buildSearchQuery, fetchPrioritizedPool } from "@/lib/exa";
import { buildCandidatesFromExa } from "@/lib/evaluate";
import { getTomCatalogSnapshotDate, searchTomProjects } from "@/lib/tom";
import { CandidateProject, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

// Phase 1: FETCH ONLY. Pull a pool from TOM + external sources.
// The frontend scores PAGE_SIZE candidates at a time via /api/evaluate.
const TOM_LIMIT = 20;
// Also let Exa search tomglobal.org directly (EXA_PRIMARY_DOMAINS) as a
// semantic-search supplement to the TOM API's literal keyword search below —
// it was previously disabled (0), which meant tomglobal.org results only
// ever came from the keyword-matched TOM API call.
const PRIMARY_PER_DOMAIN = 6;
const SECONDARY_PER_DOMAIN = 3;
const COMMERCIAL_PER_DOMAIN = 3;

const FIRST_PAGE_SIZE = 8;
const TOM_FIRST_PAGE_SLOTS = 4;

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

    const [tomCandidates, externalResults] = await Promise.all([
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

    const externalCandidates = buildCandidatesFromExa(externalResults);

    const pool = buildBalancedSearchPool(tomCandidates, externalCandidates);

    console.log("Search pool source counts", {
      tom: tomCandidates.length,
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