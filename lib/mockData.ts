import { CandidateProject, NeedProfile } from "./types";

export const demoNeedProfile: NeedProfile = {
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

export const mockCandidates: CandidateProject[] = [
  {
    id: "mock-one-handed-board",
    title: "One-handed food preparation board",
    url: "https://www.tomchallenge.org/",
    source: "Mock TOM / external reference",
    sourceType: "adjacent product",
    summary:
      "A kitchen board concept that helps stabilize food during cutting, usually through raised edges, spikes, clamps, or non-slip surfaces.",
    rawText:
      "Adaptive food preparation boards are often used for one-handed cooking. They may include spikes, clamps, suction feet, raised corners, or non-slip areas.",
    evaluation: {
      overallScore: 2.4,
      needMatch: {
        score: 3,
        explanation:
          "The project direction matches a need involving food stabilization during one-handed preparation.",
        evidence: ["Targets kitchen preparation and object stabilization."]
      },
      functionalFit: {
        score: 3,
        explanation:
          "It can address slipping food during cutting if the user can position food safely.",
        evidence: ["Includes stabilization features such as clamps or spikes."]
      },
      accessibilityManufacturability: {
        score: 2,
        explanation:
          "The mechanism is likely manufacturable, but exact files and dimensions are not confirmed.",
        evidence: ["Could be made with simple materials or 3D printed parts."]
      },
      affordabilityAvailability: {
        score: 2,
        explanation:
          "Similar products are commonly available, but local availability and cost still need checking.",
        evidence: []
      },
      qualityOfSolution: {
        score: 2,
        explanation:
          "The general solution type is established, but this specific result needs evidence of durability.",
        evidence: []
      },
      documentationQuality: {
        score: 1,
        explanation:
          "The current record is a reference direction, not a fully documented project.",
        evidence: []
      },
      userTestingEvidence: {
        score: 1,
        explanation:
          "No direct Need-Knower testing record is available in this mock result.",
        evidence: []
      },
      safetyRisk: {
        score: 2,
        explanation:
          "Knife use and exposed spikes or clamps should be reviewed for user-specific safety.",
        evidence: ["Potential knife and puncture risk."]
      },
      customizationPotential: {
        score: 3,
        explanation:
          "Board size, clamp style, and material can likely be adapted.",
        evidence: []
      },
      matchedCriteria: ["one-handed use", "food stabilization", "kitchen use"],
      unmatchedCriteria: [],
      missingInformation: [
        "exact dimensions",
        "materials",
        "cleaning instructions",
        "user testing"
      ],
      riskFlags: ["knife safety", "cleaning", "puncture risk"],
      pathway: "needs adaptation",
      pathwayReason:
        "Useful as a direction, but TOM should confirm safety, documentation, and user-specific fit before recommending it."
    }
  },
  {
    id: "mock-wheelchair-rain",
    title: "Wheelchair rain protection mount",
    url: "https://www.tomchallenge.org/",
    source: "Mock commercial / DIY reference",
    sourceType: "adjacent product",
    summary:
      "A rain protection direction for wheelchair users, often using an umbrella mount, canopy, or wearable rain cover.",
    rawText:
      "Wheelchair umbrella holders and canopies may attach to wheelchair frames. Many require clamps, fixed mounting points, or manual adjustment.",
    evaluation: {
      overallScore: 1.8,
      needMatch: {
        score: 2,
        explanation:
          "The project direction relates to wheelchair rain protection, but attachment and hands-free requirements need review.",
        evidence: []
      },
      functionalFit: {
        score: 2,
        explanation:
          "It may keep the user dry, but many versions require manual adjustment or fixed frame attachment.",
        evidence: []
      },
      accessibilityManufacturability: {
        score: 2,
        explanation:
          "Mounts are usually simple to fabricate, but stability and compatibility are difficult.",
        evidence: []
      },
      affordabilityAvailability: {
        score: 2,
        explanation:
          "Commercial options exist, but local shipping and fit are uncertain.",
        evidence: []
      },
      qualityOfSolution: {
        score: 1,
        explanation:
          "Outdoor stability is unclear without testing.",
        evidence: []
      },
      documentationQuality: {
        score: 1,
        explanation:
          "The current record lacks detailed installation, compatibility, and testing information.",
        evidence: []
      },
      userTestingEvidence: {
        score: 0,
        explanation:
          "No real user test is available in this mock result.",
        evidence: []
      },
      safetyRisk: {
        score: 1,
        explanation:
          "Wind, visibility, attachment failure, and interference with wheelchair operation need review.",
        evidence: []
      },
      customizationPotential: {
        score: 2,
        explanation:
          "Could be adapted, but wheelchair geometries vary a lot.",
        evidence: []
      },
      matchedCriteria: ["wheelchair use", "rain protection"],
      unmatchedCriteria: ["no fixed attachment not confirmed", "hands-free not confirmed"],
      missingInformation: [
        "wheelchair compatibility",
        "removability",
        "wind stability",
        "hands-free operation"
      ],
      riskFlags: ["wind stability", "mobility safety", "mount failure"],
      pathway: "maker team review",
      pathwayReason:
        "The direction is relevant but too uncertain for direct recommendation."
    }
  }
];