# TOM Assistive Technology Search Interface

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

## TOM project catalog

TOM project search reads `data/tom-solutions.csv` directly — no live API or
API key involved. It's parsed once, cached in memory, and every row is
scored locally against the intake need profile, so TOM results are reliable
and don't depend on an external endpoint being up or guessing the right
keyword.

Expected columns:

```text
Solution Name, Link, Summary, Who, Why, How, What, Category, Tags
```

This is a snapshot, not a live feed: new TOM projects won't show up in
search until this file is refreshed. To update it, ask TOM for a fresh
export in the same column format, replace `data/tom-solutions.csv`, and
update the date in `data/tom-solutions.meta.json` — the results page shows
that date next to the TOM results so staff know how fresh the data is.

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

### "Download TOM request"

Candidates whose evaluation pathway suggests TOM staff involvement (needs
adaptation, maker team review, possible new TOM challenge, or needs more
information) show a "Download TOM request (.txt)" button. It downloads a
plain-text report (full need profile + the candidate's fit assessment)
instead of opening a `mailto:` link — mailto depends on the browser having
a default mail app configured, which often isn't true on shared/work
computers, so it silently does nothing there. The downloaded file can be
attached to an email, pasted into Slack, or added to a ticket, whatever
the reviewer's actual workflow is.
