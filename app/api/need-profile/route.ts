import { NextResponse } from "next/server";
import { callOpenAIJson } from "@/lib/gemini";
import { demoNeedProfile } from "@/lib/mockData";
import { NeedProfile } from "@/lib/types";

const needProfileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    activity: { type: "string" },
    problem: { type: "string" },
    userContext: { type: "array", items: { type: "string" } },
    environment: { type: "array", items: { type: "string" } },
    mustHave: { type: "array", items: { type: "string" } },
    mustAvoid: { type: "array", items: { type: "string" } },
    safetyConcerns: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    searchDirections: { type: "array", items: { type: "string" } }
  },
  required: [
    "activity",
    "problem",
    "userContext",
    "environment",
    "mustHave",
    "mustAvoid",
    "safetyConcerns",
    "preferences",
    "unknowns",
    "searchDirections"
  ]
};

export async function POST(request: Request) {
  const body = await request.json();
  const description = String(body.description || "").trim();

  if (!description) {
    return NextResponse.json({ error: "Missing description" }, { status: 400 });
  }

  const profile = await callOpenAIJson<NeedProfile>({
    schemaName: "tom_need_profile",
    schema: needProfileSchema,
    system:
      "You convert assistive technology needs into a concise TOM-style Need Profile. Ask no questions. Infer cautiously. Mark uncertainty under unknowns.",
    user: `User description: ${description}\n\nCreate a Need Profile for search and evaluation. Include 5-8 search directions that cover TOM projects, open-source/DIY, commercial products, and adjacent products.`
  });

  if (!profile) {
    return NextResponse.json({
      ...demoNeedProfile,
      problem: description,
      unknowns: ["AI extraction unavailable. Edit this Need Profile manually before search."]
    });
  }

  return NextResponse.json(profile);
}
