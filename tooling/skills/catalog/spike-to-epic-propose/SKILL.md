---
name: spike-to-epic-propose
description: "Proposes functional requirements from a fetched Confluence spike that has no Jira epic: one requirement per buildable outcome in the spike's next steps and pull requests, optional research of the client's GitHub repositories and same-space Confluence pages for what already exists, and a question round for every ambiguity, recorded in spike-to-epic/<KEY>/propose/fr.md for /spike-to-epic-plan. Use when: /spike-to-epic-fetch has run without an epic key and tickets need proposing from the spike."
argument-hint: '[KEY] [research] (KEY optional when only one folder exists under spike-to-epic/; add research to search GitHub and Confluence for what already exists)'
disable-model-invocation: true
allowed-tools: mcp__atlassian, mcp__rovo, AskUserQuestion, Agent, Read, Glob, Grep, TodoWrite, Write(spike-to-epic/*/propose/**), Edit(spike-to-epic/*/propose/**), Bash(find spike-to-epic:*), Bash(gh auth status:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(gh search code:*), Bash(gh api:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git status:*)
---

# Spike to Epic: Propose

Read-only against remote systems: never modify Jira, Confluence or GitHub. Never edit anything under `current/`; the only files you write are under `spike-to-epic/<KEY>/propose/`. Angle brackets in paths are placeholders.

## When to Use

Second stage of the pipeline: fetch -> interrogate or propose -> plan -> implement. Propose is the sister of `/spike-to-epic-interrogate`: interrogate checks an epic's existing tickets against the spike, propose writes the requirements for a spike that has no epic yet. It answers one question: what does the spike ask to be built, what of that already exists, and what did the user decide where the spike is unclear? Everything lands in `propose/fr.md` for `/spike-to-epic-plan`, which turns requirements into tickets.

## Arguments

`$ARGUMENTS` is `[KEY] [research]`, in any order.

- `<KEY>` is the folder under `spike-to-epic/`. When absent, list `spike-to-epic/*/current/spike.md`; exactly one match selects that key, otherwise ask with `AskUserQuestion`.
- `research` turns on Phase 3. Without it, Phase 3 is skipped and requirements rest on the spike and its pull requests alone.

## Inputs and output

Inputs, all under `spike-to-epic/<KEY>/current/`: `manifest.md`, `spike.md`, `prs/`. Read the manifest first; it maps spike headings to PRs and lists PR Jira keys. Only the metadata header of each document is fixed by fetch; the spike body is verbatim Confluence text with no guaranteed structure.

Output: `spike-to-epic/<KEY>/propose/fr.md`, in the exact structure of [references/fr-template.md](references/fr-template.md). Its Requirements table has the same columns as interrogate's, so plan reads one shape from either stage. Subagent prompts come from [references/pr-verification-subagent.md](references/pr-verification-subagent.md) and [references/research-subagent.md](references/research-subagent.md). Question wording rules and worked examples are in [references/question-design.md](references/question-design.md).

## Progress checklist

Copy this into your first response and tick items as you go:

```
Propose progress:
- [ ] Phase 0: prerequisites
- [ ] Phase 1: requirement extraction
- [ ] Phase 2: PR verification
- [ ] Phase 3: research (only with `research`)
- [ ] Phase 4: ambiguities and questions
- [ ] Phase 5: final requirements and self-check
```

## Phase 0: Prerequisites

If any check fails, reply with the missing precondition and halt.

- `<KEY>` resolves to exactly one folder.
- `current/manifest.md` and `current/spike.md` exist. A missing manifest means the fetch predates this version: ask the user to remove the folder and re-run `/spike-to-epic-fetch`.
- `current/epic.md` does not exist. If it does, the spike already has an epic and tickets: point the user at `/spike-to-epic-interrogate <KEY>` and halt.
- `propose/fr.md` does not exist. If it does, ask the user to remove it first. Never delete anything yourself.
- When the manifest lists any PR, or `research` was given: `gh auth status` reports a logged-in account. With `research`: the Atlassian MCP server is available.

**Direction check.** Read `spike.md` and look for next steps: a section such as "Next steps", "To do", "Recommendations", "Proposed solution" or "Implementation plan", or an ordered list of work to be done. Judge by content, not heading wording: a list of things to build counts, a list of findings does not. When the spike has next steps, do not ask anything; continue to Phase 1. When it has none, reply that the spike has no directional next steps for implementation and cannot be proposed from as written, then ask once:

```
header:   Spike
question: "<spike title>" has no next steps or to-dos, so nothing in it says what should be built. Can we assume nothing from it has been implemented yet and treat the whole document as the work to do?
options:
  Yes, nothing is built yet -> Every proposal, option and recommendation in the document becomes work to do. Pull requests on the spike still count as evidence.
  No, stop here             -> Halt. Add next steps to the spike and re-run.
```

## Phase 1: Requirement extraction

Read `spike.md`, the PR descriptions, and the manifest. Write the Summary, Requirements and Ambiguities sections of `fr.md`. The Requirements table is a draft until Phase 5.

- One FR per discrete, buildable outcome. Be exhaustive and pedantic: an "in order of precedence" list of ten next steps is ten FRs, and a PR description's "needs significant improvement" list is one FR per bullet.
- Sources, in priority order: the spike's next steps or equivalent, its solution sections, its "Further optimisations" and "Considerations", then PR descriptions. When the direction check settled that the whole document is the work to do, every proposal, option and recommendation in it is a source. Every FR cites `file#heading`.
- Status uses exactly one of `done`, `partial`, `todo`, `deferred`, assigned by the rubric below. Evidence names the PR file and, for done or partial, the changed files or diff hunks that show it. Leave Ticket(s) blank; plan fills it.
- Record every ambiguity you meet in the Ambiguities table with a stable ID (`A1`, `A2`...) and one of the types below. Do not resolve or ask yet.

**Status rubric:**

| Status     | Assign when                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`     | A MERGED PR implements it, the spike states it is complete in production, or Phase 3 finds it on a repository's default branch                                         |
| `partial`  | An OPEN PR implements some or all of it, including PRs the spike marks deployed to staging or sandbox, or Phase 3 finds part of it. A prototype is partial, never done |
| `todo`     | No PR or repository code touches it                                                                                                                                    |
| `deferred` | No PR touches it and the spike itself marks it low priority, "possibly", future, or out of this round                                                                  |

**Ambiguity types:**

| Type       | Record when                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `scope`    | The boundary of a next step is not stated: "roll out to the remaining services" without saying which |
| `choice`   | The spike offers alternatives without choosing: "either X or Y", "A, or possibly B"                  |
| `status`   | It is unclear whether something already exists: "we have started on", "was partly done", with no PR  |
| `conflict` | Two parts of the spike, or the spike and a PR, require different things                              |

## Phase 2: PR verification

Skip when no FR cites a PR. Status for `partial` FRs must rest on the diff, not on the PR description. Spawn one subagent per PR that has at least one FR pointing at it, passing every FR for that PR in one prompt built from references/pr-verification-subagent.md. Apply the verdicts as that file's table says. Never verify diffs in the main context; infrastructure PRs run to thousands of lines.

## Phase 3: Research (only with `research`)

Without the `research` argument, skip this phase and write "not run" under Research in `fr.md`. Research finds what already exists in the client's code and settles ambiguities from Confluence before anything is asked of the user. Read-only throughout.

**Repositories.** Build the candidate list and write the Repositories table:

1. Every GitHub repository linked on the spike: the repositories of its PRs (PR headers, Repository field) and any other `github.com/<owner>/<repo>` URL in `spike.md`.
2. Every Confluence page linked from `spike.md` that lives in the spike's own space (Space field in the spike header). Read each and collect the repositories it names, by URL or by name.
3. The client's convention is whatever the step 1 repositories share: the owner, and a name prefix such as `acme-`. Keep a repository that matches either. Ignore one that obviously is not this client's: a different owner with no shared prefix, or a third-party project the page merely cites, such as an open-source library. Record every ignored repository and the reason.

**Terms.** For each `todo` and `partial` FR, and each FR with a `status` ambiguity, list the concrete nouns a developer would grep for: service, module and file names, config keys, environment variables, feature flags, library names. Skip generic words.

**Search.** Spawn one subagent per kept repository with a prompt built from references/research-subagent.md, passing every term with its FR. Subagents search with `gh search code`, read hits with `gh api`, and return one finding per term (`present`, `partial`, `absent`) with file paths, plus anything the code raises: a term found in two unrelated places, a flag that exists but is off, a service named differently from the spike.

**Apply.** Write the Findings table under Research and apply findings as research-subagent.md says. Add everything the subagents raised to the Ambiguities table.

**Clarify from Confluence.** For every open ambiguity, search Confluence restricted to the spike's space (CQL `space = "<SPACE-KEY>" AND text ~ "<term>"`) and read the matching pages. Never search other spaces. Where a page settles it, write the answer and page URL in Resolved by and Decision. Where it does not, leave it open for Phase 4.

## Phase 4: Ambiguities and questions

Every ambiguity still open is asked, because each changes what a requirement says or whether it is already done. Read references/question-design.md first: questions are plain English about the spike, its sections, repositories and PRs, and never mention FR IDs, ambiguity IDs or types.

Order by the spike's own precedence (an ambiguity in the first next step comes before one in the sixth), then by ID. Write the Question plan table in `fr.md` with every question in its final wording before asking any. Then ask with `AskUserQuestion`, at most four questions per call. After each call, write the answers into the Questions and answers section and the Decision column before the next call, so an interrupted run loses nothing.

When no ambiguity is open, write "none" under Question plan and say so in the final summary.

## Phase 5: Final requirements and self-check

Apply every decision to the Requirements table: reword, split, add or drop FRs and set statuses. New FRs take the next number. A dropped FR is deleted and its number is not reused; the Questions and answers section already records why.

Then run this self-check, fix every failure, and repeat until clean. Record the result in the Self-check section.

```
Self-check:
- [ ] every FR has a Source of the form file#heading
- [ ] every FR marked done or partial has Evidence naming a PR file, a repository file, or the spike statement
- [ ] every partial FR that cites a PR has a subagent verdict recorded
- [ ] every ambiguity has a Resolved by and a Decision
- [ ] every question in the plan appears verbatim in Questions and answers with its answer
- [ ] no two FRs describe the same outcome in different words
- [ ] Ticket(s) is blank in every row
```

Finish with a short summary: FR counts by status, ambiguities by type and how each was settled (research, Confluence, question), and whether research ran. Suggest `/compact`, then `/spike-to-epic-plan <KEY>`. Then stop.
