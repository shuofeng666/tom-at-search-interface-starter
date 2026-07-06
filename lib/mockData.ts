import { NeedProfile } from "./types";

export const demoNeedProfile: NeedProfile = {
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
    "what success should look like",
    "age or age range",
    "country or region",
    "where the solution will be used",
  ],

  searchDirections: [],
};