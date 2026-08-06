export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

export type SeekerRole =
  | "self"
  | "caregiver"
  | "TOM staff"
  | "clinician"
  | "other"
  | "unknown";

export type NeedLocation = {
  country: string;
  cityOrRegion: string;
};

export type NeedProfile = {
  // Core lived challenge
  activity: string;
  problem: string;
  desiredOutcome: string;

  // Mandatory intake fields
  seekerRole: SeekerRole;
  userAge: string;
  location: NeedLocation;

  // Context
  userContext: string[];
  bodyFunction: string[];
  currentDevices: string[];
  environment: string[];

  // Criteria
  mustHave: string[];
  mustAvoid: string[];
  safetyConcerns: string[];
  preferences: string[];

  // Process
  unknowns: string[];
  searchDirections: string[];
};

export type IntakeChatResponse = {
  assistantMessage: string;
  needProfile: NeedProfile;
  readyForInternalSearch: boolean;
  handoffReason: string;
  missingInformation: string[];
  suggestedReplies: string[];
};

export type CandidateSourceType =
  | "TOM project"
  | "commercial product"
  | "DIY project"
  | "open-source project"
  | "research prototype"
  | "adjacent product"
  | "unknown";

export type TomPathway =
  | "can recommend"
  | "needs more information"
  | "reference only"
  | "needs adaptation"
  | "maker team review"
  | "possible new TOM challenge"
  | "not recommended yet";

export type EvaluationDimension = {
  score: number;
  explanation: string;
  evidence?: string[];
};

export type CostTier = "free-diy" | "low" | "moderate" | "high" | "unknown";

export type CostEstimate = {
  tier: CostTier;
  note: string;
};

export type CandidateEvaluation = {
  overallScore: number;

  // AT fit assessment dimensions, not competition judging dimensions.
  needFit: EvaluationDimension;
  criticalRequirements: EvaluationDimension;
  contextFit: EvaluationDimension;
  accessPathway: EvaluationDimension;
  adaptationFeasibility: EvaluationDimension;
  evidenceQuality: EvaluationDimension;
  safetyAndRisk: EvaluationDimension;

  // Descriptive only — not part of the 0-3 scored dimensions above or the
  // weighted overallScore.
  costEstimate: CostEstimate;

  hardFailures: string[];
  matchedCriteria: string[];
  unmatchedCriteria: string[];
  missingInformation: string[];
  riskFlags: string[];

  pathway: TomPathway;
  pathwayReason: string;
};

export type CandidateProject = {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceType: CandidateSourceType;
  image?: string;
  summary: string;
  rawText?: string;
  category?: string;
  evaluation: CandidateEvaluation;
  saved?: boolean;
  rejected?: boolean;
  rejectionReason?: string;
};

export type SearchResponse = {
  query: string;
  candidates: CandidateProject[];
  usedMockData?: boolean;
};

export type ReviewSummary = {
  needSummary: string;
  closestMatches: string[];
  weakMatches: string[];
  mainGaps: string[];
  keyRisks: string[];
  recommendedPathway: string;
  nextActionsForTomTeam: string[];
  nextQuestionsForNeedKnower: string[];
  userFacingMessage: string;
};

export type ExaSearchResult = {
  id?: string;
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  summary?: string;
  highlights?: string[];
  image?: string;
  extras?: {
    imageLinks?: string[];
  };
};

export type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

export type GeminiJsonResponse<T> = T;

export function emptyNeedProfile(): NeedProfile {
  return {
    activity: "unknown activity",
    problem: "unknown problem",
    desiredOutcome: "unknown desired outcome",

    seekerRole: "unknown",
    userAge: "",
    location: {
      country: "",
      cityOrRegion: "",
    },

    userContext: [],
    bodyFunction: [],
    currentDevices: [],
    environment: [],

    mustHave: [],
    mustAvoid: [],
    safetyConcerns: [],
    preferences: [],

    unknowns: [
      "what activity the person wants to do",
      "what makes the activity difficult",
      "where the solution will be used",
      "age or age range",
      "country or region",
    ],
    searchDirections: [],
  };
}

export function emptyEvaluationDimension(): EvaluationDimension {
  return {
    score: 0,
    explanation: "No evidence available yet.",
    evidence: [],
  };
}

export function emptyCandidateEvaluation(): CandidateEvaluation {
  return {
    overallScore: 0,
    needFit: emptyEvaluationDimension(),
    criticalRequirements: emptyEvaluationDimension(),
    contextFit: emptyEvaluationDimension(),
    accessPathway: emptyEvaluationDimension(),
    adaptationFeasibility: emptyEvaluationDimension(),
    evidenceQuality: emptyEvaluationDimension(),
    safetyAndRisk: emptyEvaluationDimension(),
    costEstimate: { tier: "unknown", note: "Cost not assessed yet." },
    hardFailures: [],
    matchedCriteria: [],
    unmatchedCriteria: [],
    missingInformation: [],
    riskFlags: [],
    pathway: "needs more information",
    pathwayReason: "The project has not been evaluated yet.",
  };
}