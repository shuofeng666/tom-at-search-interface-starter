"use client";

import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CandidateProject,
  ChatMessage,
  IntakeChatResponse,
  NeedProfile,
  ReviewSummary,
} from "@/lib/types";
import { emptyNeedProfile } from "@/lib/types";
import {
  SearchHistoryEntry,
  deleteSearchHistoryEntry,
  loadSavedProjects,
  loadSearchHistory,
  removeSavedProject,
  saveProjectGlobally,
  upsertSearchHistory,
} from "@/lib/clientStorage";

type Stage = "intake" | "review" | "output";

// Phase 1 returns an unscored pool; we score PAGE_SIZE at a time (first page +
// each "Load more").
type SearchPoolResponse = {
  query: string;
  pool: CandidateProject[];
  tomCatalogSnapshotDate: string | null;
};

const PAGE_SIZE = 10;

// A search should land with a reasonable number of results, not whatever
// happened to clear the bar in a single batch — but scoring each extra page
// costs real time (a full round of Gemini calls), and "search is slow" is a
// direct complaint, so this is deliberately a modest floor, not a generous
// one. TOM has its own floor within the total — this is TOM's own search
// interface, so "6 total but only 1 is TOM" isn't good enough — but capped
// at 2 rounds so a weak pool can't turn into 4 rounds of waiting.
const MIN_TOTAL_VISIBLE_TARGET = 6;
const MIN_TOM_VISIBLE_TARGET = 4;
const MAX_AUTO_SCORE_BATCHES = 2;

// Matches the @media breakpoint in globals.css that collapses .workspaceGrid
// to a single column - the resizable divider only makes sense above it.
const DESKTOP_LAYOUT_QUERY = "(min-width: 1181px)";
const DETAIL_PANEL_WIDTH_KEY = "tom-detail-panel-width-v1";
const DEFAULT_DETAIL_PANEL_WIDTH = 400;
const MIN_DETAIL_PANEL_WIDTH = 300;
const MAX_DETAIL_PANEL_WIDTH = 640;

