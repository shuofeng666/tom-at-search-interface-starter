"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  CandidateProject,
  ChatMessage,
  IntakeChatResponse,
  NeedProfile,
  ReviewSummary
} from "@/lib/types";
import { emptyNeedProfile } from "@/lib/types";

type Stage = "intake" | "review" | "output";

type SearchResponse = {
  query: string;
  candidates: CandidateProject[];
  usedMockData?: boolean;
};

const rejectionOptions = [
  { value: "requires-hand-use", label: "requires too much hand use" },
  { value: "not-removable", label: "not removable" },
  { value: "not-compatible", label: "does not fit the user/device/context" },
  { value: "hard-to-clean", label: "hard to clean or maintain" },
  { value: "not-safe", label: "possible safety risk" },
  { value: "too-expensive", label: "too expensive" },
  { value: "not-portable", label: "not portable" },
  { value: "not-available", label: "not available locally" },
  { value: "poor-documentation", label: "documentation is incomplete" }
];

function scoreTone(score: number): "good" | "warn" | "bad" {
  if (score >= 2.4) return "good";
  if (score >= 1.5) return "warn";
  return "bad";
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("intake");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
const [needProfile, setNeedProfile] = useState<NeedProfile>(emptyNeedProfile());
const [error, setError] = useState<string | null>(null);
  const [readyForSearch, setReadyForSearch] = useState(false);
  const [handoffReason, setHandoffReason] = useState("");
  const [missingInformation, setMissingInformation] = useState<string[]>([]);
  const [suggestedReplies, setSuggestedReplies] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateProject[]>([]);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<string | null>(null);
  const [selectedForComparison, setSelectedForComparison] = useState<string[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const savedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedForComparison.includes(candidate.id)),
    [candidates, selectedForComparison]
  );

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedCandidateId) || candidates[0] || null,
    [candidates, selectedCandidateId]
  );

