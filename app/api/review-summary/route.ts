import { NextRequest, NextResponse } from "next/server";
import { generateGeminiJson, toStringArray } from "@/lib/gemini";
import { CandidateProject, NeedProfile, ReviewSummary } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const needProfile = body.needProfile as NeedProfile;
    const candidates = Array.isArray(body.candidates)
      ? (body.candidates as CandidateProject[])
      : [];

    const generated = await generateGeminiJson<Partial<ReviewSummary>>({
      prompt: buildSummaryPrompt({
        needProfile,
        candidates
      }),
      temperature: 0.2
    });

    if (!generated) {
      return NextResponse.json(makeFallbackSummary(needProfile, candidates));
    }

    return NextResponse.json(normalizeSummary(generated, needProfile, candidates));
  } catch (error) {
    console.error("review-summary route error", error);
    return NextResponse.json(null, { status: 500 });
  }
}

function buildSummaryPrompt({
  needProfile,
  candidates
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
}) {
  return `
Prepare a TOM review summary for an assistive technology search session.

Need Profile:
${JSON.stringify(needProfile, null, 2)}

Candidate Projects:
${JSON.stringify(
  candidates.map((candidate) => ({
    title: candidate.title,
    source: candidate.source,
    sourceType: candidate.sourceType,
    summary: candidate.summary,
    rejected: candidate.rejected,
    rejectionReason: candidate.rejectionReason,
    evaluation: candidate.evaluation
  })),
  null,
  2
)}

Return ONLY valid JSON:
{
  "needSummary": "string",
  "closestMatches": ["string"],
  "weakMatches": ["string"],
  "mainGaps": ["string"],
  "keyRisks": ["string"],
  "recommendedPathway": "string",
  "nextActionsForTomTeam": ["string"],
  "nextQuestionsForNeedKnower": ["string"],
  "userFacingMessage": "string"
}

Rules:
- Internal TOM notes can be specific.
- User-facing message should be cautious and clear.
- Do not claim a project is safe or recommended unless the evidence supports it.
- Mention missing information clearly.
- Suggest practical next steps.
`;
}

function normalizeSummary(
  input: Partial<ReviewSummary>,
  needProfile: NeedProfile,
  candidates: CandidateProject[]
): ReviewSummary {
  const fallback = makeFallbackSummary(needProfile, candidates);

  return {
    needSummary:
      typeof input.needSummary === "string" && input.needSummary.trim()
        ? input.needSummary.trim()
        : fallback.needSummary,

    closestMatches: toStringArray(input.closestMatches),
    weakMatches: toStringArray(input.weakMatches),
    mainGaps: toStringArray(input.mainGaps),
    keyRisks: toStringArray(input.keyRisks),

    recommendedPathway:
      typeof input.recommendedPathway === "string" && input.recommendedPathway.trim()
        ? input.recommendedPathway.trim()
        : fallback.recommendedPathway,

    nextActionsForTomTeam: toStringArray(input.nextActionsForTomTeam),
    nextQuestionsForNeedKnower: toStringArray(input.nextQuestionsForNeedKnower),

    userFacingMessage:
      typeof input.userFacingMessage === "string" && input.userFacingMessage.trim()
        ? input.userFacingMessage.trim()
        : fallback.userFacingMessage
  };
}

function makeFallbackSummary(
  needProfile: NeedProfile,
  candidates: CandidateProject[]
): ReviewSummary {
  const sorted = [...candidates].sort(
    (a, b) => b.evaluation.overallScore - a.evaluation.overallScore
  );

  const closestMatches = sorted.slice(0, 3).map((candidate) => {
    return `${candidate.title}: ${candidate.evaluation.pathwayReason}`;
  });

  const weakMatches = sorted
    .filter((candidate) => candidate.evaluation.overallScore < 1.5 || candidate.rejected)
    .slice(0, 3)
    .map((candidate) => {
      return `${candidate.title}: ${candidate.rejectionReason || candidate.evaluation.pathway}`;
    });

  const gaps = Array.from(
    new Set(sorted.flatMap((candidate) => candidate.evaluation.missingInformation))
  ).slice(0, 6);

  const risks = Array.from(
    new Set(sorted.flatMap((candidate) => candidate.evaluation.riskFlags))
  ).slice(0, 6);

  return {
    needSummary: `${needProfile.activity}: ${needProfile.problem}`,
    closestMatches,
    weakMatches,
    mainGaps: gaps,
    keyRisks: risks,
    recommendedPathway:
      "Review the closest matches internally before preparing a direct recommendation.",
    nextActionsForTomTeam: [
      "Check missing documentation for the closest matches.",
      "Confirm safety and fit with the Need-Knower.",
      "Decide whether an existing solution can be adapted or whether this should become a new challenge."
    ],
    nextQuestionsForNeedKnower: needProfile.unknowns.length
      ? needProfile.unknowns
      : ["Can you share more detail about the environment and any size or safety constraints?"],
    userFacingMessage:
      "We found some related options, but TOM should review the fit, documentation, and safety information before treating them as recommendations."
  };
}