function clampDetailPanelWidth(width: number) {
  return Math.min(
    MAX_DETAIL_PANEL_WIDTH,
    Math.max(MIN_DETAIL_PANEL_WIDTH, width),
  );
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const MIN_VISIBLE_SCORE = 1;
const MIN_VISIBLE_TOM_SCORE = 1;

function isTomCandidate(candidate: CandidateProject) {
  const sourceText = `${candidate.source} ${candidate.url} ${candidate.sourceType}`.toLowerCase();

  return (
    candidate.sourceType === "TOM project" ||
    sourceText.includes("tomglobal.org")
  );
}

const COST_TIER_LABELS: Record<string, string> = {
  "free-diy": "Free / DIY materials",
  low: "Low cost",
  moderate: "Moderate cost",
  high: "High cost",
  unknown: "Unknown",
};

function costLabel(candidate: CandidateProject) {
  const cost = candidate.evaluation?.costEstimate;
  if (!cost) return "Unknown";

  const tierLabel = COST_TIER_LABELS[cost.tier] || "Unknown";
  return cost.note ? `${tierLabel} — ${cost.note}` : tierLabel;
}

function needsTomTeamLabel(candidate: CandidateProject) {
  switch (candidate.evaluation?.pathway) {
    case "needs adaptation":
    case "maker team review":
    case "possible new TOM challenge":
      return "Yes";
    case "needs more information":
      return "Maybe";
    case "can recommend":
    case "reference only":
      return "No";
    default:
      return "Unknown";
  }
}

function normalizeTitleForDedupe(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyDuplicateTitle(a: string, b: string): boolean {
  const na = normalizeTitleForDedupe(a);
  const nb = normalizeTitleForDedupe(b);
  if (na.length < 4 || nb.length < 4) return na === nb;

  return na === nb || na.includes(nb) || nb.includes(na);
}

// Same solution can legitimately be both a TOM project and cross-posted to
// e.g. Printables/Instructables — when titles match closely, keep only the
// TOM one rather than showing the same thing twice.
function dedupeExternalAgainstTom(
  tomCandidates: CandidateProject[],
  externalCandidates: CandidateProject[],
): CandidateProject[] {
  return externalCandidates.filter(
    (external) =>
      !tomCandidates.some((tom) =>
        isLikelyDuplicateTitle(tom.title, external.title),
      ),
  );
}

function splitCategories(category?: string): string[] {
  if (!category) return [];
  return category
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sortCandidateList(
  list: CandidateProject[],
  mode: "best" | "az",
): CandidateProject[] {
  if (mode === "az") {
    return [...list].sort((a, b) => a.title.localeCompare(b.title));
  }
  return list;
}

function evaluationText(candidate: CandidateProject) {
  return [
    candidate.evaluation?.needFit?.explanation,
    candidate.evaluation?.criticalRequirements?.explanation,
    candidate.evaluation?.contextFit?.explanation,
    candidate.evaluation?.accessPathway?.explanation,
    candidate.evaluation?.adaptationFeasibility?.explanation,
    candidate.evaluation?.evidenceQuality?.explanation,
    candidate.evaluation?.safetyAndRisk?.explanation,
    candidate.evaluation?.pathwayReason,
    ...(candidate.evaluation?.hardFailures || []),
    ...(candidate.evaluation?.matchedCriteria || []),
    ...(candidate.evaluation?.unmatchedCriteria || []),
    ...(candidate.evaluation?.riskFlags || [])
  ]
    .join(" ")
    .toLowerCase();
}

function isClearlyBadMatch(candidate: CandidateProject) {
  const text = evaluationText(candidate);

  return (
    text.includes("completely unrelated") ||
    text.includes("does not address") ||
    text.includes("does not meet") ||
    text.includes("does not match") ||
    text.includes("contrary to the need") ||
    text.includes("not an actual solution") ||
    text.includes("non-solution") ||
    text.includes("weak fit") ||
    text.includes("very low") ||
    text.includes("no individual impact")
  );
}

function isVisibleCandidate(candidate: CandidateProject) {
  const score = candidate.evaluation?.overallScore ?? 0;

  if (isTomCandidate(candidate)) {
    return score >= MIN_VISIBLE_TOM_SCORE && !isClearlyBadMatch(candidate);
  }

  return score >= MIN_VISIBLE_SCORE;
}

function candidateDisplayScore(candidate: CandidateProject) {
  const score = candidate.evaluation?.overallScore ?? 0;
  const badMatchPenalty = isClearlyBadMatch(candidate) ? 4 : 0;

  return score - badMatchPenalty;
}

// TOM projects always lead the list (this is TOM's own search interface), then
// everything else is ranked by fit score within its group.
function sortDisplayCandidates(candidates: CandidateProject[]) {
  return [...candidates].sort((a, b) => {
    const aTom = isTomCandidate(a) ? 1 : 0;
    const bTom = isTomCandidate(b) ? 1 : 0;

    if (aTom !== bTom) return bTom - aTom;

    return candidateDisplayScore(b) - candidateDisplayScore(a);
  });
}

// Guarantee both the TOM panel and the "other related work" panel have
// something in them even when a group didn't clear the normal visibility
// bar: backfill with that group's best-scoring candidates that aren't a
// clear mismatch. Never backfills with a candidate flagged as a clear
// mismatch — a guaranteed slot still has to be a plausible fit, and this can
// only pull from candidates already scored in this batch, so it's a
// best-effort floor, not an absolute guarantee.
const MIN_GUARANTEED_TOM_VISIBLE = 4;
const MIN_GUARANTEED_EXTERNAL_VISIBLE = 2;

function backfillGroup(
  scored: CandidateProject[],
  visible: CandidateProject[],
  visibleIds: Set<string>,
  isInGroup: (candidate: CandidateProject) => boolean,
  minVisible: number,
) {
  const visibleCount = visible.filter(isInGroup).length;
  if (visibleCount >= minVisible) return [];

  return scored
    .filter(
      (candidate) =>
        isInGroup(candidate) &&
        !visibleIds.has(candidate.id) &&
        !isClearlyBadMatch(candidate),
    )
    .sort(
      (a, b) =>
        (b.evaluation?.overallScore ?? 0) - (a.evaluation?.overallScore ?? 0),
    )
    .slice(0, minVisible - visibleCount);
}

function prepareVisibleCandidates(scored: CandidateProject[]) {
  const visible = scored.filter(isVisibleCandidate);
  const visibleIds = new Set(visible.map((candidate) => candidate.id));

  const tomBackfill = backfillGroup(
    scored,
    visible,
    visibleIds,
    isTomCandidate,
    MIN_GUARANTEED_TOM_VISIBLE,
  );

  const externalBackfill = backfillGroup(
    scored,
    visible,
    visibleIds,
    (candidate) => !isTomCandidate(candidate),
    MIN_GUARANTEED_EXTERNAL_VISIBLE,
  );

  return sortDisplayCandidates([...visible, ...tomBackfill, ...externalBackfill]);
}

function fitHeading(candidate: CandidateProject) {
  const score = candidate.evaluation?.overallScore ?? 0;

  if (score >= MIN_VISIBLE_TOM_SCORE && !isClearlyBadMatch(candidate)) {
    return "Why it may help";
  }

  return "Fit assessment";
}

function fitAssessmentText(candidate: CandidateProject) {
  return (
    candidate.evaluation.needFit.explanation ||
    candidate.evaluation.pathwayReason ||
    candidate.summary
  );
}

function adaptationText(candidate: CandidateProject) {
  return (
    candidate.evaluation.adaptationFeasibility.explanation ||
    "No adaptation assessment available yet."
  );
}




const rejectionOptions = [
  { value: "requires-hand-use", label: "requires too much hand use" },
  { value: "not-removable", label: "not removable" },
  { value: "not-compatible", label: "does not fit the user/device/context" },
  { value: "hard-to-clean", label: "hard to clean or maintain" },
  { value: "not-safe", label: "possible safety risk" },
  { value: "too-expensive", label: "too expensive" },
  { value: "not-portable", label: "not portable" },
  { value: "not-available", label: "not available locally" },
{ value: "poor-evidence", label: "evidence or build info is incomplete" },
];

export default function Home() {
  const [stage, setStage] = useState<Stage>("intake");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [needProfile, setNeedProfile] =
    useState<NeedProfile>(emptyNeedProfile());
  const [error, setError] = useState<string | null>(null);
  const [readyForSearch, setReadyForSearch] = useState(false);
  const [handoffReason, setHandoffReason] = useState("");
  const [missingInformation, setMissingInformation] = useState<string[]>([]);
  const [suggestedReplies, setSuggestedReplies] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateProject[]>([]);
  const [pool, setPool] = useState<CandidateProject[]>([]);
  const [poolCursor, setPoolCursor] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [query, setQuery] = useState<string>("");
  const [tomCatalogSnapshotDate, setTomCatalogSnapshotDate] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [selectedForComparison, setSelectedForComparison] = useState<string[]>(
    [],
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );

  const [sessionId, setSessionId] = useState(() => createId());
  const [historyEntries, setHistoryEntries] = useState<SearchHistoryEntry[]>(
    [],
  );
  const [savedProjects, setSavedProjects] = useState<CandidateProject[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);

  useEffect(() => {
    setHistoryEntries(loadSearchHistory());
    setSavedProjects(loadSavedProjects());
  }, []);

  function persistHistory(
    nextCandidates: CandidateProject[],
    nextPool: CandidateProject[],
    nextPoolCursor: number,
    nextSelectedForComparison: string[],
    nextQuery: string = query,
  ) {
    setHistoryEntries(
      upsertSearchHistory({
        id: sessionId,
        needProfile,
        messages,
        query: nextQuery,
        candidates: nextCandidates,
        pool: nextPool,
        poolCursor: nextPoolCursor,
        selectedForComparison: nextSelectedForComparison,
      }),
    );
  }

  function restoreFromHistory(entry: SearchHistoryEntry) {
    // Adopt the restored entry's id as the active session so any further
    // action (including the image backfill below) updates this same
    // history entry instead of forking a new one under the original
    // page-load session id.
    setSessionId(entry.id);
    setNeedProfile(entry.needProfile);
    setMessages(entry.messages);
    setQuery(entry.query);
    setCandidates(entry.candidates);
    setPool(entry.pool);
    setPoolCursor(entry.poolCursor);
    setSelectedForComparison(entry.selectedForComparison);
    setSelectedCandidateId(entry.candidates[0]?.id || null);
    setReview(null);
    setReadyForSearch(true);
    setStage("review");
    setHistoryOpen(false);
    // Older snapshots saved before image lookup existed (or before it
    // resolved) won't have photos — try to backfill them now. Don't
    // re-persist from here (see enrichTomImages) since pool/poolCursor/
    // selectedForComparison/sessionId are all being switched to this
    // entry's values in this same call, and this callback's closure would
    // still see the old ones by the time it resolves.
    enrichTomImages(entry.candidates, false);
  }

  function removeHistoryEntry(id: string) {
    setHistoryEntries(deleteSearchHistoryEntry(id));
  }

  const savedCandidates = useMemo(
    () =>
      candidates.filter((candidate) =>
        selectedForComparison.includes(candidate.id),
      ),
    [candidates, selectedForComparison],
  );

  const selectedCandidate = useMemo(
    () =>
      candidates.find((candidate) => candidate.id === selectedCandidateId) ||
      candidates[0] ||
      null,
    [candidates, selectedCandidateId],
  );

  async function sendIntakeMessage(content?: string) {
    const text = (content ?? draft).trim();
    if (!text) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setLoading("asking follow-up");
    setError(null);

    try {
      const res = await fetch("/api/intake-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          currentNeedProfile: needProfile,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Intake agent failed.");
      }

      const intakeData = data as IntakeChatResponse;

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: intakeData.assistantMessage,
      };

      setMessages([...nextMessages, assistantMessage]);
      setNeedProfile(intakeData.needProfile);
      setReadyForSearch(intakeData.readyForInternalSearch);
      setHandoffReason(intakeData.handoffReason);
      setMissingInformation(intakeData.missingInformation || []);
      setSuggestedReplies(intakeData.suggestedReplies || []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The intake agent failed.";

      setError(message);
      setMessages([
        ...nextMessages,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content:
            "The intake agent could not connect right now. Please check the Gemini API connection and try again.",
        },
      ]);
    } finally {
      setLoading(null);
    }
  }
  // Score a batch of already-fetched candidates via the on-demand evaluate route.
  // Score one candidate per request (instead of one request for the whole
  // page) so results can render as each finishes, rather than all-at-once
  // after the slowest one lands. Same total Gemini load, same total wait for
  // the full page — the point is that `onScored` lets the caller show each
  // card the moment it's ready instead of blocking on Promise.all.
  async function scoreBatch(
    batch: CandidateProject[],
    onScored?: (candidate: CandidateProject) => void,
  ): Promise<CandidateProject[]> {
    return Promise.all(
      batch.map(async (candidate) => {
        const res = await fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ needProfile, candidates: [candidate] }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Evaluation failed.");

        const scored = ((data.candidates || []) as CandidateProject[])[0] || candidate;
        onScored?.(scored);
        return scored;
      }),
    );
  }

  // Same total wait as scoreBatch (TOM and external candidates are still
  // scored in parallel, not sequentially), but reveals them as a TOM group
  // first, then an external group — instead of whichever individual
  // candidate happens to finish first. External candidates that finish
  // scoring while TOM ones are still pending are held back and released
  // together the moment the last TOM candidate in this batch lands.
  async function scoreBatchTomFirst(
    batch: CandidateProject[],
    onReveal: (revealed: CandidateProject[]) => void,
  ): Promise<CandidateProject[]> {
    const tomBatch = batch.filter(isTomCandidate);
    const externalBatch = batch.filter((candidate) => !isTomCandidate(candidate));

    let tomRemaining = tomBatch.length;
    let pendingExternal: CandidateProject[] = [];

    const releasePending = () => {
      if (!pendingExternal.length) return;
      const released = pendingExternal;
      pendingExternal = [];
      onReveal(released);
    };

    const [tomScored, externalScored] = await Promise.all([
      scoreBatch(tomBatch, (candidate) => {
        tomRemaining -= 1;
        onReveal([candidate]);
        if (tomRemaining <= 0) releasePending();
      }),
      scoreBatch(externalBatch, (candidate) => {
        if (tomRemaining > 0) {
          pendingExternal.push(candidate);
        } else {
          onReveal([candidate]);
        }
      }),
    ]);

    return [...tomScored, ...externalScored];
  }

  // Fire-and-forget: look up real photos only for the TOM candidates that
  // actually made it on screen (not the whole search pool — see lib/tom.ts).
  // Candidates render immediately without waiting on this; images pop in
  // once the lookup resolves.
  //
  // `persist` controls whether the result also gets written back to search
  // history via the closure over pool/poolCursor/selectedForComparison/
  // sessionId. Skip it (pass false) right after those are being changed
  // synchronously by the caller (restoreFromHistory) — this callback's
  // closure would still see the pre-change values when it resolves, and
  // could stomp the just-restored entry with stale data.
  function enrichTomImages(visible: CandidateProject[], persist = true) {
    const targets = visible.filter(
      (candidate) => isTomCandidate(candidate) && !candidate.image,
    );
    if (!targets.length) return;

    fetch("/api/tom-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidates: targets.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
        })),
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const results = (data?.results || []) as Array<{
          id: string;
          image?: string;
          images?: string[];
        }>;
        if (!results.length) return;

        const byId = new Map(results.map((result) => [result.id, result]));
        let updated: CandidateProject[] = [];

        setCandidates((previous) => {
          updated = previous.map((candidate) => {
            const found = byId.get(candidate.id);
            return found?.image
              ? { ...candidate, image: found.image, images: found.images }
              : candidate;
          });
          return updated;
        });

        // Re-persist so images survive a later "restore from History" too,
        // not just the current live view.
        if (persist) {
          persistHistory(updated, pool, poolCursor, selectedForComparison);
        }
      })
      .catch((error) => {
        console.error("TOM image enrichment failed", error);
      });
  }

  async function startSearch(customQuery?: string) {
    setLoading("searching projects");
    setError(null);
    setStage("review");
    setReview(null);
    setSelectedForComparison([]);
    setCandidates([]);
    setPool([]);
    setPoolCursor(0);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needProfile,
          query: customQuery,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Search failed.");
      }

      const searchData = data as SearchPoolResponse;
      setQuery(searchData.query);
      setTomCatalogSnapshotDate(searchData.tomCatalogSnapshotDate || null);

      const fetchedPool = searchData.pool || [];
      setPool(fetchedPool);

      if (!fetchedPool.length) {
        setCandidates([]);
        setSelectedCandidateId(null);
        setError(
          "No real search results were returned. Try broadening the query or removing domain filters.",
        );
        return;
      }

      // Score pages one at a time, but don't stop at the first page just
      // because it's the first page: if too few candidates clear the
      // visibility bar (common when a batch happens to skew toward weak
      // matches), keep scoring further pages automatically until there's a
      // reasonable number on screen, or the pool/round budget runs out. The
      // rest still waits behind a manual "Load more" beyond that floor.
      let cursor = 0;
      let allScored: CandidateProject[] = [];
      let visibleScored: CandidateProject[] = [];
      let batchesFetched = 0;

      const needsMoreResults = () =>
        visibleScored.length < MIN_TOTAL_VISIBLE_TARGET ||
        visibleScored.filter(isTomCandidate).length < MIN_TOM_VISIBLE_TARGET;

      while (
        cursor < fetchedPool.length &&
        batchesFetched < MAX_AUTO_SCORE_BATCHES &&
        needsMoreResults()
      ) {
        const batch = fetchedPool.slice(cursor, cursor + PAGE_SIZE);
        batchesFetched += 1;

        setLoading(
          batchesFetched === 1
            ? "searching projects"
            : `searching projects (${visibleScored.filter(isTomCandidate).length}/${MIN_TOM_VISIBLE_TARGET} TOM, ${visibleScored.length}/${MIN_TOTAL_VISIBLE_TARGET} total so far)`,
        );

        await scoreBatchTomFirst(batch, (revealed) => {
          allScored = [...allScored, ...revealed];
          visibleScored = prepareVisibleCandidates(allScored);
          setCandidates(visibleScored);
          setSelectedCandidateId((current) => current ?? visibleScored[0]?.id ?? null);
        });
        cursor += batch.length;
      }

      setCandidates(visibleScored);
      setPoolCursor(cursor);
      setSelectedCandidateId((current) => current ?? visibleScored[0]?.id ?? null);
      enrichTomImages(visibleScored);
      persistHistory(
        visibleScored,
        fetchedPool,
        cursor,
        [],
        searchData.query,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed.";
      setError(message);
      setCandidates([]);
      setPool([]);
      setPoolCursor(0);
      setSelectedCandidateId(null);
    } finally {
      setLoading(null);
    }
  }

  async function loadMore() {
    if (poolCursor >= pool.length) return;

    setLoadingMore(true);
    setError(null);

    try {
      const nextBatch = pool.slice(poolCursor, poolCursor + PAGE_SIZE);
      const existing = candidates;
      let batchScored: CandidateProject[] = [];

      const scored = await scoreBatchTomFirst(nextBatch, (revealed) => {
        batchScored = [...batchScored, ...revealed];
        const visibleSoFar = prepareVisibleCandidates(batchScored);
        setCandidates(sortDisplayCandidates([...existing, ...visibleSoFar]));
      });

      const visibleScored = prepareVisibleCandidates(scored);
      const mergedCandidates = sortDisplayCandidates([
        ...existing,
        ...visibleScored,
      ]);
      const nextPoolCursor = poolCursor + nextBatch.length;

      setCandidates(mergedCandidates);
      setPoolCursor(nextPoolCursor);
      enrichTomImages(visibleScored);
      persistHistory(
        mergedCandidates,
        pool,
        nextPoolCursor,
        selectedForComparison,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Load more failed.";
      setError(message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function rejectCandidate(
    candidate: CandidateProject,
    rejectionReason: string,
  ) {
    setLoading("updating criteria");
    setReview(null);

    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needProfile,
          candidate,
          rejectionReason,
        }),
      });

      const updated = (await res.json()) as NeedProfile;
      setNeedProfile(updated);

      const updatedCandidates = candidates.map((item) =>
        item.id === candidate.id
          ? {
              ...item,
              rejected: true,
              rejectionReason:
                rejectionOptions.find(
                  (option) => option.value === rejectionReason,
                )?.label || rejectionReason,
            }
          : item,
      );

      setCandidates(updatedCandidates);
      persistHistory(updatedCandidates, pool, poolCursor, selectedForComparison);
    } finally {
      setLoading(null);
    }
  }

  async function generateReviewSummary() {
    setLoading("preparing output");

    try {
      const res = await fetch("/api/review-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needProfile,
          candidates,
        }),
      });

      const data = (await res.json()) as ReviewSummary;
      setReview(data);
      setStage("output");
    } finally {
      setLoading(null);
    }
  }

  // "Save" does double duty: it marks the candidate for this session's
  // comparison table AND persists it to the global saved-projects list, so
  // it's still findable after "New search" wipes the session.
  function toggleComparison(candidate: CandidateProject) {
    const isSelected = selectedForComparison.includes(candidate.id);

    const nextSelected = isSelected
      ? selectedForComparison.filter((id) => id !== candidate.id)
      : [...selectedForComparison, candidate.id];

    setSelectedForComparison(nextSelected);
    setSavedProjects(
      isSelected
        ? removeSavedProject(candidate.id)
        : saveProjectGlobally(candidate),
    );
    persistHistory(candidates, pool, poolCursor, nextSelected);
  }

  return (
    <main className={loading ? "app isLoading" : "app"}>
      <InterfaceOverrides />

      {loading && (
        <div className="loadingPill">
          <span className="spinner onDark" />
          {loading}...
        </div>
      )}
      {error && <div className="errorBanner">{error}</div>}

      {stage === "intake" && (
        <IntakeScreen
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          onSubmit={sendIntakeMessage}
          readyForSearch={readyForSearch}
          handoffReason={handoffReason}
          suggestedReplies={suggestedReplies}
          needProfile={needProfile}
          missingInformation={missingInformation}
          onStartSearch={() => startSearch()}
          historyCount={historyEntries.length}
          savedCount={savedProjects.length}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSaved={() => setSavedOpen(true)}
        />
      )}

      {stage === "review" && (
        <ReviewScreen
          needProfile={needProfile}
          candidates={candidates}
          selectedCandidate={selectedCandidate}
          selectedForComparison={selectedForComparison}
          savedCandidates={savedCandidates}
          query={query}
          setSelectedCandidateId={setSelectedCandidateId}
          toggleComparison={toggleComparison}
          rejectCandidate={rejectCandidate}
          runSearch={startSearch}
          loadMore={loadMore}
          canLoadMore={poolCursor < pool.length}
          loadingMore={loadingMore}
          generateReviewSummary={generateReviewSummary}
          onBackToIntake={() => setStage("intake")}
          historyCount={historyEntries.length}
          savedCount={savedProjects.length}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSaved={() => setSavedOpen(true)}
          tomCatalogSnapshotDate={tomCatalogSnapshotDate}
        />
      )}

      {stage === "output" && review && (
        <OutputScreen
          review={review}
          needProfile={needProfile}
          candidates={candidates}
          savedCandidates={savedCandidates}
          onBackToReview={() => setStage("review")}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          entries={historyEntries}
          onSelect={restoreFromHistory}
          onDelete={removeHistoryEntry}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {savedOpen && (
        <SavedProjectsPanel
          projects={savedProjects}
          onRemove={(id) => {
            setSavedProjects(removeSavedProject(id));
            setSelectedForComparison((previous) =>
              previous.filter((candidateId) => candidateId !== id),
            );
          }}
          onClose={() => setSavedOpen(false)}
        />
      )}
    </main>
  );
}

function hasUsableSearchSeed(profile: NeedProfile) {
  const hasActivity =
    profile.activity && profile.activity !== "unknown activity";

  const hasProblem = profile.problem && profile.problem !== "unknown problem";

  return Boolean(hasActivity && hasProblem);
}

function IntakeScreen({
  messages,
  draft,
  setDraft,
  onSubmit,
  readyForSearch,
  handoffReason,
  suggestedReplies,
  needProfile,
  missingInformation,
  onStartSearch,
  historyCount,
  savedCount,
  onOpenHistory,
  onOpenSaved,
}: {
  messages: ChatMessage[];
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (content?: string) => void;
  readyForSearch: boolean;
  handoffReason: string;
  suggestedReplies: string[];
  needProfile: NeedProfile;
  missingInformation: string[];
  onStartSearch: () => void;
  historyCount: number;
  savedCount: number;
  onOpenHistory: () => void;
  onOpenSaved: () => void;
}) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  const chatMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = chatMessagesRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, suggestedReplies]);

  const userTurnCount = messages.filter(
    (message) => message.role === "user",
  ).length;
  // The agent's own "ready" judgment is a quality signal, not a gate — once
  // the user has answered at least once, let them jump to search whenever
  // they want. Q&A keeps going if they'd rather answer more first.
  const showSearchAction = userTurnCount >= 1;

  if (!messages.length) {
    return (
      <section className="landing">
        <div className="promptShell">
          <div className="promptLabelRow">
            <img className="promptLabel" src="/tom-logo.png" alt="Tikkun Olam Makers" />

            {(historyCount > 0 || savedCount > 0) && (
              <div className="promptLabelActions">
                {historyCount > 0 && (
                  <button className="plainBtn" onClick={onOpenHistory}>
                    History ({historyCount})
                  </button>
                )}
                {savedCount > 0 && (
                  <button className="plainBtn" onClick={onOpenSaved}>
                    Saved ({savedCount})
                  </button>
                )}
              </div>
            )}
          </div>

          <form className="heroPrompt" onSubmit={handleSubmit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Tell us what you’re trying to do, and what’s getting in the way. A sentence or two is enough to start."
              autoFocus
            />

            <div className="heroActions">
              <button type="submit" className="sendBtn">
                Start
              </button>
            </div>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section className="intakeChatScreen">
      <div className="miniHeader">
        <button className="plainBtn" onClick={() => location.reload()}>
          New search
        </button>
        <div className="miniHeaderActions">
          <button className="plainBtn" onClick={onOpenHistory}>
            History ({historyCount})
          </button>
          <button className="plainBtn" onClick={onOpenSaved}>
            Saved ({savedCount})
          </button>
        </div>
        <img className="miniHeaderLogo" src="/tom-logo.png" alt="Tikkun Olam Makers" />
      </div>

      <div className="chatWindow">
        <div className="chatMessages" ref={chatMessagesRef}>
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <p>{message.content}</p>
            </div>
          ))}
        </div>

        {suggestedReplies.length > 0 && (
          <div className="suggestedReplies">
            {suggestedReplies.map((reply) => (
              <button
                key={reply}
                className="suggestedChip"
                onClick={() => onSubmit(reply)}
              >
                {reply}
              </button>
            ))}
          </div>
        )}
        <form className="chatInputBar" onSubmit={handleSubmit}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              showSearchAction
                ? "Add any extra detail, or start searching related projects."
                : "Answer here..."
            }
          />

          <div className="inputActions">
            <button className="sendBtn" type="submit">
              Send
            </button>

            {showSearchAction && (
              <button
                className="searchActionBtn"
                type="button"
                onClick={onStartSearch}
                title={
                  readyForSearch
                    ? undefined
                    : "You can search now, or answer a bit more first for better results."
                }
              >
                {readyForSearch ? "Search related projects" : "Search now"}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function ReviewScreen({
  needProfile,
  candidates,
  selectedCandidate,
  selectedForComparison,
  savedCandidates,
  query,
  setSelectedCandidateId,
  toggleComparison,
  rejectCandidate,
  runSearch,
  loadMore,
  canLoadMore,
  loadingMore,
  generateReviewSummary,
  onBackToIntake,
  historyCount,
  savedCount,
  onOpenHistory,
  onOpenSaved,
  tomCatalogSnapshotDate,
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  selectedCandidate: CandidateProject | null;
  selectedForComparison: string[];
  savedCandidates: CandidateProject[];
  query: string;
  setSelectedCandidateId: (id: string) => void;
  toggleComparison: (candidate: CandidateProject) => void;
  rejectCandidate: (
    candidate: CandidateProject,
    rejectionReason: string,
  ) => void;
  runSearch: (query?: string) => void;
  loadMore: () => void;
  canLoadMore: boolean;
  tomCatalogSnapshotDate?: string | null;
  loadingMore: boolean;
  generateReviewSummary: () => void;
  onBackToIntake: () => void;
  historyCount: number;
  savedCount: number;
  onOpenHistory: () => void;
  onOpenSaved: () => void;
}) {
  const tomCandidates = candidates.filter(isTomCandidate);
  // If the same solution shows up both as a TOM project and as an external
  // result (e.g. also cross-posted to Printables), keep only the TOM one.
  const externalCandidates = dedupeExternalAgainstTom(
    tomCandidates,
    candidates.filter((candidate) => !isTomCandidate(candidate)),
  );

  const [sortMode, setSortMode] = useState<"best" | "az">("best");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceTypeFilter, setSourceTypeFilter] = useState("all");

  // Detail-panel width, resizable by dragging .panelDivider. Only applied on
  // desktop widths - below DESKTOP_LAYOUT_QUERY the CSS media query collapses
  // .workspaceGrid to a single column, and an inline style would override
  // that (inline styles beat @media rules), so the divider/inline width are
  // skipped entirely on narrow screens rather than fighting the stylesheet.
  const [detailPanelWidth, setDetailPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_DETAIL_PANEL_WIDTH;
    const raw = window.localStorage.getItem(DETAIL_PANEL_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed)
      ? clampDetailPanelWidth(parsed)
      : DEFAULT_DETAIL_PANEL_WIDTH;
  });
  const [isDesktopLayout, setIsDesktopLayout] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
  });
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const update = () => setIsDesktopLayout(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      DETAIL_PANEL_WIDTH_KEY,
      String(detailPanelWidth),
    );
  }, [detailPanelWidth]);

  function handleDividerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingDivider(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  }

  function handleDividerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isDraggingDivider) return;
    // Dragging left (negative movementX) widens the right-hand detail
    // panel; dragging right narrows it.
    setDetailPanelWidth((previous) =>
      clampDetailPanelWidth(previous - event.movementX),
    );
  }

  function handleDividerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    setIsDraggingDivider(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = "";
  }

  const tomCategories = useMemo(
    () =>
      Array.from(
        new Set(tomCandidates.flatMap((c) => splitCategories(c.category))),
      ).sort(),
    [tomCandidates],
  );

  const externalSourceTypes = useMemo(
    () => Array.from(new Set(externalCandidates.map((c) => c.sourceType))).sort(),
    [externalCandidates],
  );

  const visibleTomCandidates = sortCandidateList(
    categoryFilter === "all"
      ? tomCandidates
      : tomCandidates.filter((c) =>
          splitCategories(c.category).includes(categoryFilter),
        ),
    sortMode,
  );

  const visibleExternalCandidates = sortCandidateList(
    sourceTypeFilter === "all"
      ? externalCandidates
      : externalCandidates.filter((c) => c.sourceType === sourceTypeFilter),
    sortMode,
  );

  return (
    <section className="workspace">
      <header className="workspaceHeader">
        <button className="plainBtn" onClick={onBackToIntake}>
          ← Intake
        </button>

        <div>
          <h1>Search results</h1>
          <p>
            Here are some projects that might fit your needs. You can click
            on a project to learn more, compare a few results or edit your
            search.
          </p>
        </div>

        <div className="workspaceHeaderActions">
          <button className="sendBtn" onClick={onBackToIntake}>
            Add more details
          </button>
          <div className="workspaceHeaderSecondary">
            <button className="plainBtn" onClick={() => location.reload()}>
              New search
            </button>
            <button className="plainBtn" onClick={onOpenHistory}>
              History ({historyCount})
            </button>
            <button className="plainBtn" onClick={onOpenSaved}>
              Saved ({savedCount})
            </button>
          </div>
        </div>
      </header>

      <div
        className="workspaceGrid"
        style={
          isDesktopLayout
            ? {
                gridTemplateColumns: `minmax(0, 1fr) 10px ${detailPanelWidth}px`,
              }
            : undefined
        }
      >
        <section className="panel resultsPanel">
          <h2>Related projects</h2>
          <p className="small resultsHint">Tap a card for details.</p>

          {needProfile.searchDirections.length > 0 && (
            <div className="chips searchDirectionsRow">
              {needProfile.searchDirections.map((direction) => (
                <button
                  key={direction}
                  className="chipButton"
                  onClick={() => runSearch(direction)}
                >
                  {direction}
                </button>
              ))}
            </div>
          )}

          <div className="resultsControls">
            <label className="resultsControl">
              Sort
              <select
                value={sortMode}
                onChange={(event) =>
                  setSortMode(event.target.value as "best" | "az")
                }
              >
                <option value="best">Best match</option>
                <option value="az">Title A–Z</option>
              </select>
            </label>

            {tomCategories.length > 0 && (
              <label className="resultsControl">
                TOM category
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  <option value="all">All categories</option>
                  {tomCategories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {externalSourceTypes.length > 0 && (
              <label className="resultsControl">
                Other source type
                <select
                  value={sourceTypeFilter}
                  onChange={(event) => setSourceTypeFilter(event.target.value)}
                >
                  <option value="all">All types</option>
                  {externalSourceTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="resultsStack">
            <div className="resultsSection">
              <h3 className="resultsColumnTitle">
                TOM projects
                {tomCatalogSnapshotDate && (
                  <span className="snapshotBadge">
                    catalog snapshot: {tomCatalogSnapshotDate}
                  </span>
                )}
              </h3>
              {visibleTomCandidates.length > 0 && (
                <div className="candidateList">
                  {visibleTomCandidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      active={candidate.id === selectedCandidate?.id}
                      selected={selectedForComparison.includes(candidate.id)}
                      onSelect={() => setSelectedCandidateId(candidate.id)}
                      onToggleComparison={() => toggleComparison(candidate)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="resultsSection">
              <h3 className="resultsColumnTitle">Other related work</h3>
              {visibleExternalCandidates.length > 0 && (
                <div className="candidateList">
                  {visibleExternalCandidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      active={candidate.id === selectedCandidate?.id}
                      selected={selectedForComparison.includes(candidate.id)}
                      onSelect={() => setSelectedCandidateId(candidate.id)}
                      onToggleComparison={() => toggleComparison(candidate)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {canLoadMore && (
            <button
              className="plainBtn loadMoreBtn"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <>
                  <span className="spinner" />
                  Scoring…
                </>
              ) : (
                "Load more"
              )}
            </button>
          )}
        </section>

        {isDesktopLayout && (
          <div
            className={`panelDivider${isDraggingDivider ? " dragging" : ""}`}
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panels"
          />
        )}

        <aside className="panel detailPanel">
          {selectedCandidate ? (
            <CandidateDetail
              candidate={selectedCandidate}
              needProfile={needProfile}
              selected={selectedForComparison.includes(selectedCandidate.id)}
              onToggleComparison={() => toggleComparison(selectedCandidate)}
              onReject={(reason) => rejectCandidate(selectedCandidate, reason)}
            />
          ) : (
            <p className="small">Select a project to learn more.</p>
          )}
        </aside>
      </div>

      {savedCandidates.length > 0 && (
        <section className="panel comparisonPanel">
          <h2>Saved comparison</h2>
          <ComparisonView candidates={savedCandidates} />
        </section>
      )}

      <p className="newDeviceRequest">
        Can't find what you're looking for?{" "}
        <a
          href="https://forms.monday.com/forms/25b088ad345c4d5d0d66ccdb178d1acb?r=use1"
          target="_blank"
          rel="noreferrer"
        >
          Request a new assistive device
        </a>
      </p>
    </section>
  );
}

function HistoryPanel({
  entries,
  onSelect,
  onDelete,
  onClose,
}: {
  entries: SearchHistoryEntry[];
  onSelect: (entry: SearchHistoryEntry) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlayBackdrop" onClick={onClose}>
      <div
        className="overlayPanel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="overlayHeader">
          <h2>Search history</h2>
          <button className="plainBtn" onClick={onClose}>
            Close
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="small">
            No past searches yet. They'll show up here once you run one.
          </p>
        ) : (
          <div className="historyList">
            {entries.map((entry) => (
              <div key={entry.id} className="historyRow">
                <button
                  className="historyRowMain"
                  onClick={() => onSelect(entry)}
                >
                  <span className="historyRowLabel">{entry.label}</span>
                  <span className="historyRowMeta">
                    {new Date(entry.createdAt).toLocaleString()} ·{" "}
                    {entry.candidates.length} result
                    {entry.candidates.length === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  className="plainBtn danger"
                  onClick={() => onDelete(entry.id)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SavedProjectsPanel({
  projects,
  onRemove,
  onClose,
}: {
  projects: CandidateProject[];
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlayBackdrop" onClick={onClose}>
      <div
        className="overlayPanel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="overlayHeader">
          <h2>Saved projects</h2>
          <button className="plainBtn" onClick={onClose}>
            Close
          </button>
        </div>

        {projects.length === 0 ? (
          <p className="small">
            No saved projects yet. Tap "Save" on any result to keep it here
            across searches.
          </p>
        ) : (
          <div className="candidateList">
            {projects.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                active={false}
                selected
                onSelect={() => {}}
                onToggleComparison={() => onRemove(candidate.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchReflectionPanel({
  needProfile,
  candidates,
  savedCandidates,
  onBackToIntake,
  onPrepareSummary,
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  savedCandidates: CandidateProject[];
  onBackToIntake: () => void;
  onPrepareSummary: () => void;
}) {
  const missingHints = Array.from(
    new Set(
      candidates
        .flatMap((candidate) => candidate.evaluation?.missingInformation || [])
        .filter(Boolean),
    ),
  ).slice(0, 3);

  const unmatchedHints = Array.from(
    new Set(
      candidates
        .flatMap((candidate) => candidate.evaluation?.unmatchedCriteria || [])
        .filter(Boolean),
    ),
  ).slice(0, 3);

  const hasSavedCandidates = savedCandidates.length > 0;

  return (
    <section className="reflectionPanel">
      <p className="reflectionLabel">Does this match the need?</p>

      <p className="reflectionText">
        If these projects feel off, add one more detail before preparing the
        summary.
      </p>

      {(missingHints.length > 0 || unmatchedHints.length > 0) && (
        <div className="reflectionHints"></div>
      )}

      <div className="reflectionActions"></div>
    </section>
  );
}

function buildPlainTextSummary({
  review,
  needProfile,
  displayCandidates,
}: {
  review: ReviewSummary;
  needProfile: NeedProfile;
  displayCandidates: CandidateProject[];
}) {
  const location = [needProfile.location.cityOrRegion, needProfile.location.country]
    .filter(Boolean)
    .join(", ");

  const lines = [
    "TOM SEARCH SUMMARY",
    "",
    `Activity: ${needProfile.activity}`,
    `Problem: ${needProfile.problem}`,
    `Desired outcome: ${needProfile.desiredOutcome}`,
    `Age / role: ${[needProfile.userAge, needProfile.seekerRole].filter(Boolean).join(" / ")}`,
    location ? `Location: ${location}` : "",
    "",
    "NEED SUMMARY",
    review.needSummary,
    "",
    "USER-FACING MESSAGE",
    review.userFacingMessage,
    "",
    "RECOMMENDED PATHWAY",
    review.recommendedPathway,
    "",
    "OPTIONS TO DISCUSS",
    ...displayCandidates.flatMap((candidate) => [
      `- ${candidate.title} (${candidate.sourceType}) — ${candidate.url}`,
      `  Fit: ${fitAssessmentText(candidate)}`,
      `  Cost: ${costLabel(candidate)} | Needs TOM team?: ${needsTomTeamLabel(candidate)}`,
    ]),
    "",
    "FOLLOW-UP QUESTIONS FOR NEED-KNOWER",
    ...review.nextQuestionsForNeedKnower.map((question) => `- ${question}`),
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function OutputScreen({
  review,
  needProfile,
  candidates,
  savedCandidates,
  onBackToReview,
}: {
  review: ReviewSummary;
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  savedCandidates: CandidateProject[];
  onBackToReview: () => void;
}) {
  const displayCandidates = savedCandidates.length
    ? savedCandidates
    : candidates.slice(0, 3);

  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = buildPlainTextSummary({ review, needProfile, displayCandidates });

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Copy to clipboard failed", error);
    }
  }

  return (
    <section className="workspace outputWorkspace printSummary">
      <header className="workspaceHeader noPrint">
        <button className="plainBtn" onClick={onBackToReview}>
          ← Review
        </button>

        <div>
          <h1>Prepared summary</h1>
          <p>Internal notes and a safer user-facing message.</p>
        </div>

        <div className="workspaceHeaderSecondary">
          <button className="plainBtn" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy summary"}
          </button>
          <button className="plainBtn" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>
      </header>

      <div className="outputGrid">
        <div className="panel">
          <h2>TOM notes</h2>
          <NeedProfileView profile={needProfile} />
          <ReviewSummaryView review={review} internal />
        </div>

        <div className="panel">
          <h2>User-facing message</h2>
          <p className="userMessage">{review.userFacingMessage}</p>

          <h3>Options to discuss</h3>
          <div className="cards oneCol">
            {displayCandidates.map((candidate) => (
              <UserFacingCard key={candidate.id} candidate={candidate} />
            ))}
          </div>

          <h3>Follow-up questions</h3>
          <ul className="list">
            {review.nextQuestionsForNeedKnower.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      </div>

      {savedCandidates.length > 0 && (
        <section className="panel comparisonPanel">
          <h2>Saved comparison</h2>
          <ComparisonView candidates={savedCandidates} />
        </section>
      )}
    </section>
  );
}

function NeedProfileView({
  profile,
  compact = false,
}: {
  profile: NeedProfile;
  compact?: boolean;
}) {
  const location = [profile.location.cityOrRegion, profile.location.country]
    .filter(Boolean)
    .join(", ");

  const ageAndRole = [profile.userAge, profile.seekerRole]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className={compact ? "needProfile compact" : "needProfile"}>
      <div className="kv">
        <b>Activity</b>
        <span>{profile.activity}</span>
      </div>

      <div className="kv">
        <b>Problem</b>
        <span>{profile.problem}</span>
      </div>

      <div className="kv">
        <b>Desired outcome</b>
        <span>{profile.desiredOutcome || "not specified"}</span>
      </div>

      <div className="kv">
        <b>Age / role</b>
        <span>{ageAndRole || "not specified"}</span>
      </div>

      <div className="kv">
        <b>Location</b>
        <span>{location || "not specified"}</span>
      </div>

      <ChipRow label="User context" items={profile.userContext} />
      <ChipRow label="Body function" items={profile.bodyFunction} />
      <ChipRow label="Current devices" items={profile.currentDevices} />
      <ChipRow label="Environment" items={profile.environment} />

      <ChipRow label="Must have" items={profile.mustHave} tone="good" />
      <ChipRow label="Must avoid" items={profile.mustAvoid} tone="bad" />

      {!compact && <ChipRow label="Preferences" items={profile.preferences} />}

      {!compact && (
        <ChipRow label="Safety" items={profile.safetyConcerns} tone="warn" />
      )}

      {!compact && <ChipRow label="Unknowns" items={profile.unknowns} />}
    </div>
  );
}

function ChipRow({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone?: "good" | "warn" | "bad";
}) {
  if (!items.length) return null;

  return (
    <div className="kv">
      <b>{label}</b>
      <div className="chips">
        {items.map((item) => (
          <span key={item} className={`chip ${tone || ""}`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function sourceToneClass(candidate: CandidateProject) {
  const source = candidate.source.toLowerCase();

  if (
    candidate.sourceType === "TOM project" ||
    source.includes("tomglobal.org")
  ) {
    return "tom";
  }

  if (candidate.sourceType === "DIY project") return "diy";
  if (candidate.sourceType === "open-source project") return "open";
  if (candidate.sourceType === "commercial product") return "commercial";
  if (candidate.sourceType === "research prototype") return "research";

  return "unknown";
}

function formatSourceLabel(source: string) {
  const normalized = source.toLowerCase().replace(/^www\./, "");

  if (normalized.includes("tomglobal.org")) return "TOM Global";
  if (normalized.includes("tomchallenge.org")) return "TOM Challenge";
  if (normalized.includes("instructables.com")) return "Instructables";
  if (normalized.includes("thingiverse.com")) return "Thingiverse";
  if (normalized.includes("printables.com")) return "Printables";
  if (normalized.includes("github.com")) return "GitHub";
  if (normalized.includes("amazon.")) return "Amazon";
  if (normalized.includes("walmart.")) return "Walmart";
  if (normalized.includes("etsy.")) return "Etsy";

  return source || "Unknown source";
}

function CandidateRow({
  candidate,
  active,
  selected,
  onSelect,
  onToggleComparison,
}: {
  candidate: CandidateProject;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleComparison: () => void;
}) {
  const cardClassName = [
    "projectCard",
    sourceToneClass(candidate),
    active ? "active" : "",
    candidate.image ? "" : "noImage",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cardClassName} onClick={onSelect}>
      {candidate.image && (
        <div className="cardMedia">
          <img
            src={candidate.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        </div>
      )}

      {candidate.rejected && <span className="cardRejected">rejected</span>}

      <div className="cardBody">
        <div className="sourceMeta">
          <span className="cardType">{candidate.sourceType}</span>
          <span className={`sourceBadge ${sourceToneClass(candidate)}`}>
            {formatSourceLabel(candidate.source)}
          </span>
        </div>
        <h3 className="cardTitle">{candidate.title}</h3>
        <p className="cardTeaser">{candidate.summary}</p>

        <div className="cardFoot">
          <a
            className="openLink"
            href={candidate.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Open ↗
          </a>

          <button
            className={selected ? "saveBtn selected" : "saveBtn"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleComparison();
            }}
          >
            {selected ? "Saved" : "Save"}
          </button>
        </div>
      </div>
    </article>
  );
}

function CandidateDetail({
  candidate,
  needProfile,
  selected,
  onToggleComparison,
  onReject,
}: {
  candidate: CandidateProject;
  needProfile: NeedProfile;
  selected: boolean;
  onToggleComparison: () => void;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState(rejectionOptions[0].value);
  const evaluation = candidate.evaluation;

  return (
    <article className="candidateDetail">
      <div className="detailHead">
        <div className="sourceMeta">
          <span className="cardType">{candidate.sourceType}</span>
          <span className="sourceBadge">
            {formatSourceLabel(candidate.source)}
          </span>
        </div>
      </div>

      <h2>{candidate.title}</h2>

      <a
        className="openOriginal"
        href={candidate.url}
        target="_blank"
        rel="noreferrer"
      >
        Open original ↗
      </a>

      {candidate.images && candidate.images.length > 1 ? (
        <div className="detailGallery">
          {candidate.images.map((src) => (
            <img
              key={src}
              className="detailGalleryImg"
              src={src}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ))}
        </div>
      ) : (
        candidate.image && (
          <img
            className="detailThumb"
            src={candidate.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )
      )}

<div className="evalBlock">
  <h4>{fitHeading(candidate)}</h4>
  <p>{fitAssessmentText(candidate)}</p>
</div>

<div className="evalBlock">
  <h4>Can it be adapted?</h4>
  <p>{adaptationText(candidate)}</p>
</div>

      <div className="evalBlock">
        <h4>What to check</h4>
        <p>
          {evaluation.missingInformation.slice(0, 3).join(", ") ||
            "No major missing information detected yet."}
        </p>
      </div>

      <div className="detailStatsRow">
        <div className="detailStat">
          <b>Cost</b>
          <span>{costLabel(candidate)}</span>
        </div>
      </div>

      <ChipRow
        label="Matched needs"
        items={evaluation.matchedCriteria}
        tone="good"
      />
      <ChipRow
        label="Possible mismatches"
        items={evaluation.unmatchedCriteria}
        tone="bad"
      />

      <details className="rawSummary">
        <summary>Full source summary</summary>
        <p>{candidate.summary}</p>
      </details>

      <div className="btnRow">
        <button
          className={selected ? "saveBtn selected" : "saveBtn"}
          onClick={onToggleComparison}
        >
          {selected ? "Saved" : "Save for comparison"}
        </button>
      </div>

      <div className="rejectBox">
        <label>Why does this not fit?</label>

        <select
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        >
          {rejectionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          className="plainBtn danger"
          onClick={() => onReject(reason)}
          disabled={candidate.rejected}
        >
          Reject and refine search
        </button>
      </div>
    </article>
  );
}

function ComparisonView({ candidates }: { candidates: CandidateProject[] }) {
  return (
    <div className="comparisonTableWrap">
      <table className="comparisonTable">
        <thead>
<tr>
  <th>Project</th>
  <th>Type</th>
  <th>Fit assessment</th>
  <th>Adaptation / access</th>
  <th>Cost</th>
  <th>Needs TOM team?</th>
  <th>What to check</th>
</tr>
        </thead>

        <tbody>
          {candidates.map((candidate) => (
           <tr key={candidate.id}>
  <td>{candidate.title}</td>
  <td>{candidate.sourceType}</td>
  <td>{fitAssessmentText(candidate)}</td>
  <td>
    {candidate.evaluation.adaptationFeasibility.explanation ||
      candidate.evaluation.accessPathway.explanation ||
      "No adaptation or access assessment available."}
  </td>
  <td>{costLabel(candidate)}</td>
  <td>{needsTomTeamLabel(candidate)}</td>
  <td>
    {candidate.evaluation.missingInformation
      .slice(0, 2)
      .join(", ") || "No major unknowns"}
  </td>
</tr>


          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewSummaryView({
  review,
  internal,
}: {
  review: ReviewSummary;
  internal?: boolean;
}) {
  return (
    <div className="reviewSummary">
      <h3>Need summary</h3>
      <p>{review.needSummary}</p>

      <SummaryList title="Closest matches" items={review.closestMatches} />
      <SummaryList title="Weak matches" items={review.weakMatches} />
      <SummaryList title="Main gaps" items={review.mainGaps} />
      <SummaryList title="Key risks" items={review.keyRisks} />

      <p className="pathway">
        <b>Recommended pathway:</b> {review.recommendedPathway}
      </p>

      {internal && (
        <SummaryList
          title="Next actions for TOM"
          items={review.nextActionsForTomTeam}
        />
      )}
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;

  return (
    <>
      <h3>{title}</h3>
      <ul className="list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function UserFacingCard({
  candidate,
}: {
  candidate: CandidateProject;
}) {
  const needsTeam = needsTomTeamLabel(candidate);

  return (
    <article className="userFacingCard">
      <h3>{candidate.title}</h3>
      <p>{candidate.summary}</p>

<p className="small">
  <b>Fit assessment:</b> {fitAssessmentText(candidate)}
</p>

<p className="small">
  <b>Adaptation possibility:</b> {adaptationText(candidate)}
</p>

      <p className="small">
        <b>What TOM should check:</b>{" "}
        {candidate.evaluation.missingInformation.slice(0, 3).join(", ") ||
          "No major missing information detected."}
      </p>

      <p className="small">
        <b>Cost:</b> {costLabel(candidate)}
        {" · "}
        <b>Needs TOM team?</b> {needsTeam}
      </p>

      <div className="cardFoot">
        <a
          className="openLink"
          href={candidate.url}
          target="_blank"
          rel="noreferrer"
        >
          Open original ↗
        </a>
      </div>
    </article>
  );
}

function InterfaceOverrides() {
  return (
    <style jsx global>{`
      .landing {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 48px 24px;
      }

      .brandLine,
      .landing h1,
      .exampleRow {
        display: none !important;
      }

      .promptShell {
        width: min(1080px, 92vw);
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .promptLabel {
        color: var(--muted);
        font-size: 18px;
        padding-left: 8px;
      }

      .promptLabelRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .promptLabelActions {
        display: flex;
        gap: 8px;
      }

      .heroPrompt {
        width: 100%;
        min-height: 220px;
        border-radius: 30px;
        padding: 28px;
        background:
          linear-gradient(var(--panel), var(--panel)) padding-box,
          linear-gradient(120deg, #f28b82, #fdd663, #81c995, #78d9ec, #8ab4f8)
            border-box;
        border: 1px solid transparent;
        box-shadow: var(--shadow);
        display: grid;
        grid-template-rows: 1fr auto;
      }

      .heroPrompt textarea {
        border: 0;
        outline: 0;
        resize: none;
        width: 100%;
        min-height: 126px;
        color: var(--ink);
        background: transparent;
        font-size: 22px;
        line-height: 1.45;
      }

      .heroPrompt textarea::placeholder {
        color: #334155;
      }

      .heroActions {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .intakeChatScreen {
        min-height: 100vh;
        display: grid;
        grid-template-columns: minmax(0, 860px);
        gap: 18px;
        justify-content: center;
        align-items: start;
        padding: 28px 24px;
      }

      .miniHeader {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: var(--muted);
      }

      .miniHeaderActions {
        display: flex;
        gap: 8px;
      }

      .chatWindow {
        width: 100%;
      }

      .handoffBar {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        box-shadow: 0 10px 40px rgba(60, 64, 67, 0.08);
      }

      .handoffBar p {
        margin: 0;
        color: var(--muted);
        line-height: 1.45;
      }

      @media (max-width: 720px) {
        .heroPrompt {
          min-height: 190px;
          padding: 22px;
        }

        .heroPrompt textarea {
          font-size: 18px;
        }

        .handoffBar {
          flex-direction: column;
          align-items: stretch;
        }
      }
    `}</style>
  );
}
