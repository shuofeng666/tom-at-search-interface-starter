# TOM Assistive Technology Search Interface

This is a prototype interface for TOM assistive technology search and review.

The interface has three practical modes:

1. Need-Knower intake agent
2. TOM internal project search and evaluation
3. User-facing and TOM-facing summary output

The first screen only shows an intake prompt. Internal evaluation and project cards appear after the intake is specific enough for search.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

## TOM Global CSV fallback

If TOM Global pages are not discoverable through web search, export TOM's own
solution list as a CSV (or tab-separated file) and save it in the app as:

```text
data/tom-global-solutions.csv
```

Expected columns:

```text
Solution Name, Link, Summary, Who, Why, How, What, Category, Tags
```

The search API reads this file automatically, scores every row against the
intake need profile, and merges the best TOM CSV matches ahead of the API/web
search results. You can point the app at a different file with:

```bash
TOM_PROJECTS_CSV_PATH=/absolute/or/project-relative/path/to/your-file.csv
```

For best results, start with `Solution Name`, `Summary`, `Why`, `What`,
`Category`, and `Tags`. The app also indexes `Who` and `How`, so adding those
columns usually improves recall for edge cases without making search slower.
