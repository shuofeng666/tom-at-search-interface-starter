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
    desiredOutcome: { type: "string" },

    seekerRole: {
      type: "string",
      enum: ["self", "caregiver", "clinician", "other", "unknown"],
    },
    userAge: { type: "string" },
    location: {
      type: "object",
      additionalProperties: false,
      properties: {
        country: { type: "string" },
        cityOrRegion: { type: "string" },
      },
      required: ["country", "cityOrRegion"],
    },

    userContext: { type: "array", items: { type: "string" } },
    bodyFunction: { type: "array", items: { type: "string" } },
    currentDevices: { type: "array", items: { type: "string" } },
    environment: { type: "array", items: { type: "string" } },

    mustHave: { type: "array", items: { type: "string" } },
    mustAvoid: { type: "array", items: { type: "string" } },
    safetyConcerns: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },

    unknowns: { type: "array", items: { type: "string" } },
    searchDirections: { type: "array", items: { type: "string" } },
  },
  required: [
    "activity",
    "problem",
    "desiredOutcome",
    "seekerRole",
    "userAge",
    "location",
    "userContext",
    "bodyFunction",
    "currentDevices",
    "environment",
    "mustHave",
    "mustAvoid",
    "safetyConcerns",
    "preferences",
    "unknowns",
    "searchDirections",
  ],
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
    system: `
You convert assistive technology challenge descriptions into a concise TOM-style Need Profile.

Do not recommend products.
Do not assume the mentioned object is the real need.
Convert the lived challenge into activity, problem, desired outcome, user context, environment, and constraints.

Infer cautiously.
If age, location, role, environment, or safety information is missing, leave the field empty or mark it in unknowns.
`,
    user: `
User description:
${description}

Create a Need Profile for search and evaluation.
Include 5-8 search directions that cover TOM projects, open-source/DIY, commercial products, research prototypes, and adjacent products.
`,
  });

  if (!profile) {
    return NextResponse.json({
      ...demoNeedProfile,
      problem: description,
      unknowns: [
        "AI extraction unavailable. Edit this Need Profile manually before search.",
        "age or age range",
        "country or region",
        "daily activity",
        "main difficulty",
      ],
    });
  }

  return NextResponse.json(profile);
}