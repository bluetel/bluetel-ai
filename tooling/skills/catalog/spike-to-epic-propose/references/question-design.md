# Question design

Every question is read by someone who has not seen `fr.md` and does not know what a functional requirement or an ambiguity is. They know the spike, the repositories and the pull requests. Write for them.

## Rules

1. Plain English only. Never use FR IDs, ambiguity IDs, type names, or the words "requirement", "ambiguity" or "FR" in a question or its options. Those live in `fr.md`.
2. Name things the way the user sees them: the spike section heading, the repository name, the PR number, the Confluence page title.
3. One decision per question. An ambiguity that needs two decisions is two questions.
4. Say what is unclear before asking what to do. Two sentences at most: what the spike says, then what goes wrong if it is read the wrong way.
5. Every option's description states its effect on the proposed work: "one piece of work each for the API and the worker", "treated as already built, nothing to do", "dropped from the list". If the effect does not fit in one sentence, the option is not concrete enough to offer.
6. Option labels are about eight words or fewer. The description carries the implication.
7. Two to four options. The last is always "Leave as is" with the description "No change. The work is listed as the spike words it."
8. The header chip is "Spike", the repository name, or the PR number the question is mainly about.
9. No hedging or stacking: no "possibly", no "and also", no "or" inside an option label.
10. Do not tell the user how many questions remain.

## Anatomy of a question

```
header:   Spike
question: The "Next steps" section says to roll rate limiting out to "the remaining services" but never lists them. Read narrowly that is the API and the worker; read widely it also covers the web app and the admin app, which doubles the work. Which services are meant?
options:
  API and worker only  -> One piece of work each for the API and the worker.
  All four services    -> One piece of work each for the API, the worker, the web app and the admin app.
  Leave as is          -> No change. The work is listed as the spike words it.
```

## Examples by type

Examples use a made-up rate limiting spike for a client whose repositories are prefixed `acme-`. Substitute the real headings, repositories and PRs.

**scope**: see Anatomy of a question above.

**choice**

- Do not ask: "A3 (choice): sliding window or token bucket?"
- Ask: "The "Algorithm" section weighs a sliding window against a token bucket and does not pick one. Whoever builds it has to choose, and the two need different Redis data structures. Which should the work assume?"
  - Token bucket -> The limiter work is written for a token bucket, with bucket state kept in Redis.
  - Sliding window -> The limiter work is written for a sliding window, including the sorted-set cleanup job.
  - Leave as is -> No change. The work is listed as the spike words it.

**status**

- Do not ask: "A2 (status): is worker request counting done?"
- Ask: "The "Worker" section says request counting "was partly added" but links no pull request, and nothing in acme-worker shows it. Should it be treated as built or as work to do?"
  - Already built -> Treated as done; nothing is planned for it.
  - Still to do -> Listed as work to do, starting from scratch.
  - Leave as is -> No change. The work is listed as the spike words it.

**conflict**

- Do not ask: "A4 (conflict): spike vs PR #65 on the cron job."
- Ask: "The "Considerations" section says the quota reset cron job must stay disabled, but acme-worker PR #65 enables it and is deployed to staging. One of them is out of date. Which is right?"
  - The PR is right, keep it enabled -> The cron job is treated as enabled and the spike's note is ignored.
  - The spike is right, disable it -> One piece of work to disable the cron job again.
  - Leave as is -> No change. The work is listed as the spike words it.
