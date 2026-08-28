# Making Assistive Technology Searchable for the People Who Know the Problem

*Written by Shuo Feng*

**How can someone who knows a daily challenge — but not the name of the device that
solves it — find the assistive technology that already exists?**

Assistive technology (AT) has a discovery problem, not only a supply problem. Thousands
of relevant solutions already exist: open-source builds on GitHub and Printables, DIY
projects on Instructables and Thingiverse, community-made devices from ATMakers and
Makers Making Change, commercial products, and the catalog of past projects built by
[TOM (Tikkun Olam Makers)](https://tomglobal.org) maker communities around the world. But
finding them requires something that the people who need them rarely have: the right
search words.

Search engines assume you already know what you are looking for. A person who cannot
open a bottle of water one-handed does not search for "bottle opener with suction base."
They describe a moment in their day. And the two most important groups in the AT
pipeline — Need-Knowers (the people living with the challenge) and the maker teams and
staff who take their requests — end up doing the translation by hand, one project page
at a time.

This summer, as a Siegel PiTech PhD Impact Fellow working with TOM, my project focused
on that translation gap:

1. Turning a described daily challenge into a structured, searchable need
2. Searching across TOM's own catalog and the wider open-source and commercial AT
   landscape at the same time
3. Making the comparison between candidates explicit, so a recommendation can be
   justified rather than just ranked

## Building from the Way TOM Already Works

TOM's process begins with a Need-Knower describing a challenge, and ends with a maker
team either adapting an existing solution or building a new one. The most expensive step
in between is the one nobody sees: someone has to work out whether the thing already
exists.

Working with TOM staff, I learned that this step fails in two specific ways. It fails
when the intake conversation collects the wrong information — an object name instead of
an activity barrier, a diagnosis instead of a constraint. And it fails when the search
returns plausible-looking results that quietly violate something non-negotiable: a
solution that needs two hands for someone who has one free, or a product that cannot
ship to the user's country.

Those two failure modes shaped the whole tool. The interface is not trying to be a better
search box. It is trying to preserve the difference between "related to what you said"
and "actually usable by this person."

## A Method: From Conversation to Structured Need to Justified Comparison

The tool works in three connected stages.

**1. An intake conversation that refuses to take an object as the answer.**
The first screen is a chat, not a search bar. A language model interviews the user and
progressively fills in a structured *Need Profile*: the activity, the barrier, the
desired outcome, plus age, region, who is asking (the person themselves, a caregiver, a
clinician), relevant body function, current devices, environment, must-haves,
must-avoids, and safety concerns.

The core rule is that a named object is never the need. "I need an umbrella for my
wheelchair" is recorded as *moving outdoors in the rain while propelling a wheelchair,
without occupying either hand* — which is a very different search, and a much better one.
The conversation happens in whatever language the user prefers, while the profile itself
is always stored in English, because everything downstream matches against
English-language catalogs. Both chat inputs also support voice dictation, so the intake
does not assume comfortable typing.

**2. A search across TOM and the rest of the landscape at once.**
Once the need is specific enough, the profile becomes a query against TOM's own project
catalog and, through the Exa neural search API, against open-source and DIY platforms
(Instructables, Thingiverse, Printables, GitHub, ATMakers, Makers Making Change) and
commercial sources (Amazon, Walmart, Etsy, Enabling Devices). TOM results are fetched
live and backfilled from a catalog export of roughly 570 past projects, so a TOM solution
that already answers the need is never buried under retail listings. Results are
interleaved so no single site dominates, and cross-posted duplicates collapse to the TOM
version.

**3. Structured evaluation instead of a relevance rank.**
Every candidate is then scored against *this* need profile on seven dimensions — need
fit, critical requirements, context fit, access pathway, adaptation feasibility, evidence
quality, and safety and risk — each with a short explanation and the evidence it was
drawn from, plus a location-aware cost estimate and a recommended pathway: *can
recommend*, *needs adaptation*, *maker team review*, *possible new TOM challenge*, and so
on.

The important design decision here is negative: the tool is explicitly told it is not
judging a competition, and it is not allowed to average away a hard failure. A beautifully
documented project that fails a must-have cannot be scored as a strong match, no matter
how good its photos and instructions are. Reviewers can sort, filter, compare candidates
side by side, save projects across sessions, and export a summary written twice — once
for the requester, once for the TOM team, with next steps and open questions. When
nothing fits, that is a result too: the summary hands off to TOM's request pipeline as a
possible new challenge rather than pretending a near-miss is a match.

> *Figure 1: The intake conversation, the ranked candidate set with per-dimension
> explanations, and the exported review summary.*

## What Feedback Changed

The most useful sessions were the ones where TOM staff used the tool on real needs and
told me what felt wrong. Three rounds of that feedback changed the design more than my
original plan did:

- **"The questions feel generic."** Testing against real openers ("I need a cup holder
  for my wheelchair") revealed a reproducible pattern rather than a vague impression: the
  model kept fusing two questions into one sentence with *and* — a question the user
  cannot actually answer. It was also asking *why* something was hard (cause, diagnosis)
  before asking *what* was hard. Naming both patterns explicitly, with failing and
  passing examples, fixed them.
- **"It asks things that don't matter."** Every intake field became conditional on a
  single test: would knowing this change which solutions I would look for? If not, the
  tool fills it in as not applicable and moves on instead of completing a form.
- **"It's slow."** Total search time was dominated by per-candidate evaluation, and
  cutting it meant cutting scoring quality. The fix was to change what waiting feels
  like: each card now appears the moment its own evaluation resolves, TOM projects as a
  group first, roughly halving time-to-first-result without changing total time at all.

I also dropped a piece of my original proposal. I had planned a ranking-conflict
mechanism that would detect when a user's ordering of candidates could not be explained
by their stated criteria, and use that contradiction to surface hidden criteria. Watching
real intake sessions convinced me the earlier bottleneck mattered more: users were not
struggling to rank a good candidate set, they were struggling to produce one. Getting the
need articulated well enough to search on was the higher-value problem this summer, and
the ranking layer is the natural next step now that the candidate set is trustworthy.

**Shuo Feng**
Ph.D. Student, Information Science, Cornell University

## Impact and Path Forward

By the end of the summer I had a working interface that takes a spoken or typed
description of a daily challenge and returns a comparable, explained, source-diverse set
of assistive technology candidates — with a summary that a Need-Knower and a maker team
can each act on. The project is documented and handed off for continued development
inside TOM.

The next steps are the ones the current version earns rather than assumes: the ranking
and conflict-resolution layer from the original proposal, so that the act of comparing
candidates itself teaches the tool what the user actually values; a study with TOM design
teams using it on live requests; and feeding the "no good match" cases back into TOM's
challenge pipeline, where an absent solution is exactly the signal a maker community
needs.

The underlying argument is the same one that motivated the project: for assistive
technology, accessibility of *information* is part of accessibility itself. A solution
that exists but cannot be found is, for the person who needs it, a solution that does not
exist.

## Acknowledgments

This work was conducted with the TOM (Tikkun Olam Makers) team, whose staff repeatedly
tested the tool against real needs and told me plainly what was not working. I am grateful
for their guidance, and to the Siegel PiTech PhD Impact Fellowship for the opportunity.