async function sendIntakeMessage(content?: string) {
  const text = (content ?? draft).trim();
  if (!text) return;

  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: text
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
        currentNeedProfile: needProfile
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Intake agent failed.");
    }

    const intakeData = data as IntakeChatResponse;

    const assistantMessage: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: intakeData.assistantMessage
    };

    setMessages([...nextMessages, assistantMessage]);
    setNeedProfile(intakeData.needProfile);
    setReadyForSearch(intakeData.readyForInternalSearch);
    setHandoffReason(intakeData.handoffReason);
    setMissingInformation(intakeData.missingInformation || []);
    setSuggestedReplies(intakeData.suggestedReplies || []);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "The intake agent failed.";

    setError(message);
    setMessages([
      ...nextMessages,
      {
        id: `assistant-error-${Date.now()}`,
        role: "assistant",
        content:
          "The intake agent could not connect right now. Please check the Gemini API connection and try again."
      }
    ]);
  } finally {
    setLoading(null);
  }
}
async function startSearch(customQuery?: string) {
  setLoading("searching projects");
  setError(null);
  setStage("review");
  setReview(null);
  setSelectedForComparison([]);

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        needProfile,
        query: customQuery
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Search failed.");
    }

    const searchData = data as SearchResponse;
    setQuery(searchData.query);

    const list = searchData.candidates || [];
    setCandidates(list);
    setSelectedCandidateId(list[0]?.id || null);

    if (!list.length) {
      setError("No real search results were returned. Try broadening the query or removing domain filters.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed.";
    setError(message);
    setCandidates([]);
    setSelectedCandidateId(null);
  } finally {
    setLoading(null);
  }
}

  async function rejectCandidate(candidate: CandidateProject, rejectionReason: string) {
    setLoading("updating criteria");
    setReview(null);

    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needProfile,
          candidate,
          rejectionReason
        })
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
                  rejectionOptions.find((option) => option.value === rejectionReason)?.label ||
                  rejectionReason
              }
            : item
        )
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
          candidates
        })
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
        : [...previous, id]
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
  onStartSearch
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

  if (!messages.length) {
    return (
      <section className="landing">
        <div className="promptShell">
          <div className="promptLabel">TOM</div>

          <form className="heroPrompt" onSubmit={handleSubmit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Describe the challenge, daily activity, or assistive technology need..."
              autoFocus
            />

            <div className="heroActions">
             
              <button type="submit" className="sendBtn">
                Search
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
        <div className="chatMessages">
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
            placeholder="Answer here..."
          />
          <button className="sendBtn" type="submit">
            Send
          </button>
        </form>
      </div>

{readyForSearch && (
  <div className="handoffSummary">
    <div>
      <p className="summaryLabel">Ready to search</p>

      <p className="summaryText">
        {handoffReason ||
          `I understand the need as: ${needProfile.activity} — ${needProfile.problem}`}
      </p>

      <div className="summaryGrid">
        <div>
          <b>Activity</b>
          <span>{needProfile.activity || "not specified"}</span>
        </div>

        <div>
          <b>Problem</b>
          <span>{needProfile.problem || "not specified"}</span>
        </div>

        <div>
          <b>User context</b>
          <span>{needProfile.userContext.join(", ") || "not specified"}</span>
        </div>

        <div>
          <b>Search directions</b>
          <span>
            {needProfile.searchDirections.slice(0, 4).join(", ") ||
              "to be generated"}
          </span>
        </div>
      </div>

      {missingInformation.length > 0 && (
        <p className="missingText">
          Useful to confirm later: {missingInformation.slice(0, 4).join(", ")}
        </p>
      )}
    </div>

    <button className="sendBtn" onClick={onStartSearch}>
      Search related projects
    </button>
  </div>
)}
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
  generateReviewSummary,
  onBackToIntake
}: {
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  selectedCandidate: CandidateProject | null;
  selectedForComparison: string[];
  savedCandidates: CandidateProject[];
  query: string;
  setSelectedCandidateId: (id: string) => void;
  toggleComparison: (id: string) => void;
  rejectCandidate: (candidate: CandidateProject, rejectionReason: string) => void;
  runSearch: (query?: string) => void;
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
          <p>Review candidate projects before any user-facing recommendation is prepared.</p>
        </div>

        <button className="sendBtn" onClick={generateReviewSummary}>
          Prepare summary
        </button>
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
          <p className="small resultsHint">Sorted by score, highest first. Tap a card for details.</p>

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

function OutputScreen({
  review,
  needProfile,
  candidates,
  savedCandidates,
  onBackToReview
}: {
  review: ReviewSummary;
  needProfile: NeedProfile;
  candidates: CandidateProject[];
  savedCandidates: CandidateProject[];
  onBackToReview: () => void;
}) {
  const displayCandidates = savedCandidates.length ? savedCandidates : candidates.slice(0, 3);

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
  compact = false
}: {
  profile: NeedProfile;
  compact?: boolean;
}) {
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

      <ChipRow label="User context" items={profile.userContext} />
      <ChipRow label="Environment" items={profile.environment} />
      <ChipRow label="Must have" items={profile.mustHave} tone="good" />
      <ChipRow label="Must avoid" items={profile.mustAvoid} tone="bad" />

      {!compact && <ChipRow label="Safety" items={profile.safetyConcerns} tone="warn" />}
      {!compact && <ChipRow label="Unknowns" items={profile.unknowns} />}
    </div>
  );
}

function ChipRow({
  label,
  items,
  tone
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

function CandidateRow({
  candidate,
  active,
  selected,
  onSelect,
  onToggleComparison
}: {
  candidate: CandidateProject;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleComparison: () => void;
}) {
  const evaluation = candidate.evaluation;
  const tone = scoreTone(evaluation.overallScore);

  return (
    <article
      className={active ? "projectCard active" : "projectCard"}
      onClick={onSelect}
    >
      <div className="cardMedia">
        {candidate.image ? (
          <img src={candidate.image} alt="" loading="lazy" />
        ) : (
          <div className="cardMediaFallback">{candidate.sourceType}</div>
        )}
        <span className={`scoreBadge ${tone}`}>{evaluation.overallScore.toFixed(1)}</span>
        {candidate.rejected && <span className="cardRejected">rejected</span>}
      </div>

      <div className="cardBody">
        <span className="cardType">{candidate.sourceType}</span>
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
  onReject
}: {
  candidate: CandidateProject;
  selected: boolean;
  onToggleComparison: () => void;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState(rejectionOptions[0].value);
  const evaluation = candidate.evaluation;
  const tone = scoreTone(evaluation.overallScore);

  return (
    <article className="candidateDetail">
      <div className="detailHead">
        <span className="cardType">{candidate.sourceType}</span>
        <span className={`scoreBadge ${tone}`}>{evaluation.overallScore.toFixed(1)} / 3</span>
      </div>

      <h2>{candidate.title}</h2>

      <a className="openOriginal" href={candidate.url} target="_blank" rel="noreferrer">
        Open original ↗
      </a>

      {candidate.image && (
        <img className="detailThumb" src={candidate.image} alt="" loading="lazy" />
      )}

      <span className="chip warn detailPathway">{evaluation.pathway}</span>

      <div className="scoreGrid">
        <ScoreBox label="Fit" value={evaluation.functionalFit.score} />
        <ScoreBox label="Safety" value={evaluation.safetyRisk.score} />
        <ScoreBox label="Docs" value={evaluation.documentationQuality.score} />
        <ScoreBox label="Make" value={evaluation.accessibilityManufacturability.score} />
        <ScoreBox label="Cost" value={evaluation.affordabilityAvailability.score} />
        <ScoreBox label="Testing" value={evaluation.userTestingEvidence.score} />
      </div>

      <div className="evalBlock">
        <h4>Pathway</h4>
        <p>{evaluation.pathwayReason}</p>
      </div>

      <div className="evalBlock">
        <h4>Functional fit</h4>
        <p>{evaluation.functionalFit.explanation}</p>
      </div>

      <div className="evalBlock">
        <h4>Safety</h4>
        <p>{evaluation.safetyRisk.explanation}</p>
      </div>

      <div className="evalBlock">
        <h4>Documentation</h4>
        <p>{evaluation.documentationQuality.explanation}</p>
      </div>

      <ChipRow label="Matched" items={evaluation.matchedCriteria} tone="good" />
      <ChipRow label="Unmatched" items={evaluation.unmatchedCriteria} tone="bad" />
      <ChipRow label="Missing" items={evaluation.missingInformation} tone="warn" />

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

        <select value={reason} onChange={(event) => setReason(event.target.value)}>
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

function ScoreBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="scoreBox">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function ComparisonView({ candidates }: { candidates: CandidateProject[] }) {
  return (
    <div className="comparisonTableWrap">
      <table className="comparisonTable">
        <thead>
          <tr>
            <th>Project</th>
            <th>Fit</th>
            <th>Safety</th>
            <th>Docs</th>
            <th>Pathway</th>
          </tr>
        </thead>

        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td>{candidate.title}</td>
              <td>{candidate.evaluation.functionalFit.score}</td>
              <td>{candidate.evaluation.safetyRisk.score}</td>
              <td>{candidate.evaluation.documentationQuality.score}</td>
              <td>{candidate.evaluation.pathway}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewSummaryView({
  review,
  internal
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

      {internal && <SummaryList title="Next actions for TOM" items={review.nextActionsForTomTeam} />}
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
        <b>Why it may help:</b> {candidate.evaluation.functionalFit.explanation}
      </p>

      <p className="small">
        <b>What TOM should check:</b>{" "}
        {candidate.evaluation.missingInformation.slice(0, 3).join(", ") ||
          "No major missing information detected."}
      </p>

      <a className="openLink" href={candidate.url} target="_blank" rel="noreferrer">
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
          linear-gradient(120deg, #f28b82, #fdd663, #81c995, #78d9ec, #8ab4f8) border-box;
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