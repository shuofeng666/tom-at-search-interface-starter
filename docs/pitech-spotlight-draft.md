# From a Long Form to a Usable Answer: Rethinking How Assistive Technology Requests Get Handled

*Written by Shuo Feng*

**When someone asks an assistive technology organization for help, how does a described
daily challenge become something an expert or a maker team can actually act on?**

Organizations like [TOM (Tikkun Olam Makers)](https://tomglobal.org) exist to close the
gap between people living with a daily challenge — Need-Knowers — and the makers who can
build for them. The bottleneck is rarely willingness, and it is rarely raw capability.
It is the path a request has to travel between those two points.

Today that path usually starts with a long intake form. The person is asked for a great
deal of information, much of which will not change anything about the solution they
receive. Then the completed form is handed to someone else — an AT expert, a program
manager, a maker team — as scattered free text across a few dozen fields, from which they
must reconstruct what the person actually needs. And then someone has to answer the
hardest question of all: does something like this already exist, anywhere, and if not
exactly, is there something close enough to modify?

This summer, as a Siegel PiTech PhD Impact Fellow working with TOM, I built a tool around
those three problems — collection, summarization, and retrieval — because they are three
different problems, and solving only one of them does not help.

## Problem 1: Collection — The Form Asks Too Much and Learns Too Little

A long questionnaire is a reasonable response to uncertainty: nobody knows in advance
which detail will matter, so the form asks for all of them. But the cost of that
uncertainty is paid entirely by the person least positioned to pay it. Fields get skipped,
answered thinly, or abandoned — and the fields that get abandoned are not randomly
distributed. They tend to be the long free-text ones, which is exactly where the useful
information lives.

The tool replaces the form with a conversation. A language model interviews the person and
progressively fills in a structured *Need Profile* behind the scenes: the activity, the
barrier, the desired outcome, plus age, region, who is asking (the person themselves, a
caregiver, a clinician), relevant body function, current devices, environment, must-haves,
must-avoids, and safety concerns.

Two rules do most of the work. First, **a named object is never the need.** "I need an
umbrella for my wheelchair" gets recorded as *moving outdoors in the rain while propelling
a wheelchair, without occupying either hand* — a different search, and a much better one.
Second, **every question has to justify itself**: before asking anything, the model has to
answer whether knowing this would change which solutions it would look for. If the answer
is no — and for many fields, on many needs, it is no — the field is marked not applicable
and the conversation moves on. A form cannot do this, because a form is written once for
everyone. The result is typically a handful of questions instead of dozens, and the ones
that get asked are the ones that matter for that specific need.

The conversation runs in whatever language the person prefers while the profile itself is
stored in English, since everything downstream matches against English-language catalogs.
Both inputs support voice dictation, so the intake does not quietly assume comfortable
typing.

## Problem 2: Summarization — Different Stakeholders Need Different Things From the Same Request

A filled-in form is not a summary. What an AT expert needs from a request is not what a
maker team needs, and neither is what the Need-Knower needs to hear back.

Because the intake produces a structured profile rather than a pile of prose, the tool can
write for each of them. The reviewer sees the need beside every candidate, with what
matched and what did not. At the end, the session exports a summary written twice: once
for the requester, in plain language, saying what was found and what to do next; and once
for the TOM team, with the closest matches, the remaining gaps, the safety risks, the open
questions still worth asking, and a recommended pathway. The same session becomes a
handoff document instead of a transcript someone else has to read from scratch.

## Problem 3: Retrieval — "Relevant" Is Not a Property of a Project

This is the part I underestimated at the start of the summer.

Relevance in assistive technology behaves the way sustainability does. Nothing is
sustainable in the abstract; it depends on where it is, what it replaces, and who is using
it. The same is true here. A one-handed cutting board is an excellent match for one person
and useless for another with a superficially identical request. A 3D-printable design is a
perfect answer in a city with a makerspace and a non-answer three hundred kilometers away.
A well-reviewed commercial product is irrelevant if it does not ship to the user's country.
There is no such thing as a globally "relevant" project — only a project that is or is not
relevant *to this need profile*.

So the tool does not rank by relevance. It searches TOM's own catalog alongside
open-source and DIY platforms (Instructables, Thingiverse, Printables, GitHub, ATMakers,
Makers Making Change) and commercial sources (Amazon, Walmart, Etsy, Enabling Devices),
then evaluates each candidate *against this particular profile* on seven dimensions: need
fit, critical requirements, context fit, access pathway, adaptation feasibility, evidence
quality, and safety and risk — each with a short explanation and the evidence behind it,
plus a location-aware cost estimate.

One rule matters more than the rest: **a hard failure cannot be averaged away.** A
beautifully documented, richly photographed project that fails a must-have cannot be
presented as a strong match. The tool is explicitly told it is not judging a competition —
it is not looking for impressive, it is looking for usable by this person.

### And when nothing fits exactly: what could be modified?

For an organization built around making things, "no exact match" is not the end of the
search — it is the beginning of a different one. The more valuable question is usually:
*is there something close enough to adapt?*

That question is genuinely hard, because adaptability is not visible in a search ranking.
It depends on whether there are modifiable files, CAD models, a bill of materials, a
license that permits it, an attachment approach that can be changed without creating a
safety problem — and on whether the adaptation is a five-minute change or a maker team's
project. So the tool assesses it directly, as its own dimension, and every candidate ends
up with an explicit pathway rather than only a score: *can recommend*, *needs more
information*, *needs adaptation*, *maker team review*, *reference only*, or *possible new
TOM challenge*.

That last label is the one I care about most. When nothing found is good enough, that is a
real result, not a failed search — it means the need should enter TOM's challenge pipeline
as something to build. A search that can say "this does not exist yet, and here is
everything nearby that we checked" is more useful to a maker community than one that
returns ten near-misses and lets someone else work out that they are all wrong.

> *Figure 1: The intake conversation, the evaluated candidate set with per-dimension
> explanations, and the exported review summary.*

## What Feedback Changed

The most useful sessions were the ones where TOM staff ran the tool on real needs and told
me what felt wrong. Three rounds of that changed the design more than my original plan did:

- **"The questions feel generic."** Testing with real openers ("I need a cup holder for my
  wheelchair") turned a vague complaint into a reproducible pattern: the model kept fusing
  two questions into one sentence with *and*, which the person cannot actually answer, and
  it asked *why* something was hard before asking *what* was hard. Naming both patterns
  explicitly, with failing and passing examples, fixed them.
- **"It asks things that don't matter."** This is what produced the relevance test above —
  the rule that a question must be justifiable as changing the search.
- **"It's slow."** Search time was dominated by evaluating each candidate, and cutting that
  meant cutting evaluation quality. The fix was to change what waiting feels like: each
  result now appears the moment its own evaluation resolves, TOM projects first, roughly
  halving time-to-first-result without changing total time at all.

I also set aside a piece of my original proposal — a ranking-conflict mechanism that would
detect when a user's ordering of candidates contradicted their stated criteria and use that
contradiction to surface hidden criteria. Watching real intake sessions convinced me the
earlier bottleneck mattered more: people were not struggling to rank a good candidate set,
they were struggling to produce one at all. That layer is the natural next step now that
the candidate set is worth ranking.

**Shuo Feng**
Ph.D. Student, Information Science, Cornell University

## Impact and Path Forward

By the end of the summer I had a working interface that takes a spoken or typed description
of a daily challenge and returns an evaluated, explained, source-diverse set of candidates
— along with a summary that a Need-Knower and a maker team can each act on, and an explicit
answer when the right thing does not exist yet. The project is documented and handed off
for continued development inside TOM.

The next steps are the ones this version earns rather than assumes: the ranking and
conflict-resolution layer from the original proposal, so that the act of comparing
candidates teaches the tool what a reviewer actually values; a study with TOM design teams
using it on live requests; and closing the loop into TOM's challenge pipeline, so that
"nothing adequate exists" becomes an input to what gets built next.

Underneath all of it is a simple argument. For assistive technology, the accessibility of
*information* is part of accessibility itself — and so is the effort we ask of people
before we give them any. A solution that exists but cannot be found is, for the person who
needs it, a solution that does not exist. And a request that takes forty questions to file
is one that many people will simply never file.

## Acknowledgments

This work was conducted with the TOM (Tikkun Olam Makers) team, whose staff repeatedly
tested the tool against real needs and told me plainly what was not working. I am grateful
for their guidance, and to the Siegel PiTech PhD Impact Fellowship for the opportunity.
