import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}

import { NextRequest, NextResponse } from "next/server";
import { ChatMessage, IntakeChatResponse, NeedProfile } from "@/lib/types";

export const runtime = "nodejs";

// Code-level safety net for "ready too early": no matter what the model says,
// the intake cannot hand off to search until the user has sent at least this
// many messages. Tune as you like (3 = opener + ~2 answered follow-ups).
const MIN_USER_TURNS_BEFORE_SEARCH = 3;

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
  searchDirections: [],
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
            "Missing GEMINI_API_KEY or GOOGLE_API_KEY. Add it to .env.local and restart npm run dev.",
        },
        { status: 500 },
      );
    }

    if (!messages.length) {
      return NextResponse.json(
        {
          error: "No intake messages were provided.",
        },
        { status: 400 },
      );
    }

    const response = await callGemini({
      apiKey,
      model,
      messages,
      currentNeedProfile,
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("intake-chat error", error);

    return NextResponse.json(
      {
        error:
          "Gemini intake request failed. This usually means the server cannot reach the Gemini API endpoint. Check network/VPN/proxy, API key, and model name.",
      },
      { status: 502 },
    );
  }
}

async function callGemini({
  apiKey,
  model,
  messages,
  currentNeedProfile,
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
          text: buildSystemPrompt(currentNeedProfile),
        },
      ],
    },
    ...messages.map(
      (message): GeminiContent => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }),
    ),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = safeParseJson(rawText);

    const userTurns = messages.filter((m) => m.role === "user").length;

    return normalizeIntakeResponse(parsed, currentNeedProfile, userTurns);
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

Rules for suggestedReplies:
- These are quick-reply BUTTONS the user taps to ANSWER your question. When tapped, the text is sent verbatim AS THE USER'S OWN MESSAGE.
- Write 2-4 of them as short, first-person possible ANSWERS to the question in assistantMessage (e.g. "Mostly indoors", "It needs to handle stairs", "I'm not sure yet").
- NEVER put a question here. A reply like "What kind of environment will it be used in?" is WRONG, because tapping it would make the user ask themselves a question.
- No greetings, no instructions. If assistantMessage is only a summary with no question, return an empty array.

When to set readyForInternalSearch:
Keep readyForInternalSearch = false and ask exactly ONE useful follow-up question until ALL of these are true:
- activity is known and specific (not just an object/category like "a wheelchair"),
- problem / main difficulty is known,
- environment is known (where the solution will be used),
- at least one userContext constraint is known (body ability, existing device, who operates it, etc.),
- at least one concrete mustHave, mustAvoid, or searchDirection exists,
- AND the user has already answered at least 2 of your follow-up questions.

Only when EVERY item above is satisfied: set readyForInternalSearch = true, stop asking questions, and write a short handoff in handoffReason.

Hard rules:
- An opening message such as "I need a wheelchair" is NEVER enough on its own. Do NOT set readyForInternalSearch = true on the first or second user message.
- Naming the object ("a wheelchair", "a spoon") is NOT the same as knowing the activity, environment, and difficulty. The same object needs completely different solutions indoors on flat floors vs. outdoors over stairs, so you MUST ask before searching.
- If you are unsure whether you have enough, ask one more question instead of searching.

Examples:

User: "I need a wheelchair"
This is only the object: no environment, no specific difficulty, no constraint yet.
=> readyForInternalSearch = false. Ask ONE follow-up about where it will be used and the main difficulty.
=> suggestedReplies are ANSWERS, e.g. ["Mostly indoors", "Mostly outdoors", "Both indoors and outdoors", "It needs to handle stairs"].

User (later): "Mostly outdoors, over uneven ground, and I have limited hand strength"
Now activity, environment, difficulty, and a userContext constraint are known, and the user has answered several follow-ups.
=> readyForInternalSearch = true. Briefly summarize and say you can start looking for related projects.
=> suggestedReplies = [] (the message is a summary, not a question).
`;
}

function normalizeIntakeResponse(
  parsed: unknown,
  previousProfile: NeedProfile,
  userTurns: number,
): IntakeChatResponse {
  const value =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};

  const assistantMessage =
    typeof value.assistantMessage === "string" && value.assistantMessage.trim()
      ? value.assistantMessage.trim()
      : "I need to confirm one key piece of information: what type of activity difficulty do you primarily want to overcome?";

  const needProfile = normalizeNeedProfile(
    value.needProfile || previousProfile,
  );

  let readyForInternalSearch =
    typeof value.readyForInternalSearch === "boolean"
      ? value.readyForInternalSearch
      : inferReadyForSearch(needProfile);

  // Hard floor: never hand off before the user has answered enough.
  if (userTurns < MIN_USER_TURNS_BEFORE_SEARCH) {
    readyForInternalSearch = false;
  }

  const handoffReason =
    readyForInternalSearch &&
    typeof value.handoffReason === "string" &&
    value.handoffReason.trim()
      ? value.handoffReason.trim()
      : readyForInternalSearch
        ? buildDefaultHandoffReason(needProfile)
        : "";

  const missingInformation = normalizeStringArray(value.missingInformation);
  const suggestedReplies = normalizeStringArray(value.suggestedReplies).slice(
    0,
    4,
  );

  return {
    assistantMessage,
    needProfile,
    readyForInternalSearch,
    handoffReason,
    missingInformation,
    suggestedReplies,
  };
}

function normalizeNeedProfile(input: unknown): NeedProfile {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

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
    searchDirections: normalizeStringArray(value.searchDirections),
  };
}

function inferReadyForSearch(profile: NeedProfile) {
  const hasActivity = Boolean(
    profile.activity && profile.activity !== "unknown activity",
  );
  const hasProblem = Boolean(
    profile.problem && profile.problem !== "unknown problem",
  );
  const hasEnvironment = profile.environment.length > 0;
  const hasContext = profile.userContext.length > 0;
  const hasCriteria =
    profile.mustHave.length > 0 ||
    profile.mustAvoid.length > 0 ||
    profile.searchDirections.length > 0;

  return hasActivity && hasProblem && hasEnvironment && hasContext && hasCriteria;
}

function buildDefaultHandoffReason(profile: NeedProfile) {
  return `I understand that you want to address difficulties with "${profile.activity}", primarily focusing on the issue of "${profile.problem}". I can use this information to start searching for relevant projects.`;
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