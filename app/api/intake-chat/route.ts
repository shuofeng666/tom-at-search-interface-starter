import { NextRequest, NextResponse } from "next/server";
import { ChatMessage, IntakeChatResponse, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

type GeminiContent = {
  role: "user" | "model";
  parts: { text: string }[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

const fallbackNeedProfile: NeedProfile = {
  activity: "unknown activity",
  problem: "unknown problem",
  userContext: [],
  environment: [],
  mustHave: [],
  mustAvoid: [],
  safetyConcerns: [],
  preferences: [],
  unknowns: [
    "what activity the person wants to do",
    "what makes the activity difficult",
    "where the solution will be used"
  ],
  searchDirections: []
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const messages = Array.isArray(body.messages)
      ? (body.messages as ChatMessage[])
      : [];

    const currentNeedProfile = normalizeNeedProfile(body.currentNeedProfile);

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    if (!messages.length || !apiKey) {
      return NextResponse.json(makeFallbackResponse(currentNeedProfile));
    }

    const response = await callGemini({
      apiKey,
      model,
      messages,
      currentNeedProfile
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("intake-chat error", error);
    return NextResponse.json(makeFallbackResponse(fallbackNeedProfile));
  }
}

async function callGemini({
  apiKey,
  model,
  messages,
  currentNeedProfile
}: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  currentNeedProfile: NeedProfile;
}): Promise<IntakeChatResponse> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents: GeminiContent[] = [
    {
      role: "user",
      parts: [
        {
          text: buildSystemPrompt(currentNeedProfile)
        }
      ]
    },
    ...messages.map((message): GeminiContent => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }))
  ];

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Gemini intake error", text);
    return makeFallbackResponse(currentNeedProfile);
  }

  const data = (await res.json()) as GeminiResponse;
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = safeParseJson(rawText);

  return normalizeIntakeResponse(parsed, currentNeedProfile);
}

function buildSystemPrompt(currentNeedProfile: NeedProfile) {
  return `
You are the first-screen intake agent for a TOM assistive technology search interface.

Your job:
- Talk to a Need-Knower, customer, or TOM team member who is describing an assistive technology need.
- Ask only useful follow-up questions.
- Do not show internal evaluation.
- Do not recommend projects yet.
- Do not mention scores, ranking, TOM internal review, or candidate cards.
- Do not ask for name unless it is genuinely necessary.
- Do not ask a long checklist.
- Ask one concise follow-up question at a time.
- When the need is specific enough for an initial project search, set readyForInternalSearch to true.

Useful information:
- activity: what the person wants to do
- problem: what is difficult
- userContext: body ability, mobility device, caregiver involvement, relevant constraints
- environment: where it is used
- mustHave: requirements the solution must satisfy
- mustAvoid: things the solution should not require or do
- safetyConcerns: possible risk areas
- preferences: cost, portability, cleaning, materials, DIY preference, location
- unknowns: missing information that would help later
- searchDirections: possible search phrases for TOM/internal/external search

Current Need Profile:
${JSON.stringify(currentNeedProfile, null, 2)}

Return ONLY valid JSON with this shape:
{
  "assistantMessage": "one short natural response to the user",
  "needProfile": {
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
  },
  "readyForInternalSearch": boolean,
  "handoffReason": "string",
  "missingInformation": ["string"],
  "suggestedReplies": ["string"]
}

Decision rule:
Set readyForInternalSearch to true when you know:
- the activity,
- the main difficulty,
- at least one user/context constraint,
- at least one must-have or must-avoid criterion.

Style:
- Natural and direct.
- No long introduction.
- No numbered workflow.
- No internal TOM jargon in assistantMessage.
`;
}

function normalizeIntakeResponse(
  parsed: unknown,
  previousProfile: NeedProfile
): IntakeChatResponse {
  const value =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  const assistantMessage =
    typeof value.assistantMessage === "string" && value.assistantMessage.trim()
      ? value.assistantMessage.trim()
      : "Can you tell me a bit more about what makes this activity difficult?";

  const needProfile = normalizeNeedProfile(value.needProfile || previousProfile);

  const readyForInternalSearch =
    typeof value.readyForInternalSearch === "boolean"
      ? value.readyForInternalSearch
      : inferReadyForSearch(needProfile);

  const handoffReason =
    typeof value.handoffReason === "string"
      ? value.handoffReason
      : readyForInternalSearch
        ? "I have enough information to start looking for related TOM projects and references."
        : "";

  const missingInformation = normalizeStringArray(value.missingInformation);
  const suggestedReplies = normalizeStringArray(value.suggestedReplies).slice(0, 4);

  return {
    assistantMessage,
    needProfile,
    readyForInternalSearch,
    handoffReason,
    missingInformation,
    suggestedReplies
  };
}

function normalizeNeedProfile(input: unknown): NeedProfile {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  return {
    activity:
      typeof value.activity === "string" && value.activity.trim()
        ? value.activity.trim()
        : fallbackNeedProfile.activity,

    problem:
      typeof value.problem === "string" && value.problem.trim()
        ? value.problem.trim()
        : fallbackNeedProfile.problem,

    userContext: normalizeStringArray(value.userContext),
    environment: normalizeStringArray(value.environment),
    mustHave: normalizeStringArray(value.mustHave),
    mustAvoid: normalizeStringArray(value.mustAvoid),
    safetyConcerns: normalizeStringArray(value.safetyConcerns),
    preferences: normalizeStringArray(value.preferences),
    unknowns: normalizeStringArray(value.unknowns),
    searchDirections: normalizeStringArray(value.searchDirections)
  };
}

function inferReadyForSearch(profile: NeedProfile) {
  const hasActivity = Boolean(profile.activity && profile.activity !== "unknown activity");
  const hasProblem = Boolean(profile.problem && profile.problem !== "unknown problem");
  const hasContext = profile.userContext.length > 0 || profile.environment.length > 0;
  const hasCriteria = profile.mustHave.length > 0 || profile.mustAvoid.length > 0;

  return hasActivity && hasProblem && hasContext && hasCriteria;
}

function makeFallbackResponse(profile: NeedProfile): IntakeChatResponse {
  const ready = inferReadyForSearch(profile);

  return {
    assistantMessage: ready
      ? "I have enough information to start looking for related projects. You can add more details, or I can start the search now."
      : "Can you describe what activity you want to do and what makes it difficult right now?",
    needProfile: profile,
    readyForInternalSearch: ready,
    handoffReason: ready
      ? "I have enough information to start looking for related TOM projects and references."
      : "",
    missingInformation: profile.unknowns,
    suggestedReplies: []
  };
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}