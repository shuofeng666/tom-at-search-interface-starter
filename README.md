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