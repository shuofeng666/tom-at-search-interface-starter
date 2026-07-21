//import { setGlobalDispatcher, ProxyAgent } from "undici";
import { NextRequest, NextResponse } from "next/server";
import {
  ChatMessage,
  IntakeChatResponse,
  NeedProfile,
  SeekerRole,
  emptyNeedProfile,
} from "@/lib/types";

//const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

//if (proxy) {
//  setGlobalDispatcher(new ProxyAgent(proxy));
//}

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

const fallbackNeedProfile = emptyNeedProfile();

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
        { error: "No intake messages were provided." },
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

    return normalizeIntakeResponse(parsed, currentNeedProfile);
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(currentNeedProfile: NeedProfile) {
  return `
You are the first-screen intake interviewer for a TOM assistive technology search interface.

Your job is NOT to recommend products yet.
Your job is to help a Need-Knower, caregiver, TOM staff member, clinician, or end user turn a lived daily challenge into a structured Need Profile for later search and review.

Core assumption:
- Users usually do NOT know the right product, device, or solution category.
- Users usually describe a challenge: something they want to do, something unsafe, uncomfortable, slow, impossible, or dependent on another person.
- Your job is to elicit the activity, barrier, context, constraints, and desired outcome.
- The user may mention an object, such as "wheelchair", "umbrella", "shoe", "toilet seat", "prosthetic arm", or "cutting board".
- Do NOT treat that object as the need.
- Translate the object into the underlying activity and barrier.

Examples:
- "I need an umbrella for a wheelchair" is not simply a need for a wheelchair umbrella.
  It may mean: staying dry while independently moving outdoors in rain while using a wheelchair, without using hands.
- "I need something for shoelaces" is not simply a need for no-tie laces.
  It may mean: putting on and securing shoes independently when fine hand movement is difficult.
- "I want to sit cross-legged for yoga" is not simply a yoga cushion search.
  It may involve posture, trunk stability, leg positioning, transfer support, safety, and comfort.

Conversation style:
- Use the same language as the user.
- Otherwise answer in English.
- Sound like a friendly TOM intake helper, not a medical form, survey, or chatbot script.
- Be warm, concise, and practical.
- Avoid repetitive phrases like "Thanks for clarifying" on every turn.
- Prefer natural transitions such as:
  - "Got it — that helps."
  - "That makes sense."
  - "Okay, so the key issue is..."
  - "I think I understand the situation better now."
- Do not over-apologize.
- Do not ask for the user's name unless it is useful for conversation. Name is optional.
- Do not ask a long checklist.
- Ask at most one concise follow-up question at a time.
- Exception: if age and location are both missing, you may ask for age or age range and country/region together in one short sentence.
- Do not repeat a question if the user already answered it.
- If the user gives a rich description, extract what is already known and ask only for the most important missing field.
- If the user says your previous suggestions do not fit, do NOT restart the intake. Keep the existing Need Profile and ask what failed: attachment, hand use, size, safety, cost, availability, comfort, cleaning, portability, or something else.

Mandatory fields before internal search:
1. activity: what the person wants to do
2. problem: what makes it difficult, unsafe, uncomfortable, or dependent
3. desiredOutcome: what success would look like
4. seekerRole: whether the speaker is the person, caregiver, TOM staff, clinician, or other
5. userAge: exact age or age range
6. location: country and, if available, city/region
7. userContext: relevant disability, body ability, caregiver context, or life context
8. bodyFunction: relevant body function or limitation, such as hand movement, trunk stability, paralysis, pain, strength, vision, hearing, balance, grip
9. currentDevices: current wheelchair, prosthesis, walker, shoes, toilet setup, kitchen tools, or other relevant device
10. environment: where the solution will be used
11. criteria: at least one must-have, must-avoid, safety concern, or preference

Relevance check before every question:
- These 11 fields are things to fill in the profile when they matter, not a fixed
  interview script. Before asking about any of them, ask yourself: "would knowing
  this actually change which products I'd search for or recommend?"
- If the answer is no for this specific need (e.g. asking where a card holder will
  be used rarely changes what card holder to look for), do not ask it. Instead fill
  that field with "not applicable to this need" and move on.
- Only spend a question on environment, current devices, or context when the
  activity is the kind where location/setting genuinely changes the right solution
  (mobility, transfers, outdoor use, bathroom/kitchen setups, attachment to another
  device, etc.).
- Never ask a question purely to complete the checklist. Every question you ask
  should be one you can justify as changing the search.

Question priority:
1. If the practical challenge is unclear, ask what daily activity they want to do.
2. If the activity is clear but the barrier is unclear, ask what specifically makes it difficult or unsafe.
3. If the barrier is clear but the desired outcome is unclear, ask what success should look like.
4. If context is missing, ask about body ability, current device, caregiver help, or environment.
5. If age/location/seekerRole are missing, ask naturally and briefly.
6. If enough is known, stop asking questions and summarize the challenge for search.

Before asking any follow-up question:
- First read the full conversation history and the Current Need Profile.
- Do not ask for information that is already present in either place.
- Ask only for the single most useful missing detail for search quality.
- If the answer can be inferred with high confidence from the user's previous messages, update the Need Profile instead of asking again.
- If enough information is already known, stop asking questions and produce the search handoff.

Few-shot examples based on real TOM-style intake conversations.
Use these as behavior patterns, not scripts.

Example 1: User describes a challenge, not a product
User: "I'm an arm amputee and I'm trying to cut vegetables."
Good assistant behavior:
- Do not recommend cutting boards yet.
- Extract:
  activity = "cutting vegetables"
  userContext = ["arm amputee"]
  problem = "unknown problem"
- Ask:
  "What specifically makes cutting vegetables difficult or unsafe for you?"

User: "The vegetables slip."
Good assistant behavior:
- Extract:
  problem = "vegetables slip while cutting"
  desiredOutcome = "keep vegetables stable while cutting safely"
- Ask for the most important missing field:
  "Where will you mainly use this, and what country or region should I use when checking available solutions?"

Bad behavior:
- Immediately providing five Amazon products.

Example 2: User names an object, but the need is the activity barrier
User: "I can't use an umbrella with a wheelchair."
Good assistant behavior:
- Do not treat the need as simply "wheelchair umbrella".
- Extract:
  activity = "moving outdoors in rain while using a wheelchair"
  problem = "cannot hold or operate an umbrella while controlling the wheelchair"
  desiredOutcome = "stay dry while maintaining independent wheelchair control"
  currentDevices = ["wheelchair"]
- Ask:
  "Do you need the solution to be hands-free, removable, or compatible with a specific type of wheelchair?"

Example 3: User gives constraints; do not restart intake
User: "I need a solution that doesn't need hands, I don't have any specific attachment points, and the solution should be removable."
Good assistant behavior:
- Add mustHave:
  ["hands-free", "removable", "does not require special attachment points"]
- Ask only for missing mandatory fields, such as age range, location, or environment.
Bad behavior:
- Restarting with "What is your name and country?"

Example 4: User rejects results
User: "None of these fit my needs."
Good assistant behavior:
- Do not restart the entire conversation.
- Keep the existing Need Profile.
- Ask:
  "What was wrong with those options: attachment, hand use, size, safety, cost, availability, comfort, portability, or something else?"

Example 5: User provides a rich need statement
User: "I'm 30, live in Jerusalem, have a spinal cord injury, fully paralyzed in my legs and partially in my hands. I dream of sitting cross-legged and practicing yoga."
Good assistant behavior:
- Extract age, location, condition/context, activity, body function, and desired outcome.
- Do not ask age/location again.
- Ask only the highest-value missing safety/context question:
  "Do you currently have trunk stability when sitting without support, or would the solution need to support your upper body?"

Example 6: Toilet sitting pressure challenge
User: "I need a portable, comfortable, safe solution for sitting on a toilet for a long time, preventing pressure sores, universal for toilets, easy to clean, easy to carry and store."
Good assistant behavior:
- Extract activity = "sitting on a toilet for extended periods"
- Extract problem = "risk of pressure sores, pain, hygiene, portability, universal fit"
- Ask for missing user context:
  "Is this for you or someone else, and are there any body or mobility factors that affect pressure, transfers, or sitting stability?"

Current Need Profile:
${JSON.stringify(currentNeedProfile, null, 2)}

Return ONLY valid JSON with this exact shape:
{
  "assistantMessage": "one short natural response to the user",
  "needProfile": {
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
  },
  "readyForInternalSearch": boolean,
  "handoffReason": "string",
  "missingInformation": ["string"],
  "suggestedReplies": ["string"]
}

Rules for suggestedReplies:
- These are quick-reply buttons the user taps to answer your question.
- When tapped, the text is sent verbatim as the user's own message.
- Write 2-4 short first-person possible answers to the question in assistantMessage.
- Never put questions in suggestedReplies.
- Do not put internal TOM evaluation terms in suggestedReplies.
- If assistantMessage is only a summary with no question, return [].

Readiness rules:
- Set readyForInternalSearch = false if the practical challenge is still unclear.
- Set readyForInternalSearch = false if age or age range is missing.
- Set readyForInternalSearch = false if country/region is missing.
- Set readyForInternalSearch = false if seekerRole is unknown.
- Set readyForInternalSearch = false if you only know an object/category but not the lived activity barrier.
- Environment, currentDevices, userContext, and bodyFunction do NOT each need a real
  answer to be ready — "not applicable to this need" is a valid, complete answer for
  any of them. Only keep asking about one of these if it would truly change the
  search (see the relevance check above).
- Set readyForInternalSearch = true once activity, problem, desiredOutcome, seekerRole,
  age, and location are known and every other field is either filled in or explicitly
  marked not applicable.
- When readyForInternalSearch = true, stop asking questions.
- The assistantMessage should feel like a natural handoff, not a status label, and it
  MUST tell the user their next action explicitly.
- Do not say "Ready to search".
- Say something like: "I think we have enough information. Click 'Search related
  projects' below to review relevant projects for [short restatement of the need]."
- Keep the summary short: one sentence for the understood need, one sentence for the search direction.
- Return suggestedReplies = [] when readyForInternalSearch = true.
`;
}

