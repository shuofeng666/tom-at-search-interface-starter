import { NextRequest, NextResponse } from "next/server";
import { generateGeminiJson, toStringArray } from "@/lib/gemini";
import { CandidateProject, NeedProfile, SeekerRole } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile;
    const candidate = body.candidate as CandidateProject;

    const rejectionReason =
      typeof body.rejectionReason === "string"
        ? body.rejectionReason
        : "does not fit";

    const updated = await generateGeminiJson<Partial<NeedProfile>>({
      prompt: buildRefinePrompt({
        needProfile,
        candidate,
        rejectionReason,
      }),
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
  rejectionReason,
}: {
  needProfile: NeedProfile;
  candidate: CandidateProject;
  rejectionReason: string;
}) {
  return `
A TOM reviewer or user rejected a candidate during assistive technology search.

Current Need Profile:
${JSON.stringify(needProfile, null, 2)}

Rejected Candidate:
${JSON.stringify(
  {
    title: candidate.title,
    summary: candidate.summary,
    sourceType: candidate.sourceType,
    evaluation: candidate.evaluation,
  },
  null,
  2,
)}

Rejection reason:
${rejectionReason}

Update the Need Profile so the next search can avoid similar mismatches.

Return ONLY valid JSON:
{
  "activity": "string",
  "problem": "string",
  "desiredOutcome": "string",
  "seekerRole": "self | caregiver | TOM staff | clinician | other | unknown",
  "userAge": "string",
  "location": {
    "country": "string",
    "cityOrRegion": "string"
  },
  "userContext": ["string"],
  "bodyFunction": ["string"],
  "currentDevices": ["string"],
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
- Do not restart the profile.
- Add the rejection reason as a concrete mustHave, mustAvoid, preference, safety concern, or unknown.
- Add new search directions if useful.
- Do not add unsupported medical claims.
- If the rejection suggests the original intake was incomplete, add a next question under unknowns.
`;
}

function normalizeNeedProfile(
  updated: Partial<NeedProfile>,
  previous: NeedProfile,
): NeedProfile {
  return {
    activity: pickString(updated.activity, previous.activity),
    problem: pickString(updated.problem, previous.problem),
    desiredOutcome: pickString(updated.desiredOutcome, previous.desiredOutcome),

    seekerRole: normalizeSeekerRole(updated.seekerRole, previous.seekerRole),
    userAge: pickString(updated.userAge, previous.userAge),

    location: {
      country: pickString(updated.location?.country, previous.location.country),
      cityOrRegion: pickString(
        updated.location?.cityOrRegion,
        previous.location.cityOrRegion,
      ),
    },

    userContext: merge(previous.userContext, toStringArray(updated.userContext)),
    bodyFunction: merge(previous.bodyFunction, toStringArray(updated.bodyFunction)),
    currentDevices: merge(
      previous.currentDevices,
      toStringArray(updated.currentDevices),
    ),
    environment: merge(previous.environment, toStringArray(updated.environment)),

    mustHave: merge(previous.mustHave, toStringArray(updated.mustHave)),
    mustAvoid: merge(previous.mustAvoid, toStringArray(updated.mustAvoid)),
    safetyConcerns: merge(
      previous.safetyConcerns,
      toStringArray(updated.safetyConcerns),
    ),
    preferences: merge(previous.preferences, toStringArray(updated.preferences)),

    unknowns: merge(previous.unknowns, toStringArray(updated.unknowns)),
    searchDirections: merge(
      previous.searchDirections,
      toStringArray(updated.searchDirections),
    ),
  };
}

function applyFallbackRefinement(
  profile: NeedProfile,
  rejectionReason: string,
): NeedProfile {
  const mapped = mapRejectionToCriterion(rejectionReason);

  return {
    ...profile,
    mustHave: merge(profile.mustHave, mapped.mustHave || []),
    mustAvoid: merge(profile.mustAvoid, mapped.mustAvoid || []),
    safetyConcerns: merge(profile.safetyConcerns, mapped.safetyConcerns || []),
    preferences: merge(profile.preferences, mapped.preferences || []),
    unknowns: merge(profile.unknowns, mapped.unknowns || []),
    searchDirections: merge(profile.searchDirections, mapped.searchDirections || []),
  };
}

function mapRejectionToCriterion(reason: string): Partial<NeedProfile> {
  switch (reason) {
    case "requires-hand-use":
      return {
        mustHave: ["low hand effort or hands-free use"],
        mustAvoid: ["requires continuous hand operation"],
        bodyFunction: ["limited hand use may be relevant"],
        searchDirections: [
          "hands-free assistive technology solution",
          "low hand effort adaptive device",
        ],
      };

    case "not-removable":
      return {
        mustHave: ["removable setup"],
        mustAvoid: ["permanent installation"],
        searchDirections: ["removable adaptive device"],
      };

    case "not-compatible":
      return {
        mustHave: ["compatible with the user's existing device or environment"],
        unknowns: ["exact device dimensions or environment constraints"],
        searchDirections: ["universal fit adaptive device"],
      };

    case "hard-to-clean":
      return {
        mustHave: ["easy to clean"],
        mustAvoid: ["porous or hard-to-sanitize surfaces"],
        safetyConcerns: ["hygiene"],
        searchDirections: ["easy clean hygienic assistive device"],
      };

    case "not-safe":
      return {
        mustHave: ["safer design"],
        safetyConcerns: ["user-specific safety review needed"],
        unknowns: ["specific safety failure in rejected option"],
      };

    case "too-expensive":
      return {
        mustHave: ["low-cost solution"],
        searchDirections: ["affordable DIY assistive technology"],
      };

    case "not-portable":
      return {
        mustHave: ["portable"],
        mustAvoid: ["large fixed setup"],
        preferences: ["easy to carry and store"],
        searchDirections: ["portable assistive technology device"],
      };

    case "not-available":
      return {
        mustHave: ["locally available or locally manufacturable"],
        searchDirections: ["locally manufacturable assistive technology"],
      };

    case "poor-evidence":
  return {
    mustHave: ["clear evidence, build files, or product specifications"],
    mustAvoid: ["missing build instructions or unclear product details"],
    searchDirections: [
      "open source assistive technology build files CAD STL instructions",
      "assistive technology product specifications reviews"
    ],
  };
    default:
      return {
        mustAvoid: [reason],
        searchDirections: [`assistive technology without ${reason}`],
      };
  }
}

function pickString(input: unknown, fallback: string) {
  return typeof input === "string" && input.trim() ? input.trim() : fallback;
}

function normalizeSeekerRole(
  input: unknown,
  fallback: SeekerRole = "unknown",
): SeekerRole {
  if (typeof input !== "string") return fallback;

  const normalized = input.trim().toLowerCase();

  if (normalized === "self") return "self";
  if (normalized === "caregiver") return "caregiver";
  if (normalized === "tom staff" || normalized === "tom_staff") return "TOM staff";
  if (normalized === "clinician") return "clinician";
  if (normalized === "other") return "other";
  if (normalized === "unknown") return "unknown";

  return fallback;
}

function merge(a: string[], b: string[] = []) {
  return Array.from(
    new Set([...a, ...b].map((item) => item.trim()).filter(Boolean)),
  );
}