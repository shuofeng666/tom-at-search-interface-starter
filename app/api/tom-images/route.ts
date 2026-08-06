import { NextRequest, NextResponse } from "next/server";
import { attachTomImages, TomImageLookupResult } from "@/lib/tom";

export const runtime = "nodejs";

// Called only for the small set of TOM candidates that actually end up
// visible on screen after scoring + filtering — not the whole search pool.
// See attachTomImages for why that separation matters.
export type TomImagesResponse = {
  results: TomImageLookupResult[];
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const candidates = Array.isArray(body.candidates)
      ? (body.candidates as Array<{ id?: unknown; title?: unknown }>)
          .filter(
            (candidate): candidate is { id: string; title: string } =>
              typeof candidate.id === "string" && typeof candidate.title === "string"
          )
      : [];

    if (!candidates.length) {
      return NextResponse.json({ results: [] } satisfies TomImagesResponse);
    }

    const results = await attachTomImages(candidates);
    const withImages = results.filter((result) => result.image);

    return NextResponse.json({ results: withImages } satisfies TomImagesResponse);
  } catch (error) {
    console.error("tom-images route error", error);

    return NextResponse.json(
      { error: "TOM image lookup failed." },
      { status: 500 }
    );
  }
}
