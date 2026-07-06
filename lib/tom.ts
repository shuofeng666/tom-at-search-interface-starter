import {
  CandidateProject,
  emptyCandidateEvaluation,
  NeedProfile
} from "./types";

type TomSearchResponse = {
  projects?: {
    totalNumberOfPages?: number;
    items?: TomProject[];
  };
};

type TomProject = {
  _id: string;
  projectName?: string;
  challengeName?: string;
  description?: string;
  resources?: string;
  downloadLink?: string;
  thumbnailImageUrl?: string;
  imagesUrls?: string[];
  type?: number;
  technicalRequirements?: string[];
  additionalInformation?: {
    challengeDetails?: string;
    disabledPersonDetails?: string;
    teamRequirements?: string;
    teamName?: string;
    challengeImage?: string;
  };
};

export async function searchTomProjects({
  needProfile,
  limit = 15
}: {
  needProfile: NeedProfile;
  limit?: number;
}): Promise<CandidateProject[]> {
  const endpoint = process.env.TOM_SEARCH_API_URL;

  if (!endpoint) {
    console.warn("Missing TOM_SEARCH_API_URL. TOM projects will be skipped.");
    return [];
  }

  const query = buildTomUserInput(needProfile);

  const candidatesWithQuery = await fetchTomProjectCandidates({
    endpoint,
    userInput: query,
    limit
  });

  // If TOM's own search is too strict, fall back to the type=5 project library.
  if (candidatesWithQuery.length >= 3 || !query) {
    return candidatesWithQuery;
  }

  const fallbackCandidates = await fetchTomProjectCandidates({
    endpoint,
    userInput: "",
    limit
  });

  return mergeTomCandidates(candidatesWithQuery, fallbackCandidates);
}

async function fetchTomProjectCandidates({
  endpoint,
  userInput,
  limit
}: {
  endpoint: string;
  userInput: string;
  limit: number;
}): Promise<CandidateProject[]> {
  const url = new URL(endpoint);

  url.searchParams.set("skip", "0");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("selectedTypes", "5");
  url.searchParams.set("userInput", userInput || "undefined");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("TOM API error:", text);
    return [];
  }

  const data = (await res.json()) as TomSearchResponse;
  const items = data.projects?.items || [];

  console.log(
    "TOM official project results",
    items.map((item) => ({
      id: item._id,
      title: item.projectName || item.challengeName
    }))
  );

  return items.map(buildTomCandidate);
}

function buildTomCandidate(project: TomProject): CandidateProject {
  const title =
    project.projectName ||
    project.challengeName ||
    project.additionalInformation?.teamName ||
    "Untitled TOM project";

  const url = `https://tomglobal.org/project?id=${project._id}`;

  const image =
    project.imagesUrls?.[0] ||
    project.additionalInformation?.challengeImage ||
    project.thumbnailImageUrl ||
    undefined;

  const rawText = [
    title,
    project.challengeName,
    project.description,
    project.additionalInformation?.disabledPersonDetails,
    project.additionalInformation?.challengeDetails,
    project.additionalInformation?.teamRequirements,
    project.technicalRequirements?.length
      ? `Technical requirements: ${project.technicalRequirements.join(", ")}`
      : "",
    project.downloadLink ? `Download link: ${project.downloadLink}` : "",
    stripHtml(project.resources || "")
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    id: project._id,
    title,
    url,
    source: "tomglobal.org",
    sourceType: "TOM project",
    image,
    summary:
      project.description ||
      project.additionalInformation?.challengeDetails ||
      trimText(rawText, 420),
    rawText,
    evaluation: emptyCandidateEvaluation()
  };
}

function buildTomUserInput(needProfile: NeedProfile) {
  const parts = [
    needProfile.activity,
    needProfile.problem,
    needProfile.desiredOutcome,
    ...needProfile.currentDevices,
    ...needProfile.bodyFunction,
    ...needProfile.mustHave
  ];

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part) =>
        part !== "unknown activity" &&
        part !== "unknown problem" &&
        part !== "unknown desired outcome"
    )
    .join(" ");
}

function mergeTomCandidates(
  primary: CandidateProject[],
  fallback: CandidateProject[]
) {
  const seen = new Set<string>();
  const merged: CandidateProject[] = [];

  for (const candidate of [...primary, ...fallback]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
  }

  return merged;
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}