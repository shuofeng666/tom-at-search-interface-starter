import { NextRequest, NextResponse } from "next/server";
import { buildSearchQuery, searchExaProjects } from "@/lib/exa";
import { evaluateSearchResults, sortCandidates } from "@/lib/evaluate";
import { NeedProfile, SearchResponse } from "@/lib/types";

export const runtime = "nodejs";

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

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY or GOOGLE_API_KEY. Add it to .env.local and restart the dev server." },
        { status: 500 }
      );
    }

    const query = buildSearchQuery(needProfile, customQuery);

    const results = await searchExaProjects({
      query,
      needProfile,
      numResults: 8
    });

    if (!results.length) {
      return NextResponse.json({
        query,
        candidates: [],
        usedMockData: false
      } satisfies SearchResponse);
    }

    const candidates = await evaluateSearchResults({
      needProfile,
      results
    });

    return NextResponse.json({
      query,
      candidates: sortCandidates(candidates),
      usedMockData: false
    } satisfies SearchResponse);
  } catch (error) {
    console.error("search route error", error);

    return NextResponse.json(
      { error: "Search failed. Check the server console for the API error." },
      { status: 500 }
    );
  }
}