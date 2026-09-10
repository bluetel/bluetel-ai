# Writing guide

How every summary and description under `plan/` is written. This is the jira-ticket skill's writing process, extracted for a stage that drafts tickets without creating them, plus the correction pass for tickets that already exist. Read it before each ticket.

## Contents

- Sources and precedence
- Project conventions from Jira
- Process per ticket
- Rules from the jira-ticket skill
- Standard acceptance criteria
- Links and pull requests
- Correction pass for existing tickets
- Language for a technical reader
- No em dashes

## Sources and precedence

Lowest to highest. A higher source wins where two disagree. A source that says nothing about a section defers to the next one down.

1. The jira-ticket skill: `references/ticket-types.md` (templates, field guidance, worked examples) and `references/workflow.md` (fields, story point scale, summary style). Installed under `.agents/skills/jira-ticket/references/`; in the source repo under `tooling/skills/catalog/jira-ticket/references/`. The fallback when nothing above it gives a shape.
2. The project's standing instructions in `.agents/jira-ticket-context.md`, when it says more than "No custom instructions yet."
3. The project's conventions read from Jira: its own issue template when it exposes one, otherwise the shape of its recent tickets and epics. See Project conventions from Jira. Queried before any reference template is opened for writing.
4. The client's guide: the page titled "Jira Ticket Writing Guide" in the spike's Confluence space, when one exists. It describes the boards the tickets land on.
5. The sibling tickets in `current/tickets/`, for the sections they actually have: their summary pattern and section labels show what the board uses. A section every sibling lacks comes from source 4, then 3.

## Project conventions from Jira

Read-only. Only search and get operations run; nothing is created, updated, linked or transitioned. Done in Phase 1 on every run, with or without sibling tickets: a new epic has no siblings, and a mirrored ticket often lacks a section.

1. Project: the key resolved in Phase 0, which is the epic's project whenever there is an epic.
2. Template: ask the MCP `discover` tool for an operation that returns the project's issue templates, or its create metadata for the Task, Story and Epic types, and run it with `executeRead` only. Record any description template or default description it returns, per type. Most projects expose none; that is the normal result, not a failure.
3. Sample: for each type step 2 left without a template, search `project = <KEY> AND issuetype = <type> AND description is not EMPTY ORDER BY created DESC`, at most 10 issues for Task and for Story and 3 for Epic, and read each with its full description. Skip an issue whose description is under three lines. From the rest record what a majority share: the bold section labels and their order, the summary pattern (prefix, separator, case), the closing criteria that recur, and the placeholder lines the template leaves in place.
4. Record the result in the Project conventions table of plan.md, one row per type, with the keys read so a reviewer can check them. Fewer than three usable issues of a type is `none` for that type.
5. Apply it: a new ticket takes its section labels, order and summary pattern from here unless a higher source overrides. A mirrored ticket keeps every section it has and gains, in the recorded order, any section the project's tickets have and it lacks.

## Process per ticket

1. Type: Task for technical work; Story when the FR is behaviour from a user's perspective. Never Bug for spike work.
2. Summary: short, specific, the need rather than the fix, 80 characters at most. Follow the siblings' pattern inside an existing epic, else the project's.
3. Open the template for the type and write the description into it. Keep the section labels exactly as the template has them: bold paragraphs, not headings.
4. CoS or acceptance criteria: one bullet per observable outcome the ticket's FRs require. "The resolver returns null when the S3 file is missing", not "add a null check". No adjective that cannot be checked ("fast", "clean", "robust"): give the number or the observable behaviour. When an FR touches something adjacent, add a bullet for what must not change.
5. Notes: context that is not a requirement. The spike, design pages, dashboards, a merged PR that did related work, a hunch marked as one.
6. Resolution and UAT Steps: the template's placeholders, always. They are closing-time fields.
7. Pull Requests: see Links and pull requests.
8. Read the description once more as the developer who picks it up in six months with no access to this pipeline. Cut anything that only makes sense here.

## Rules from the jira-ticket skill

- Write the problem or the need, not the solution. No root cause, no file to change, no patch. A useful lead is one sentence in Notes marked as a hunch.
- Never reference the conversation or the pipeline: not fr.md, FR IDs, findings, decisions, the spike-to-epic folder, or "as discussed". The ticket reads as if a colleague wrote it from scratch.
- No meta commentary: "This ticket captures", "Below is a summary of".
- Keep it short: about 110 words of description, 250 as a hard ceiling. Code blocks, link lists and tables do not count. A mirrored ticket is never cut to fit; a Review note says it is over.
- One ticket, one concern. Writing "and also" means splitting.
- Bullets with `-`, numbered lists for ordered steps, backticks for identifiers, paths and values. Bare URLs become links.
- Related tickets are joined with Jira issue links, never by pasting keys into the description.
- Stories are read by non-engineers: jargon goes in Notes.
- The description is markdown that the script converts to ADF. Do not hand-write ADF, do not wrap the description in a code fence, and separate paragraphs with a blank line.

