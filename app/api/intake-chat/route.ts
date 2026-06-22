import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}

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
  unknowns: [],
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

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Missing GEMINI_API_KEY or GOOGLE_API_KEY. Add it to .env.local and restart npm run dev."
        },
        { status: 500 }
      );
    }

    if (!messages.length) {
      return NextResponse.json(
        {
          error: "No intake messages were provided."
        },
        { status: 400 }
      );
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

    return NextResponse.json(
      {
        error:
          "Gemini intake request failed. This usually means the server cannot reach the Gemini API endpoint. Check network/VPN/proxy, API key, and model name."
      },
      { status: 502 }
    );
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
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
      throw new Error(`Gemini API returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJson(rawText);

    return normalizeIntakeResponse(parsed, currentNeedProfile);
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(currentNeedProfile: NeedProfile) {
  return `
You are the first-screen intake agent for a TOM assistive technology search interface.

You are talking to a Need-Knower, customer, caregiver, or TOM team member who is describing an assistive technology need.

Your job:
- Understand the practical need.
- Ask useful follow-up questions.
- Do not show internal project evaluation.
- Do not recommend projects yet.
- Do not mention ranking, scores, candidate cards, or TOM internal review.
- Do not ask for name unless necessary.
- Do not ask a long checklist.
- Ask at most one concise follow-up question at a time.
- If the user writes in Chinese, answer in Chinese.
- If the user writes in Hebrew, answer in Hebrew.
- Otherwise answer in English.

Collect these fields:
- activity: what the person wants to do
- problem: what makes it difficult
- userContext: body ability, mobility device, caregiver involvement, relevant constraints
- environment: where it is used
- mustHave: requirements the solution must satisfy
- mustAvoid: things the solution should avoid
- safetyConcerns: possible risk areas
- preferences: portability, cleaning, cost, location, DIY preference, materials
- unknowns: useful missing information
- searchDirections: possible search phrases for TOM/internal/external search

Current Need Profile:
${JSON.stringify(currentNeedProfile, null, 2)}

Return ONLY valid JSON with this exact shape:
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

Set readyForInternalSearch to true when the system knows:
- the activity,
- the main difficulty,
- at least one user/context constraint,
- at least one concrete search or design criterion.

The intake does not need to be perfect. Once there is enough information for an initial search, stop asking more questions and prepare a short handoff.

Examples:

User: "我左腿断了"
You should not repeat "what activity do you want to do" forever.
You should infer userContext includes "left leg amputation" and ask one useful follow-up:
"你主要想解决哪类活动里的困难？比如走路、上下楼、洗澡、穿衣，还是运动？"

User: "就是走路"
Now activity is walking, problem is mobility difficulty, userContext is left leg amputation. This is enough for initial search.
Set readyForInternalSearch to true.
assistantMessage should summarize briefly and say it can start looking for related projects.
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
      : "我需要再确认一个关键信息：你主要想解决哪个日常活动里的困难？";

  const needProfile = normalizeNeedProfile(value.needProfile || previousProfile);

  const readyForInternalSearch =
    typeof value.readyForInternalSearch === "boolean"
      ? value.readyForInternalSearch
      : inferReadyForSearch(needProfile);

  const handoffReason =
    typeof value.handoffReason === "string" && value.handoffReason.trim()
      ? value.handoffReason.trim()
      : readyForInternalSearch
        ? buildDefaultHandoffReason(needProfile)
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
  const hasCriteria =
    profile.mustHave.length > 0 ||
    profile.mustAvoid.length > 0 ||
    profile.searchDirections.length > 0;

  return hasActivity && hasProblem && hasContext && hasCriteria;
}

function buildDefaultHandoffReason(profile: NeedProfile) {
  return `我现在理解的是：你想解决“${profile.activity}”中的困难，主要问题是“${profile.problem}”。我可以基于这些信息开始搜索相关项目。`;
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