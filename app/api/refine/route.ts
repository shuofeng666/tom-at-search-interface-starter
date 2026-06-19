import { NextRequest, NextResponse } from "next/server";
import { generateGeminiJson, toStringArray } from "@/lib/gemini";
import { CandidateProject, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile;
    const candidate = body.candidate as CandidateProject;
    const rejectionReason =
      typeof body.rejectionReason === "string" ? body.rejectionReason : "does not fit";

    const updated = await generateGeminiJson<Partial<NeedProfile>>({
      prompt: buildRefinePrompt({
        needProfile,
        candidate,
        rejectionReason
      })
    });

    if (!updated) {
      return NextResponse.json(applyFallbackRefinement(needProfile, rejectionReason));
    }

    return NextResponse.json(normalizeNeedProfile(updated, needProfile));
  } catch (error) {
    console.error("refine route error", error);
    return NextResponse.json(null, { status: 500 });
  }
}

function buildRefinePrompt({
  needProfile,
  candidate,
  rejectionReason
}: {
  needProfile: NeedProfile;
  candidate: CandidateProject;
  rejectionReason: string;
}) {
  return `
A TOM reviewer rejected a candidate during assistive technology search.

Current Need Profile:
${JSON.stringify(needProfile, null, 2)}

Rejected Candidate:
${JSON.stringify(
  {
    title: candidate.title,
    summary: candidate.summary,
    sourceType: candidate.sourceType,
    evaluation: candidate.evaluation
  },
  null,
  2
)}

Rejection reason:
${rejectionReason}

Update the Need Profile so the next search can avoid similar mismatches.

Return ONLY valid JSON:
{
  "activity": "string",
  "problem": "string",
  "userContext": ["string"],
  "environment": ["string"],
  "mustHave": ["string"],
  "mustAvoid": ["string"],
  "safetyConcerns": ["string"],
  "preferences": ["string"],
  "unknowns": ["string"],
  "searchDirections": ["string"]
}

Rules:
- Preserve useful existing information.
- Add the rejection reason as a concrete criterion.
- Add new search directions if useful.
- Do not add unsupported medical claims.
`;
}

function normalizeNeedProfile(
  updated: Partial<NeedProfile>,
  previous: NeedProfile
): NeedProfile {
  return {
    activity:
      typeof updated.activity === "string" && updated.activity.trim()
        ? updated.activity.trim()
        : previous.activity,
    problem:
      typeof updated.problem === "string" && updated.problem.trim()
        ? updated.problem.trim()
        : previous.problem,
    userContext: merge(previous.userContext, toStringArray(updated.userContext)),
    environment: merge(previous.environment, toStringArray(updated.environment)),
    mustHave: merge(previous.mustHave, toStringArray(updated.mustHave)),
    mustAvoid: merge(previous.mustAvoid, toStringArray(updated.mustAvoid)),
    safetyConcerns: merge(previous.safetyConcerns, toStringArray(updated.safetyConcerns)),
    preferences: merge(previous.preferences, toStringArray(updated.preferences)),
    unknowns: merge(previous.unknowns, toStringArray(updated.unknowns)),
    searchDirections: merge(previous.searchDirections, toStringArray(updated.searchDirections))
  };
}

function applyFallbackRefinement(profile: NeedProfile, rejectionReason: string): NeedProfile {
  const mapped = mapRejectionToCriterion(rejectionReason);

  return {
    ...profile,
    mustHave: merge(profile.mustHave, mapped.mustHave),
    mustAvoid: merge(profile.mustAvoid, mapped.mustAvoid),
    safetyConcerns: merge(profile.safetyConcerns, mapped.safetyConcerns),
    searchDirections: merge(profile.searchDirections, mapped.searchDirections)
  };
}

function mapRejectionToCriterion(reason: string): Partial<NeedProfile> {
  switch (reason) {
    case "requires-hand-use":
      return {
        mustHave: ["low hand effort or hands-free use"],
        mustAvoid: ["requires continuous hand operation"],
        searchDirections: ["hands-free assistive technology solution"]
      };

    case "not-removable":
      return {
        mustHave: ["removable setup"],
        mustAvoid: ["permanent installation"],
        searchDirections: ["removable adaptive device"]
      };

    case "not-compatible":
      return {
        mustHave: ["compatible with the user's existing device or environment"],
        unknowns: ["exact device dimensions or environment constraints"],
        searchDirections: ["universal fit adaptive device"]
      };

    case "hard-to-clean":
      return {
        mustHave: ["easy to clean"],
        mustAvoid: ["porous or hard-to-sanitize surfaces"],
        safetyConcerns: ["hygiene"]
      };

    case "not-safe":
      return {
        mustHave: ["safer design"],
        safetyConcerns: ["user-specific safety review needed"]
      };

    case "too-expensive":
      return {
        mustHave: ["low-cost solution"],
        searchDirections: ["affordable DIY assistive technology"]
      };

    case "not-portable":
      return {
        mustHave: ["portable"],
        mustAvoid: ["large fixed setup"],
        searchDirections: ["portable assistive technology device"]
      };

    case "not-available":
      return {
        mustHave: ["locally available or locally manufacturable"],
        searchDirections: ["locally manufacturable assistive technology"]
      };

    case "poor-documentation":
      return {
        mustHave: ["clear documentation"],
        mustAvoid: ["missing build instructions"],
        searchDirections: ["open source assistive technology documentation CAD STL"]
      };

    default:
      return {
        mustAvoid: [reason],
        searchDirections: [`assistive technology without ${reason}`]
      };
  }
}

function merge(a: string[], b: string[] = []) {
  return Array.from(
    new Set(
      [...a, ...b]
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}