## Standard acceptance criteria

The last bullets of every CoS or acceptance criteria list, below the task-specific ones. The shared baseline:

- Unit tests with at least 80% coverage
- Feature changes are sufficiently documented

The client guide, the project's sampled tickets or the project file may add to or reword these, for example a code quality gate criterion. Use the highest source's list. A criterion that genuinely does not apply, such as unit tests on an infrastructure-only change, is left out and Notes says why.

## Links and pull requests

- Notes opens with the spike: `- Spike: <confluence url>`.
- Links under the spike headings the ticket's FRs cite are carried into Notes when a developer needs them: dashboards, design pages, repositories, vendor documentation. One line each: a two or three word label, then the URL. Links elsewhere on the spike are not carried.
- Absolute URLs only. Fetch rewrote links to local paths such as `../prs/acme-worker-65.md`; restore the original from that document's Source URL. A reference to another ticket becomes an issue link in the header, not text in the description.
- An OPEN PR whose work the ticket continues is the base for the work: the description opens with one line naming it, such as "Based on the work in acme-worker PR #65; extend that branch rather than starting again", and Pull Requests lists it as `- <repo>: <url>`. An FR with status `partial` and that PR as Evidence means base.
- A MERGED PR that did part of the work is done context in Notes: `- Done in acme-base-images PR #17: <url>`. The CoS does not ask for that work again.
- No known PR: Pull Requests keeps one placeholder line in the template's form and nothing else. No "etc." lines.

## Correction pass for existing tickets

Applied to every mirrored ticket after the decisions. The aim is a ticket that reads cleanly to a technical reader with its meaning untouched.

Fix:

- spelling, matching the variant the existing tickets use ("Managment" to "Management"; "Optimise" stays, the board writes British English)
- capitalisation mid-sentence ("the service Must retry", "Measure the latency")
- punctuation: missing full stops, run-on sentences split in two, doubled words ("do do")
- template residue: "etc..", `<link>` where the link is known, empty sections the template does not have
- a heading written as a sentence ("This should be based on the work in:") becomes the template's structure with the content kept

Keep:

- technical terms, product names, identifiers, environment names, quoted values, code blocks and URLs, character for character
- the author's structure and the order of bullets
- any sentence whose meaning would change under a rewrite; leave it and add a Review note

Every change is one line in the ticket's Changes section: `- CoS bullet 2: "Measure" to "measure"; full stop added`.

## Language for a technical reader

The reader is a developer who knows the stack. Write for them.

- Concrete nouns and numbers: the service, the repository, the config key, the threshold.
- Short declarative sentences. One idea per sentence.
- British English unless the existing tickets use American.
- No filler openers: "Additionally", "Furthermore", "Moreover", "It is worth noting", "Please note". "In order to" is "to".
- No inflated words: "leverage", "utilise", "streamline", "seamless", "robust", "comprehensive", "holistic", "cutting-edge", "delve", "empower", "elevate", "enhance" when "improve" or the specific change will do.
- No hedging stacks: "may potentially", "could possibly".
- No rhetorical questions, exclamation marks, emoji, closing summaries, or sentences that restate the label above them.
- No triads for rhythm ("fast, reliable and scalable") unless all three are requirements.
- "Ensure" only when asserting a condition, never as a stand-in for "do".
- Hyphenate compound modifiers ("rate-limited endpoint"). Keep parentheses rare.

## No em dashes

No em dash (U+2014), and no en dash used as one, appears in any summary, description, or anywhere else under `plan/`. Replace it with a comma, a colon, a full stop and a new sentence, or parentheses. The self-check greps for it and fails on a single hit. A spaced hyphen between words ("Rate Limiting - API Gateway Rollout") is fine when it matches the board's existing summaries.

## Further reading

- Atlassian, "How to write a useful Jira ticket": https://community.atlassian.com/forums/Jira-articles/How-to-write-a-useful-Jira-ticket/ba-p/2147004
- The client's own guide, when its space has one, is the page titled "Jira Ticket Writing Guide". It wins over the shared templates and the project sample.
