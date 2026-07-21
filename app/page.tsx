"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CandidateProject,
  ChatMessage,
  IntakeChatResponse,
  NeedProfile,
  ReviewSummary,
} from "@/lib/types";
import { emptyNeedProfile } from "@/lib/types";

type Stage = "intake" | "review" | "output";

// Phase 1 returns an unscored pool; we score PAGE_SIZE at a time (first page +
// each "Load more").
type SearchPoolResponse = {
  query: string;
  pool: CandidateProject[];
};

const PAGE_SIZE = 8;

const MIN_VISIBLE_SCORE = 1;
const MIN_VISIBLE_TOM_SCORE = 1;

function isTomCandidate(candidate: CandidateProject) {
  const sourceText = `${candidate.source} ${candidate.url} ${candidate.sourceType}`.toLowerCase();

  return (
    candidate.sourceType === "TOM project" ||
    sourceText.includes("tomglobal.org")
  );
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

// Guarantee TOM is represented even when no TOM candidate cleared the normal
// visibility bar: backfill with the best-scoring TOM candidates that aren't a
// clear mismatch, up to MIN_GUARANTEED_TOM_VISIBLE. Never backfills with a
// candidate flagged as a clear mismatch — a guaranteed slot still has to be a
// plausible fit.
const MIN_GUARANTEED_TOM_VISIBLE = 2;

function prepareVisibleCandidates(scored: CandidateProject[]) {
  const visible = scored.filter(isVisibleCandidate);
  const visibleTomCount = visible.filter(isTomCandidate).length;

  if (visibleTomCount >= MIN_GUARANTEED_TOM_VISIBLE) {
    return sortDisplayCandidates(visible);
  }

  const visibleIds = new Set(visible.map((candidate) => candidate.id));

  const tomBackfill = scored
    .filter(
      (candidate) =>
        isTomCandidate(candidate) &&
        !visibleIds.has(candidate.id) &&
        !isClearlyBadMatch(candidate),
    )
    .sort(
      (a, b) =>
        (b.evaluation?.overallScore ?? 0) - (a.evaluation?.overallScore ?? 0),
    )
    .slice(0, MIN_GUARANTEED_TOM_VISIBLE - visibleTomCount);

  return sortDisplayCandidates([...visible, ...tomBackfill]);
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
  const [loading, setLoading] = useState<string | null>(null);
  const [selectedForComparison, setSelectedForComparison] = useState<string[]>(
    [],
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );

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
  async function scoreBatch(
    batch: CandidateProject[],
  ): Promise<CandidateProject[]> {
    const res = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needProfile, candidates: batch }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Evaluation failed.");

    return (data.candidates || []) as CandidateProject[];
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

      // Score only the first page; the rest waits behind "Load more".
      const firstBatch = fetchedPool.slice(0, PAGE_SIZE);
      const scored = await scoreBatch(firstBatch);
      const visibleScored = prepareVisibleCandidates(scored);

      setCandidates(visibleScored);
      setPoolCursor(firstBatch.length);
      setSelectedCandidateId(visibleScored[0]?.id || null);
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
const scored = await scoreBatch(nextBatch);
const visibleScored = prepareVisibleCandidates(scored);

setCandidates((previous) =>
  sortDisplayCandidates([...previous, ...visibleScored])
);
      setPoolCursor((previous) => previous + nextBatch.length);
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

      setCandidates((previous) =>
        previous.map((item) =>
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
        ),
      );
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

  function toggleComparison(id: string) {
    setSelectedForComparison((previous) =>
      previous.includes(id)
        ? previous.filter((candidateId) => candidateId !== id)
        : [...previous, id],
    );
  }

  return (
    <main className={loading ? "app isLoading" : "app"}>
      <InterfaceOverrides />

      {loading && <div className="loadingPill">{loading}...</div>}
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
  const showSearchAction = readyForSearch && userTurnCount >= 2;

  if (!messages.length) {
    return (
      <section className="landing">
        <div className="promptShell">
          <div className="promptLabel">TOM</div>

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
        <span>TOM</span>
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
              >
                Search related projects
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
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  selectedCandidate: CandidateProject | null;
  selectedForComparison: string[];
  savedCandidates: CandidateProject[];
  query: string;
  setSelectedCandidateId: (id: string) => void;
  toggleComparison: (id: string) => void;
  rejectCandidate: (
    candidate: CandidateProject,
    rejectionReason: string,
  ) => void;
  runSearch: (query?: string) => void;
  loadMore: () => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  generateReviewSummary: () => void;
  onBackToIntake: () => void;
}) {
  return (
    <section className="workspace">
      <header className="workspaceHeader">
        <button className="plainBtn" onClick={onBackToIntake}>
          ← Intake
        </button>

        <div>
          <h1>Search review</h1>
          <p>
            Check whether these projects match the need before preparing a
            summary.
          </p>
        </div>

        <div className="headerNeedCheck">
          <div>
            <p className="headerNeedCheckTitle">Does this match the need?</p>
            <p className="headerNeedCheckText">
              If the results feel off, add one more detail before summarizing.
            </p>
          </div>

          <div className="headerNeedCheckActions">
            <button className="sendBtn" onClick={onBackToIntake}>
              Add more details
            </button>
            <button className="plainBtn" onClick={() => location.reload()}>
              New search
            </button>
          </div>
        </div>
      </header>

      <div className="workspaceGrid">
        <aside className="panel leftPanel">
          <h2>Need</h2>
          <NeedProfileView profile={needProfile} />

          <h3>Search directions</h3>
          <div className="chips">
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

          {query && (
            <p className="small">
              <b>Last query:</b> {query}
            </p>
          )}
        </aside>

        <section className="panel resultsPanel">
          <h2>Related projects</h2>
          <p className="small resultsHint">
            In source order. Tap a card for details.
          </p>

          <div className="candidateList">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                active={candidate.id === selectedCandidate?.id}
                selected={selectedForComparison.includes(candidate.id)}
                onSelect={() => setSelectedCandidateId(candidate.id)}
                onToggleComparison={() => toggleComparison(candidate.id)}
              />
            ))}
          </div>

          {canLoadMore && (
            <button
              className="plainBtn loadMoreBtn"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Scoring…" : "Load more"}
            </button>
          )}
        </section>

        <aside className="panel detailPanel">
          {selectedCandidate ? (
            <CandidateDetail
              candidate={selectedCandidate}
              selected={selectedForComparison.includes(selectedCandidate.id)}
              onToggleComparison={() => toggleComparison(selectedCandidate.id)}
              onReject={(reason) => rejectCandidate(selectedCandidate, reason)}
            />
          ) : (
            <p className="small">Select a candidate to inspect details.</p>
          )}

          {savedCandidates.length > 0 && (
            <>
              <h3>Saved comparison</h3>
              <ComparisonView candidates={savedCandidates} />
            </>
          )}
        </aside>
      </div>
    </section>
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

  return (
    <section className="workspace outputWorkspace">
      <header className="workspaceHeader">
        <button className="plainBtn" onClick={onBackToReview}>
          ← Review
        </button>

        <div>
          <h1>Prepared summary</h1>
          <p>Internal notes and a safer user-facing message.</p>
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
  return (
    <article
      className={active ? "projectCard active" : "projectCard"}
      onClick={onSelect}
    >
      <div className="cardMedia">
        {candidate.image ? (
          <img
            src={candidate.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="cardMediaFallback">{candidate.sourceType}</div>
        )}

        {candidate.rejected && <span className="cardRejected">rejected</span>}
      </div>

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
  selected,
  onToggleComparison,
  onReject,
}: {
  candidate: CandidateProject;
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

      {candidate.image && (
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

function UserFacingCard({ candidate }: { candidate: CandidateProject }) {
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

      <a
        className="openLink"
        href={candidate.url}
        target="_blank"
        rel="noreferrer"
      >
        Open original ↗
      </a>
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
