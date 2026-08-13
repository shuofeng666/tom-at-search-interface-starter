# Handoff notes

This project was built during an internship. These notes are for whoever
takes it over next — architecture, how to change the things you'll most
likely need to change, and known rough edges. Read this alongside
`README.md` (setup + the day-to-day "how do I refresh the TOM catalog"
instructions live there; this file is the bigger picture).

## What this is

A three-step assistive-technology search tool:

1. **Intake chat** (`IntakeScreen` in `app/page.tsx`, `/api/intake-chat`) —
   a Gemini-driven conversation that fills in a `NeedProfile`
   (`lib/types.ts`) describing what the person needs, until it's specific
   enough to search on.
2. **Search + review** (`ReviewScreen`, `/api/search`, `/api/evaluate`) —
   fetches candidate projects from TOM's catalog and the open web, scores
   each one against the need profile, and shows them as cards the reviewer
   can sort/filter/compare/save.
3. **Output** (`OutputScreen`, `/api/review-summary`) — a printable summary
   for the requester and for TOM staff, with next steps and an easy way to
   ask the TOM team for help.

Everything lives in one Next.js App Router project. `app/page.tsx` is a
single large client component file (~2,300 lines) containing all three
screens plus shared pieces (history/saved-projects panels, candidate
detail, comparison view). It's not split into multiple files — if you do
that, keep state ownership (`Home()`) in one place, since most of the
screens are just views over its state.

## Request flow, end to end

```
IntakeScreen  --/api/intake-chat-->  NeedProfile (client state)
     |
     v  "search related projects"
ReviewScreen  --/api/search-->  { pool: CandidateProject[] (unscored), tomCatalogSnapshotDate }
     |
     v  frontend takes a page of the pool (PAGE_SIZE = 10), scores each
     |  candidate with its OWN /api/evaluate call (all fired in parallel),
     |  and renders each card the moment its own call resolves — see
     |  scoreBatch/scoreBatchTomFirst in app/page.tsx
     --/api/evaluate (x N, one per candidate)--> scored CandidateProject
     |
     v  (loop) keep scoring more pages until enough clear the visibility bar
     --/api/tom-images--> photos for the TOM candidates about to be shown
     |
     v  "Generate summary"
OutputScreen  --/api/review-summary-->  ReviewSummary
```

Three things are deliberately **not** done the "obvious" way:

- **Fetching and scoring are separate** (`/api/search` just fetches;
  `/api/evaluate` scores). Scoring via Gemini is the slow part, so the
  frontend only scores as many candidates as it needs to fill the screen,
  and "Load more" scores another page on demand instead of scoring
  everything up front.
- **Scoring is one Gemini call per candidate, not one call for a whole
  page.** `/api/evaluate` can score an array, but the frontend always
  calls it with a single candidate (`scoreBatch` in `app/page.tsx`) and
  fires all of them in parallel — same total Gemini load and same total
  wait for the full page as one batched call, but each card can render
  the moment its own call resolves instead of the whole page blocking on
  the single slowest candidate. `scoreBatchTomFirst` builds on this: TOM
  and external candidates in a page still score fully in parallel, but any
  external candidate that finishes before the TOM group is done gets held
  back and released together right after the last TOM candidate lands —
  so results still stream in progressively, just as a TOM-group-then-
  external sequence rather than a random interleave. This is also where
  the `cardEnter` CSS animation in `globals.css` comes in: since React
  keeps the same DOM node for a candidate across re-sorts (matching key),
  the fade/rise-in only plays once, on a card's real first appearance.
- **TOM search and TOM images are separate** (`lib/tom.ts`'s
  `searchTomProjects` vs. `attachTomImages`, called from
  `/api/tom-images`). Search/ranking is 100% local (the CSV), so it's fast
  and reliable. Images require a live network call per candidate, so we
  only ever do that for the small number of candidates that actually end
  up visible — see "Known issues / tuning knobs" below for why this
  matters.

## Data sources

- **TOM projects**: `data/tom-solutions.csv`, a static export TOM
  provided (~570 rows: name, link, summary, who/why/how/what, category,
  tags). Parsed once per server instance and cached in memory
  (`lib/tom.ts`). Matching is local keyword scoring, not an LLM and not a
  live API — see `README.md` → "TOM project catalog" for the refresh
  procedure. `data/tom-solutions.meta.json` holds the export date, shown
  in the UI next to TOM results.
