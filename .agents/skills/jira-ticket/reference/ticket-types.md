# Ticket Types, Templates and Worked Examples

Full field guidance and examples for the three ticket types. `SKILL.md` has the short version; read
this when you are actually writing a description.

Source of truth: the team's _Jira Ticket Writing Guide: Types, Templates and Best Practices_. Where
that guide and observed practice on the board differ, the differences are called out below.

## Choosing the type

| Type      | Use when…                                                                               |
| --------- | --------------------------------------------------------------------------------------- |
| **Story** | Describing a new feature or behaviour from a user's perspective                         |
| **Task**  | Describing a concrete piece of technical work (build, configure, investigate, refactor) |
| **Bug**   | Reporting something broken **in production** — see `reference/bug-reporting.md`         |

`Bug` is narrower than it looks: it is only for problems found after release. Problems found during
peer review, IAT or UAT are defects in unfinished work — bounce that ticket back to In Progress
instead of raising a Bug. Read `reference/bug-reporting.md` before raising one.

## The standard acceptance criteria

Every Story and Task carries these three as the **last** bullets of its CoS, below the
task-specific ones:

```markdown
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented
```

They are standard across all tickets, with occasional exceptions. If you believe one genuinely does
not apply, leave it out and say why in `Notes` rather than dropping it silently.

## Who fills in what

This is the distinction that keeps tickets useful. The **writer** describes the problem or the need.
The **engineer** fills in the closing-time sections, before moving the ticket to Peer Review:

| Section                                                       | Filled by          | When                                               |
| ------------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| Story / CoS / Problem / Expected / Steps to replicate / Notes | Writer             | At creation                                        |
| `Resolution`                                                  | Engineer           | Before Peer Review                                 |
| `Pull Requests`                                               | Engineer           | Before Peer Review                                 |
| `UAT Steps`                                                   | Writer or engineer | At creation if known, otherwise before Peer Review |

So when you create a ticket, leave `Resolution` and `Pull Requests` as the italic placeholders. They
are closing-time fields, not an invitation to design the fix up front.

---

## Story

Captures **what a user needs and why**, from their perspective. It is a business specification, so
avoid jargon — non-engineers read these.

### Template

```markdown
As a <actor>,
I want to be able to <desired function/feature>,
so that <explanation of how it will benefit me>.

**Acceptance Criteria:**

- [Task-specific criterion]
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented
```

### Field guidance

- **Actor** — who benefits. Use a role, not a name: "subscriber", "editor", "anonymous visitor".
- **Desired function** — what the user should be able to do. Specific and action-oriented.
- **Benefit** — why it matters to them. A real outcome, not "so that it's better".
- **Acceptance Criteria** — conditions that must be true for the story to be complete. Each one
  independently verifiable. Include edge cases where relevant.

### Example

Summary: `Show introductory offer price and end date on the paywall`

```markdown
As a subscriber,
I want to be able to see the introductory offer price and end date on the paywall,
so that I can make an informed decision before subscribing.

**Acceptance Criteria:**

- The paywall displays the introductory price when one is available from the App Store
- The offer end date is displayed and sourced from the backend config
- When no introductory offer is active, the standard paywall is shown with no changes
- The web paywall is unaffected
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented
```

Note the third and fourth criteria: they pin down what should _not_ change. Those are the ones most
often missed, and the ones that stop a fix breaking something adjacent.

---

## Task

A specific, self-contained piece of work. May or may not be tied to a Story.

### Template

```markdown
**CoS**

- [Functional or non-functional requirement]
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented

**Notes**

- _Reference to Slack conversation, documentation link_

**Resolution:**

_A summary of how the issue raised was addressed_

**UAT Steps:**

1. _Log in as A3x_
2. _…_

**Pull Requests**

- _na-frontend: <link>_
```

### Field guidance

- **CoS** — what "done" looks like. Write each as an observable outcome, not a task for the
  implementer to perform in order. "The resolver returns null when the S3 file is missing", not
  "add a null check to the resolver".
- **Notes** — optional. Slack threads, design docs, external references: context that is not a
  requirement.
- **UAT Steps** — a numbered sequence letting a product owner, QA engineer or stakeholder verify the
  work on staging or production. Be specific: include URLs, user roles, and exact interactions.

### Example

Summary: `Expose subscription offer metadata via a GraphQL query`

