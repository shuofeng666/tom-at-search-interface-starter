import { NextRequest, NextResponse } from "next/server";
import { evaluateCandidates } from "@/lib/evaluate";
import { CandidateProject, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

// Phase 2: SCORE a batch (the LLM step). The frontend sends the next page of
// already-fetched candidates here; we score them and return them in the same
// order (no sorting). Called once per "Load more".
export type EvaluateResponse = {
  candidates: CandidateProject[];
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile | undefined;
    const candidates = Array.isArray(body.candidates)
      ? (body.candidates as CandidateProject[])
      : [];

    if (!needProfile) {
      return NextResponse.json({ error: "Missing needProfile." }, { status: 400 });
    }

    if (!candidates.length) {
      return NextResponse.json({ candidates: [] } satisfies EvaluateResponse);
    }

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Missing GEMINI_API_KEY or GOOGLE_API_KEY. Add it to .env.local and restart the dev server."
        },
        { status: 500 }
      );
    }

    const scored = await evaluateCandidates({ needProfile, candidates });

    return NextResponse.json({ candidates: scored } satisfies EvaluateResponse);
  } catch (error) {
    console.error("evaluate route error", error);

    return NextResponse.json(
      { error: "Evaluation failed. Check the server console for the API error." },
      { status: 500 }
    );
  }
}