- **Everything else** (Instructables, Thingiverse, Printables, GitHub,
  Amazon, Walmart, Etsy, and TOM's own site as a semantic-search
  supplement): Exa API (`lib/exa.ts`, `EXA_API_KEY`), one call per
  configured domain, interleaved so no single domain dominates the pool.
- **TOM photos only** (not search): TOM's live project API, if
  `TOM_SEARCH_API_URL` is set. Technically optional (the app still runs
  without it), but treat it as required — without it TOM cards silently
  show no photo, with nothing in the UI to explain why. See `lib/tom.ts`'s
  `attachTomImages`, and "Known issues" below.
- **Scoring, chat, and summaries**: Gemini (`GEMINI_API_KEY`,
  `GEMINI_MODEL`, default `gemini-2.5-flash`) via `lib/gemini.ts`.

## Environment variables

See `.env.example` for the full list with explanations. The one gotcha
worth calling out explicitly: `EXA_PRIMARY_DOMAINS` /
`EXA_SECONDARY_DOMAINS` / `EXA_COMMERCIAL_DOMAINS` are what
`/api/search` actually reads for external search domains.
`EXA_INCLUDE_DOMAINS` is leftover from an earlier version and is dead code
(nothing calls the function that reads it) — don't set it, and don't be
confused if it's missing from wherever these are actually deployed.

## Deployment

Built for Vercel (there's nothing Vercel-specific in the code beyond
`next.config.mjs`'s `outputFileTracingIncludes`, which makes sure the CSV
+ meta JSON get bundled into the serverless function for `/api/search` —
if you deploy elsewhere and TOM results silently come back empty, check
that those two files are actually present next to the function at
runtime). Set all the env vars from `.env.example` in the hosting
platform's dashboard. No database, no auth — it's a stateless tool; the
only persistence is client-side (`localStorage`, see below).

## Known issues / tuning knobs