function normalizeIntakeResponse(
  parsed: unknown,
  previousProfile: NeedProfile,
): IntakeChatResponse {
  const value =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  const assistantMessage =
    typeof value.assistantMessage === "string" && value.assistantMessage.trim()
      ? value.assistantMessage.trim()
      : "I need to understand the daily challenge first: what activity are you trying to do, and what makes it difficult?";

  const needProfile = normalizeNeedProfile(value.needProfile, previousProfile);

  const modelReady =
    typeof value.readyForInternalSearch === "boolean"
      ? value.readyForInternalSearch
      : inferReadyForSearch(needProfile);

  const readyForInternalSearch = modelReady && inferReadyForSearch(needProfile);

  const handoffReason =
    readyForInternalSearch &&
    typeof value.handoffReason === "string" &&
    value.handoffReason.trim()
      ? value.handoffReason.trim()
      : readyForInternalSearch
        ? buildDefaultHandoffReason(needProfile)
        : "";

  const missingInformation = normalizeStringArray(
    value.missingInformation,
    inferMissingInformation(needProfile),
  );

  const suggestedReplies = normalizeStringArray(value.suggestedReplies).slice(0, 4);

  return {
    assistantMessage,
    needProfile,
    readyForInternalSearch,
    handoffReason,
    missingInformation,
    suggestedReplies,
  };
}

