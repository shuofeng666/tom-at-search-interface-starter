import { NextRequest, NextResponse } from "next/server";
import { buildSearchQuery, fetchPrioritizedPool } from "@/lib/exa";
import { buildCandidatesFromExa } from "@/lib/evaluate";
import { CandidateProject, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

// Phase 1: FETCH ONLY (fast, no LLM). Pull a few results from each source and
// return the whole unscored pool. The frontend scores it in pages via
// /api/evaluate and reveals more with "Load more".
const PRIMARY_PER_DOMAIN = 8;
const SECONDARY_PER_DOMAIN = 3;
const COMMERCIAL_PER_DOMAIN = 2;

export type SearchPoolResponse = {
  query: string;
  pool: CandidateProject[];
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile | undefined;
    const customQuery = typeof body.query === "string" ? body.query : undefined;

    if (!needProfile) {
      return NextResponse.json({ error: "Missing needProfile." }, { status: 400 });
    }

    if (!process.env.EXA_API_KEY) {
      return NextResponse.json(
        { error: "Missing EXA_API_KEY. Add it to .env.local and restart the dev server." },
        { status: 500 }
      );
    }

    const query = buildSearchQuery(needProfile, customQuery);

const results = await fetchPrioritizedPool({
  query,
  needProfile,
  primaryPerDomain: PRIMARY_PER_DOMAIN,
  secondaryPerDomain: SECONDARY_PER_DOMAIN,
  commercialPerDomain: COMMERCIAL_PER_DOMAIN
});

    // Build candidates WITHOUT scoring them (evaluation stays empty for now).
    const pool = buildCandidatesFromExa(results);

    return NextResponse.json({ query, pool } satisfies SearchPoolResponse);
  } catch (error) {
    console.error("search route error", error);

    return NextResponse.json(
      { error: "Search failed. Check the server console for the API error." },
      { status: 500 }
    );
  }
}