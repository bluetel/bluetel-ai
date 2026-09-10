# result.md template

Write `spike-to-epic/<KEY>/implement/result.md` with exactly these sections in this order. Pipe tables only. Empty sections keep their heading and a single line "none". Write it as the run goes: a Steps row is added when a step starts and updated when it ends, so a re-run resumes from the first row that is not `done`.

Vocabularies are closed:

- Step Status: `started` | `done` | `failed`
- Duplicate answer: `none found` | `continue` | `stop`

Example values use a made-up project `ABC` and a rate limiting epic.

```markdown
# Implement - <KEY>

- **Plan:** [../plan/plan.md](../plan/plan.md)
- **Project:** <key> | **Site:** <jira site>
- **Started:** <YYYY-MM-DD HH:MM> | **Finished:** <YYYY-MM-DD HH:MM, or blank while running>

## Duplicate check

Answer: none found | continue | stop

| Candidate | Summary                            | Type | Status      | Resembles                |
| --------- | ---------------------------------- | ---- | ----------- | ------------------------ |
| ABC-90    | Throttling: shared limiter service | Epic | In Progress | new-epic "Rate Limiting" |

## Keys

| Placeholder | Key     |
| ----------- | ------- |
| new-epic    | ABC-200 |
| new-01      | ABC-201 |

## Steps

| Step | Kind          | Target   | Key     | Status | URL                           | Note                                   |
| ---- | ------------- | -------- | ------- | ------ | ----------------------------- | -------------------------------------- |
| 1    | create epic   | new-epic | ABC-200 | done   | https://<site>/browse/ABC-200 |                                        |
| 2    | create ticket | new-01   | ABC-201 | done   | https://<site>/browse/ABC-201 |                                        |
| 3    | update ticket | ABC-103  | ABC-103 | failed |                               | editJiraIssue: 403, no edit permission |

## Links

### Created

- ABC-200 Rate Limiting (epic): https://<site>/browse/ABC-200
- ABC-201 Rate Limiting - Quota Dashboard: https://<site>/browse/ABC-201

### Updated

- ABC-103 Rate Limiting - Worker Limits: https://<site>/browse/ABC-103

### Issue links and sprint moves

- ABC-201 is blocked by ABC-104
- ABC-201 moved to the active sprint
```

Notes:

- Step numbers are the plan's step numbers, so a row in result.md points straight at its row in plan.md.
- The Links section is written in Phase 3 from the Steps table and is what the final message prints.
- When the duplicate answer is `stop`, the Steps table reads "none" and Finished is set.