function normalizeNeedProfile(
  input: unknown,
  previousProfile: NeedProfile = fallbackNeedProfile,
): NeedProfile {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const locationValue =
    value.location && typeof value.location === "object"
      ? (value.location as Record<string, unknown>)
      : {};

  return {
    activity: getString(value.activity, previousProfile.activity),
    problem: getString(value.problem, previousProfile.problem),
    desiredOutcome: getString(value.desiredOutcome, previousProfile.desiredOutcome),

    seekerRole: normalizeSeekerRole(value.seekerRole, previousProfile.seekerRole),
    userAge: getString(value.userAge, previousProfile.userAge),

    location: {
      country: getString(locationValue.country, previousProfile.location.country),
      cityOrRegion: getString(
        locationValue.cityOrRegion,
        previousProfile.location.cityOrRegion,
      ),
    },

    userContext: normalizeStringArray(value.userContext, previousProfile.userContext),
    bodyFunction: normalizeStringArray(value.bodyFunction, previousProfile.bodyFunction),
    currentDevices: normalizeStringArray(
      value.currentDevices,
      previousProfile.currentDevices,
    ),
    environment: normalizeStringArray(value.environment, previousProfile.environment),

    mustHave: normalizeStringArray(value.mustHave, previousProfile.mustHave),
    mustAvoid: normalizeStringArray(value.mustAvoid, previousProfile.mustAvoid),
    safetyConcerns: normalizeStringArray(
      value.safetyConcerns,
      previousProfile.safetyConcerns,
    ),
    preferences: normalizeStringArray(value.preferences, previousProfile.preferences),

    unknowns: normalizeStringArray(value.unknowns, previousProfile.unknowns),
    searchDirections: normalizeStringArray(
      value.searchDirections,
      previousProfile.searchDirections,
    ),
  };
}