```markdown
**CoS**

- Apollo resolver fetches offer metadata from S3 and exposes it via a new GraphQL query
- Results are cached with a 10-minute TTL to avoid hitting S3 on every request
- Resolver returns null gracefully when the S3 file is missing or malformed
- Unit tests with at least 80% coverage
- SonarQube Quality Gates are passing
- Feature changes are sufficiently documented

**Notes**

- Slack thread: <link>
- S3 schema spec: <Confluence link>

**Resolution:**

_A summary of how the issue raised was addressed_

**UAT Steps:**

1. Log in as A3x on staging (https://staging.example.com/)
2. Open the app on a physical iOS device using a fresh sandbox Apple ID
3. Navigate to a paywalled article
4. Confirm the introductory price and offer end date are displayed correctly
5. Confirm the standard paywall appears when no offer is configured

**Pull Requests**

- _na-frontend: <link>_
```

`Resolution` and `Pull Requests` are left as placeholders — the engineer fills them before Peer
Review. `UAT Steps` are written out here because the writer already knew how to verify it.

---

## Bug

Reports something broken in production. Read `reference/bug-reporting.md` first: the type is
narrower than it appears, and Bugs carry extra fields.

### Template

```markdown
**Problem:**

[What is not working. Include environment — browser, device, OS — if relevant.]

**Expected:**

[How it should be working.]

**Steps to replicate:**

1. [Step, starting from a known state]
2. [Step]

**Notes (optional):**

- [Screenshots, error messages, log excerpts, hypotheses]

**Resolution:**

_A summary of how the issue raised was addressed_

**Pull Requests**

- _na-frontend: <link>_
```

The written guide's Bug template has no `UAT Steps` section, unlike Task. In practice many bugs on
the board do carry one; adding it is fine when there is something specific to verify, but it is not
required.

### Field guidance

- **Problem** — what is actually happening. Factual and specific.
- **Expected** — what should happen instead. Keep it short.
- **Steps to replicate** — a sequence that reliably reproduces it, including starting state and any
  required roles or data. If it is intermittent, say so and describe when it tends to occur.
- **Notes** — optional. Screenshots, log excerpts, or a hypothesis about the cause. A hypothesis
  belongs here, flagged as a guess — not in `Resolution`, and not as a prescribed fix.
- **Resolution** — the engineer's closing-time note, briefly describing the root cause and the fix.

### Example

Summary: `Paywall drawer traps keyboard focus on iOS`

```markdown
**Problem:**

On iOS, the paywall drawer traps keyboard focus after opening. Users cannot interact with any
element outside the drawer, including the navigation bar and article content. Reproducible on
iOS 17 (Safari WebView), not observed on Android.

**Expected:**

The drawer should not trap focus. Users should be able to tab to and interact with elements
outside the drawer.

**Steps to replicate:**

1. Open the app on a physical iOS device (iOS 17)
2. Navigate to a paywalled article
3. Let the paywall drawer open automatically
4. Attempt to tap the navigation bar at the top of the screen

**Notes:**

- Possibly the drawer library setting `tabindex="-1"` on the wrapper when `dismissible={false}`
  is used — worth checking first, but unconfirmed.

**Resolution:**

_A summary of how the issue raised was addressed_

**Pull Requests**

- _na-frontend: <link>_
```

134 words including placeholders — about the median for a bug on these boards. The `Notes` hypothesis
is one sentence and explicitly marked unconfirmed. Compare with the counter-example below, where the
same hunch is written up as settled fact plus a patch.

---

## Counter-example: the same bug, written badly

Everything wrong here is something the rules are trying to prevent:

```markdown
## Bug Description

As requested in our conversation above, I investigated the paywall issue that you asked me to look
into. This ticket captures my findings.

## Root Cause

I traced this to `apps/web/src/components/PaywallDrawer.tsx`. Vaul sets `tabindex="-1"` on the
wrapper when `dismissible={false}`, and re-applies it after manual removal. The fix is to attach a
callback ref with a MutationObserver that strips the attribute whenever Vaul re-adds it, then lift
the drawer state into a context provider so it survives navigation. I would also recommend
refactoring the surrounding hook while we are in there, since it mixes presentation and analytics
concerns.

## Steps to Reproduce

1. Open the staging site (see the URL I pasted earlier in the chat)
2. …
```

Five problems:

1. **Markdown headings** instead of bold labels, and `Bug Description` / `Root Cause` /
   `Steps to Reproduce` are not sections these boards use.
2. **References the conversation** — "as requested in our conversation above", "that you asked me
   to", "the URL I pasted earlier in the chat". Whoever picks this up in six months has none of it.
3. **Solutionises.** Root cause, file, library internals, the patch, and an unrelated refactor are
   all the engineer's call. Written as `Notes`, that hunch is one flagged sentence.
4. **Puts the fix in the wrong place.** Even if all of it were correct, root cause and fix belong in
   `Resolution`, written by the engineer at Peer Review time — not in the description at creation.
5. **Meta-commentary.** "This ticket captures my findings" describes the act of writing the ticket
   rather than the bug.
