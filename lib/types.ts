export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

export type NeedProfile = {
  activity: string;
  problem: string;
  userContext: string[];
  environment: string[];
  mustHave: string[];
  mustAvoid: string[];
  safetyConcerns: string[];
  preferences: string[];
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

export type CandidateEvaluation = {
  overallScore: number;

  needMatch: EvaluationDimension;
  functionalFit: EvaluationDimension;
  accessibilityManufacturability: EvaluationDimension;
  affordabilityAvailability: EvaluationDimension;
  qualityOfSolution: EvaluationDimension;
  documentationQuality: EvaluationDimension;
  userTestingEvidence: EvaluationDimension;
  safetyRisk: EvaluationDimension;
  customizationPotential: EvaluationDimension;

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
};

export type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

export type GeminiJsonResponse<T> = T;

export function emptyNeedProfile(): NeedProfile {
  return {
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
}

export function emptyEvaluationDimension(): EvaluationDimension {
  return {
    score: 0,
    explanation: "No evidence available yet.",
    evidence: []
  };
}

export function emptyCandidateEvaluation(): CandidateEvaluation {
  return {
    overallScore: 0,

    needMatch: emptyEvaluationDimension(),
    functionalFit: emptyEvaluationDimension(),
    accessibilityManufacturability: emptyEvaluationDimension(),
    affordabilityAvailability: emptyEvaluationDimension(),
    qualityOfSolution: emptyEvaluationDimension(),
    documentationQuality: emptyEvaluationDimension(),
    userTestingEvidence: emptyEvaluationDimension(),
    safetyRisk: emptyEvaluationDimension(),
    customizationPotential: emptyEvaluationDimension(),

    matchedCriteria: [],
    unmatchedCriteria: [],
    missingInformation: [],
    riskFlags: [],

    pathway: "needs more information",
    pathwayReason: "The project has not been evaluated yet."
  };
}