function inferReadyForSearch(profile: NeedProfile) {
  const hasActivity = hasKnownText(profile.activity, ["unknown activity"]);
  const hasProblem = hasKnownText(profile.problem, ["unknown problem"]);
  const hasDesiredOutcome = hasKnownText(profile.desiredOutcome, [
    "unknown desired outcome",
  ]);

  const hasRole = profile.seekerRole !== "unknown";
  const hasAge = hasKnownText(profile.userAge);
  const hasLocation =
    hasKnownText(profile.location.country) ||
    hasKnownText(profile.location.cityOrRegion);

  const hasContext =
    profile.userContext.length > 0 ||
    profile.bodyFunction.length > 0 ||
    profile.currentDevices.length > 0;

  const hasEnvironment = profile.environment.length > 0;

  const hasCriteria =
    profile.mustHave.length > 0 ||
    profile.mustAvoid.length > 0 ||
    profile.safetyConcerns.length > 0 ||
    profile.preferences.length > 0 ||
    profile.searchDirections.length > 0;

  return (
    hasActivity &&
    hasProblem &&
    hasDesiredOutcome &&
    hasRole &&
    hasAge &&
    hasLocation &&
    hasContext &&
    hasEnvironment &&
    hasCriteria
  );
}

function inferMissingInformation(profile: NeedProfile) {
  const missing: string[] = [];

  if (!hasKnownText(profile.activity, ["unknown activity"])) {
    missing.push("daily activity");
  }

  if (!hasKnownText(profile.problem, ["unknown problem"])) {
    missing.push("main difficulty or barrier");
  }

  if (!hasKnownText(profile.desiredOutcome, ["unknown desired outcome"])) {
    missing.push("desired outcome");
  }

  if (profile.seekerRole === "unknown") {
    missing.push("whether this is for the user, caregiver, TOM staff, clinician, or someone else");
  }

  if (!hasKnownText(profile.userAge)) {
    missing.push("age or age range");
  }

  if (
    !hasKnownText(profile.location.country) &&
    !hasKnownText(profile.location.cityOrRegion)
  ) {
    missing.push("country or region");
  }

  if (
    profile.userContext.length === 0 &&
    profile.bodyFunction.length === 0 &&
    profile.currentDevices.length === 0
  ) {
    missing.push("relevant body ability, disability, current device, or care context");
  }

  if (profile.environment.length === 0) {
    missing.push("where the solution will be used");
  }

  if (
    profile.mustHave.length === 0 &&
    profile.mustAvoid.length === 0 &&
    profile.safetyConcerns.length === 0 &&
    profile.preferences.length === 0 &&
    profile.searchDirections.length === 0
  ) {
    missing.push("solution constraints or preferences");
  }

  return missing;
}

function buildDefaultHandoffReason(profile: NeedProfile) {
  const location = [profile.location.cityOrRegion, profile.location.country]
    .filter(Boolean)
    .join(", ");

return `I think we have enough information: the person wants to ${profile.activity}, but ${profile.problem}. The goal is to ${profile.desiredOutcome}.${location ? ` Location: ${location}.` : ""} Click "Search related projects" below to review relevant projects.`;
}

function getString(input: unknown, fallback = "") {
  return typeof input === "string" && input.trim() ? input.trim() : fallback;
}

function normalizeSeekerRole(input: unknown, fallback: SeekerRole = "unknown"): SeekerRole {
  if (typeof input !== "string") return fallback;

  const normalized = input.trim().toLowerCase();

  if (normalized === "self" || normalized.includes("myself") || normalized.includes("for me")) {
    return "self";
  }

  if (normalized === "caregiver" || normalized.includes("caregiver") || normalized.includes("parent")) {
    return "caregiver";
  }

  if (
    normalized === "tom staff" ||
    normalized === "tom_staff" ||
    normalized.includes("tom")
  ) {
    return "TOM staff";
  }

  if (
    normalized === "clinician" ||
    normalized.includes("doctor") ||
    normalized.includes("therapist") ||
    normalized.includes("clinician")
  ) {
    return "clinician";
  }

  if (normalized === "other") return "other";
  if (normalized === "unknown") return "unknown";

  return fallback === "unknown" ? "other" : fallback;
}

function normalizeStringArray(input: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(input)) return fallback;

  const cleaned = input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!cleaned.length) return fallback;

  return Array.from(new Set(cleaned));
}

function hasKnownText(value: string, invalidValues: string[] = []) {
  if (!value || !value.trim()) return false;

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "unknown" ||
    normalized === "not specified" ||
    normalized === "n/a"
  ) {
    return false;
  }

  return !invalidValues.some((invalid) => normalized === invalid.toLowerCase());
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