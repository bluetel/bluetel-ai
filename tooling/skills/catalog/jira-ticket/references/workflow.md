# Board Workflow, Fields and Estimation

Context for where a ticket sits and what else it needs. `SKILL.md` covers creating one; this covers
the process around it.

## Fields to set when creating

| Field                    | Guidance                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| **Summary**              | Short, specific statement. See below.                                                          |
| **Description**          | CoS or problem statement, useful links, context, screenshots                                   |
| **Priority**             | Usually leave `Neutral`; raise only for genuine urgency. Set it in the UI, not via the script. |
| **Labels**               | Any that help categorise. Optional.                                                            |
| **Parent (Epic)**        | **Always set one.** Tickets without an epic get lost on the board.                             |
| **Story Point Estimate** | Days from starting work to reaching UAT. See the scale below.                                  |
| **Linked Issues**        | Use Jira's link feature for related tickets — never paste ticket ids into the description      |

## Story point scale

Estimate the whole path from picking the ticket up to getting it into UAT — including documentation,
writing tests, and roughly two rounds of PR and IAT feedback.

| Points | Meaning              |
| ------ | -------------------- |
| 0.5    | Less than half a day |
| 1      | Up to a day          |
| 2      | 1–2 days             |
| 3      | 2–3 days             |
| 4      | 3–4 days             |
| 5      | A working week       |

**Aim for tickets that can be completed in under 2 days.** If the requirement is bigger, split it
into multiple workable tickets even if they depend on each other.

## Where a new ticket lands

By default a created ticket goes to the **bottom of the backlog**, and the team is notified so it can
be refined — a quick discussion to assert the ticket "makes sense" — before it moves to Ready and
onto a board.

`jira-issue.mjs` follows this by default. Repos that would rather drop new tickets straight into the
active sprint can set:

```bash
sh lib/skills.sh config set 'jira_create_into=sprint'
```

Or override per invocation with `--sprint` / `--no-sprint`.

## Board states

| State                | Meaning                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Backlog**          | Where new tickets land. Needs all details, and usually refinement, before progressing                       |
| **Ready**            | Can be worked on. Assign yourself when you start                                                            |
| **In Progress**      | Being worked on. Moves to Peer Review once the CoS or A/C are addressed                                     |
| **Blocked**          | Cannot proceed. Document why in the ticket's comments; prioritise unblocking over new work                  |
| **Peer Review**      | PR review plus testing the change. Failing tests or a failing CI check send it back to In Progress          |
| **IAT**              | Internal acceptance testing on staging, by an engineer who has not worked on or reviewed it. No code review |
| **UAT**              | Client or stakeholder verification against business requirements                                            |
| **Awaiting Release** | Verified, waiting on a production deploy                                                                    |
| **Done**             | Released and closed                                                                                         |

`Resolution` and `Pull Requests` must be filled in **before** moving a ticket to Peer Review.

### Release timing

Never release on a Friday, the day before a bank holiday or company closure, or the last day of the
working week — unless the client explicitly asks, aware of the risk. Some clients want a specific
time slot, so ask in advance.

## Writing the summary

- A short, specific statement, not a vague label. "Paywall does not display intro offer price on
  iOS" beats "Paywall bug".
- Describe the symptom or the need, not the fix.
- Max ~80 characters.

## One ticket, one concern

If you find yourself writing "and also", consider splitting the ticket.

Related: while it is good to leave code cleaner than you found it, don't spend more than 15 minutes
refactoring something that is not part of the ticket. Raise a Tech Debt ticket and discuss it with
the team instead.

## Audience

Stories and Bugs are read by non-engineers. Keep jargon out of the description; technical detail
belongs in `Notes` or in `Resolution`.
