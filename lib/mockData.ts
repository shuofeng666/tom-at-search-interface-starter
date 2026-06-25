import { NeedProfile } from "./types";

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