- **"TOM images are missing" has two completely different causes — check
  both.** This came up repeatedly and cost a lot of back-and-forth before
  the actual cause was found, so future-you should check both possibilities
  immediately instead of re-diagnosing from scratch:
  1. *Config*: `TOM_SEARCH_API_URL` isn't set (or isn't set on the specific
     deployment being tested) in the hosting platform's dashboard. This is
     what actually happened in production — the variable was simply
     missing, so `attachTomImages` was silently taking its no-op path the
     entire time. No error anywhere; the code was never the problem. Adding
     the variable requires a fresh deploy to take effect — saving it alone
     does not update a deployment that's already running. Confirmed via
     `curl -X POST <deployment>/api/tom-images` with a real TOM id/title
     (see `data/tom-solutions.csv` for real ones) — empty `results: []`
     back in well under a second is the signature of the no-op path (a real
     per-candidate network lookup takes noticeably longer and varies more).
  2. *Code*: the image-search API call used to pass `selectedTypes=5`
     (TOM's "product" project type), which silently excluded most of the
     catalog — a large share of TOM projects are other types (concepts,
     works, prototypes) that filter permanently hid, no matter how exact
     the title match was. Already fixed (removed in `fetchTomProjectImages`
     in `lib/tom.ts`), verified against TOM's real API across a random CSV
     sample (~28% exact-match hit rate with the filter, ~97% without). If
     images go missing again, rule out cause 1 first — it's the faster
     check and it's what actually happened last time.
- **Serverless function timeouts are the main failure mode to watch for.**
  The single biggest bug fixed during this internship was TOM photos
  silently disappearing because an earlier version fetched images for the
  *entire* CSV catalog before a search could return anything — on Vercel
  that risks the platform timing out the function with no visible
  JS-level error (the request just never completes, or comes back without
  images and no exception in the logs). If something starts silently
  failing again, check whether a change reintroduced an unbounded
  per-candidate network loop before scoring/filtering has narrowed the
  set down. The fix pattern is: only ever do slow per-candidate work
  (image lookups, extra scoring) on the small on-screen set, after
  filtering — see `enrichTomImages` in `app/page.tsx` and
  `attachTomImages` in `lib/tom.ts`.
- **Search speed vs. result count is a tunable tradeoff, not a solved
  problem.** `app/page.tsx` has `PAGE_SIZE`, `MIN_TOTAL_VISIBLE_TARGET`,
  `MIN_TOM_VISIBLE_TARGET`, and `MAX_AUTO_SCORE_BATCHES` near the top —
  together they control how many pages of candidates get auto-scored
  before showing results, i.e. how long the user waits vs. how many
  results they're guaranteed to see. These were dialed back once already
  in response to a "search is slow" complaint. If that complaint comes
  back, the next lever to pull is lowering `MIN_TOM_VISIBLE_TARGET` /
  `MIN_TOTAL_VISIBLE_TARGET` further, or reducing `PAGE_SIZE` (Gemini
  scoring is parallel within a page, so a smaller page returns faster but
  needs more "Load more" round trips).
  - Total backend time is only half the story — actual per-candidate
    Gemini scoring calls are the slow part (each one generates a fairly
    large structured JSON with 7 scored dimensions + explanations +
    evidence), and there wasn't much room left to cut that without hurting
    scoring quality. The bigger win ended up being perceived speed, not
    raw speed: `scoreBatch`/`scoreBatchTomFirst` in `app/page.tsx` render
    each card as its own `/api/evaluate` call resolves instead of blocking
    on the whole page, cutting time-to-first-card roughly in half in
    production testing even though total page time was unchanged. If
    speed complaints come back, look at shortening the evaluation prompt's
    output (fewer/shorter `evidence` array items, in `lib/evaluate.ts`)
    before reaching for a faster/cheaper model — a model swap risks
    scoring quality and hasn't been tested.
- **Intake question quality is an ongoing prompt-tuning target, not a
  one-time fix.** Stakeholders complained the first-screen follow-up
  questions felt too broad/generic. Testing against production with real
  openers ("I need a cup holder for my wheelchair", etc.) found a clear,
  reproducible failure mode: the model kept joining two different
  questions into one sentence with "and"/"or" (e.g. "What activity do you
  need the key for, and what would make it easier for you?") — a compound
  question reads as vague even though it's grammatically one sentence, and
  the user can't actually answer both halves at once. Fixed with an
  explicit rule + bad/good examples in `/api/intake-chat`'s system prompt
  (`buildSystemPrompt` in `app/api/intake-chat/route.ts`), plus a rule
  against asking WHY (cause/diagnosis) before WHAT (the barrier itself).
  Verified with ~20 real test conversations post-fix, but this is prompt
  behavior, not a hard guarantee — an LLM can still occasionally slip back
  into old patterns (seen once in ~20 samples during testing), and a
  future model swap could reintroduce it entirely. If this complaint comes
  back, test with real openers against production first (like this round
  did) to find the actual reproducible pattern before changing the prompt
  again — guessing at what "feels broad" without a concrete failing
  example tends to produce vague prompt tweaks that don't reliably fix
  anything.
- **TOM vs. external dedupe is title-similarity only** (see
  `isLikelyDuplicateTitle` in `app/page.tsx`) — it substring-matches
  normalized titles. It's deliberately conservative (won't hide an
  external result unless a TOM title is a near-exact match) to avoid
  hiding genuinely different projects that happen to share a common name.
  If cross-listed duplicates start slipping through, the likely cause is
  a TOM project whose CSV title differs a lot from how it's listed
  externally — that needs a smarter match (e.g. comparing URLs, or an LLM
  similarity check) rather than a threshold tweak.
- **Non-English intake**: `needProfile` fields are required to be in
  English regardless of what language the conversation happens in
  (`/api/intake-chat`'s system prompt), because TOM catalog matching is
  literal English keyword overlap — a Spanish need profile would silently
  match nothing. If TOM matching seems to break for non-English users
  again, check that this instruction is still being followed by the model
  (it's a prompt rule, not code, so it can drift with model updates).
- **`body.json` at the repo root** is a stray debug artifact (a raw
  Gemini request body someone dumped while testing) — harmless, but safe
  to delete whenever someone's doing repo cleanup.

## Client-side persistence

Search history and globally saved projects live in `localStorage`
(`lib/clientStorage.ts`), not a database — there's no backend user
concept at all. That means: no login, nothing crosses devices/browsers,
and clearing browser storage loses it. If TOM wants persistence across
devices or multiple staff sharing saved projects, that's a real backend
(auth + database) to add, not a config change.

## If you're picking this up cold, start here

1. Run it locally (`README.md` → Setup) with your own API keys and try a
   full flow: intake -> search -> review -> summary.
2. Read `app/page.tsx`'s `Home()` function top to bottom — it owns all
   state and orchestrates the three screens; everything else is a view
   over it.
3. Read `lib/tom.ts` and `lib/evaluate.ts` — these are where "is this
   result good" actually gets decided (local keyword scoring for TOM
   recall, Gemini scoring for relevance ranking).
4. Check the git log for this project — commit messages consistently
   explain *why* a change was made (usually a specific stakeholder
   complaint), which is often more useful context than the diff itself.
