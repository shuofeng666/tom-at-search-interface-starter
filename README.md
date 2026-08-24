# TOM AT Search Engine

This is a prototype interface for TOM assistive technology search and review.

The interface has three practical modes:

1. Need-Knower intake agent
2. TOM internal project search and evaluation
3. User-facing and TOM-facing summary output

The first screen only shows an intake prompt. Internal evaluation and project cards appear after the intake is specific enough for search.

Taking over this project? See [`HANDOFF.md`](./HANDOFF.md) for the
architecture overview, deployment notes, and known rough edges.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

## TOM project search

TOM results come from two sources, in priority order:

1. **Live search** of tomglobal.org itself (via Exa, `EXA_PRIMARY_DOMAINS`)
   — the default, preferred source. Most TOM results a user actually sees
   come from here.
2. **`data/tom-solutions.csv`**, a static snapshot TOM provided, scored
   locally against the intake need profile — used only as a backfill, when
   live search alone doesn't turn up enough TOM results to satisfy the
   app's minimum-visible-TOM-results guarantee. No API key or live
   endpoint involved for this part, so it's a reliable floor even on a day
   live search comes up short.

This wasn't always the arrangement: live search of tomglobal.org used to
be unreliable, which is why the CSV catalog was built as the *primary*
source in the first place. It's kept as a fallback now rather than
removed, in case that regresses again — see `HANDOFF.md` for the history.

### Refreshing the CSV fallback

Expected columns:

```text
Solution Name, Link, Summary, Who, Why, How, What, Category, Tags
```

This is a snapshot, not a live feed. To update it, ask TOM for a fresh
export in the same column format, replace `data/tom-solutions.csv`, and
update the date in `data/tom-solutions.meta.json` — the results page shows
that date next to TOM results, so staff know how fresh a fallback result
actually is.

### TOM project photos

The CSV export has no image columns. If `TOM_SEARCH_API_URL` is set, TOM
cards fetch their real photos (all of them, not just one) from that live
endpoint — this is used only for photos, never for search/ranking, so the
app still runs without it; without it TOM cards just show no photo.

**Make sure this is actually set in every deployment.** It was missing
from production for a long stretch and the symptom looked like a code
bug (TOM cards silently had no photos) rather than a missing config
value — see `.env.example` for the value and `HANDOFF.md` for the full
story.

## External sources

Beyond TOM, results also come from Exa searches of open-source/DIY and
commercial assistive-tech sites — `EXA_SECONDARY_DOMAINS` and
`EXA_COMMERCIAL_DOMAINS` in `.env.example`, currently Instructables,
Thingiverse, Printables, GitHub, ATMakers, and Makers Making Change
(open-source/DIY), plus Amazon, Walmart, Etsy, and Enabling Devices
(commercial). Adding a domain to these lists isn't enough on its own for
it to display with the right label on a card — see the `detectSourceType`
comment in `lib/exa.ts`.

If the same solution shows up on both TOM and one of these external
sites (e.g. also cross-posted to Printables), only the TOM version is
shown.

## "Request a new assistive device"

At the bottom of the results screen, a "Can't find what you're looking
for? Request a new assistive device" link points to TOM's Monday.com
intake form — a fallback for when nothing found is a good match. It's a
fixed URL in `app/page.tsx`, not configurable via an env var.

## Voice input

Both intake chat inputs (the initial prompt and the ongoing chat) have a
mic button that transcribes speech into the text field, using the
browser's built-in Web Speech API — no extra dependency or API key
involved. It's dictation, not a live conversation: press it, say one
thing, review the transcript, then send as normal. Only appears in
browsers that support it (Chrome, Edge, Safari); hidden entirely on
Firefox, which doesn't.

## Branding

The TOM (Tikkun Olam Makers) logo lives at `public/tom-logo.png` and
shows in the app header. Its approximate brand colors are available as
the `--tom-blue`/`--tom-orange` CSS variables in `app/globals.css`.
