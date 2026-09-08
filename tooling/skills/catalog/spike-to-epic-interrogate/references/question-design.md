# Question design

Every question is read by someone who has not seen `fr.md` and does not know what a functional requirement or a finding is. They know the Jira tickets, the spike, and the pull requests. Write for them.

## Contents

- Rules
- Anatomy of a question
- Examples by category

## Rules

1. Plain English only. Never use FR IDs, finding IDs, category names, severities, wave numbers, or the words "requirement", "finding" or "FR" in a question or its options. Those live in `fr.md`.
2. Name things the way the user sees them: ticket key plus its summary ("ABC-104 API Gateway Rollout"), the spike section heading, the repository and PR number.
3. One decision per question. A finding that needs two decisions is two questions.
4. Say what is wrong before asking what to do. Two sentences at most: the situation, then what goes wrong if nothing changes.
5. Every option's description states its effect in ticket terms: "creates one new ticket under ABC-100", "moves this bullet from ABC-101 to ABC-103", "adds an 'is blocked by ABC-102' link". If the effect does not fit in one sentence, the option is not concrete enough to offer.
6. Option labels are about eight words or fewer. The description carries the implication.
7. Two to four options. The last is always "Leave as is" with the description "No change. Recorded as accepted."
8. The header chip is the ticket key the question is mainly about, or "New ticket", or "Spike".
9. No hedging or stacking: no "possibly", no "and also", no "or" inside an option label.
10. Do not tell the user how many questions remain or which wave this is.

## Anatomy of a question

```
header:   ABC-103
question: ABC-101 (productionise infrastructure) tells the developer to make sure the worker only applies a limit when the request carries an API key header. That rule is about worker code, which ABC-103 (worker limits) owns, so whoever picks up ABC-101 may skip it or duplicate it. Where should it live?
options:
  Move it to ABC-103        -> Removes the bullet from ABC-101 and adds it to ABC-103.
  Keep it in both tickets   -> Leaves ABC-101 unchanged and adds the same bullet to ABC-103.
  Leave as is               -> No change. Recorded as accepted.
```

## Examples by category

Examples use a made-up epic, ABC-100 Rate Limiting, with tickets ABC-101 to ABC-105 and repositories prefixed `acme-`. Substitute the real keys, summaries and PRs.

**coverage-gap**

- Do not ask: "FR-07 (quota dashboard) has no ticket. Create one?"
- Ask: "The spike's next steps include showing each client's quota usage on the admin dashboard so support can see who is being throttled. No ticket in the epic covers this, so nobody will pick it up. What should happen?"
  - Create a ticket for the quota dashboard -> Creates one new child ticket under ABC-100 scoped to this work.
  - Add it to ABC-104 API Gateway Rollout -> Extends ABC-104 with this work; that ticket is already the largest in the epic.
  - Leave as is -> No change. Recorded as an accepted gap.

**duplicate-coverage**

- Do not ask: "FR-03 appears in ABC-101 and ABC-103; drop from which?"
- Ask: "Both ABC-101 (productionise infrastructure) and ABC-103 (worker limits) ask for the quota reset cron job to be enabled. Two developers could do the same work, or each assume the other did it. Which ticket should own it?"
  - ABC-103 owns it -> Removes the bullet from ABC-101.
  - ABC-101 owns it -> Removes the bullet from ABC-103.
  - Leave as is -> No change. Recorded as accepted.

**misplaced-criterion**

- See Anatomy of a question above.

**contradiction**

- Do not ask: "D1: ABC-101 and ABC-103 contradict on the cron job."
- Ask: "ABC-101 says do not migrate the quota reset cron job, while ABC-103 says to enable it. Done in the order shown, the first developer disables what the second is about to rely on. Which is right?"
  - ABC-101 leaves it disabled, ABC-103 enables it -> Rewords ABC-101 to "leave disabled", keeps ABC-103 as is, and adds an "is blocked by ABC-101" link to ABC-103.
  - Drop the cron work from ABC-101 -> Removes that sentence from ABC-101; ABC-103 is unchanged.
  - Leave as is -> No change. Recorded as accepted.

**ordering**

- Do not ask: "E2: ABC-104 depends on ABC-102 without a link."
- Ask: "ABC-104 (API gateway rollout) pulls secrets that ABC-102 (secrets management) creates, but nothing in Jira says ABC-102 must finish first. If both land in one sprint, the gateway work stalls. Add the dependency?"
  - Mark ABC-104 as blocked by ABC-102 -> Adds the issue link. No wording changes.
  - Leave as is -> No change. Recorded as accepted.

**status-drift**

- Do not ask: "F1: ABC-105 re-implements a done FR."
- Ask: "ABC-105 (admin rollout) asks for the Redis client to be added to the base image, but acme-base-images PR #17 already merged that. A developer following the ticket would redo finished work. What should the ticket say?"
  - Drop the bullet and link PR #17 -> Removes the bullet from ABC-105 and links the merged PR.
  - Keep it as a check, link PR #17 -> Rewords the bullet as "verify the client from PR #17 is present" and links the PR.
  - Leave as is -> No change. Recorded as accepted.

**oversized**

- Do not ask: "O1: ABC-101 maps to FRs from 3 headings; split?"
- Ask: "ABC-101 (productionise infrastructure) covers moving the limiter's container build to the registry, right-sizing its node, refactoring the infrastructure module, and changing network access rules. That is four deliverables under one ticket, so it cannot be estimated or reviewed as one change. How should it be split?"
  - Two tickets: hosting, then access -> ABC-101 keeps the build, node sizing and the module refactor; one new ticket takes the firewall and IP allow-list changes.
  - Three tickets: builds, hosting, access -> New tickets for the build pipeline and for access; ABC-101 keeps node sizing and the module refactor.
  - Leave as is -> No change. Recorded as accepted.
