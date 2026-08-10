# Contract: `admin.profiles.setEnabled` after the reachability removal

**Feature**: `specs/004-remove-reachability-gate` | **Date**: 2026-08-09

Amends the `profiles` row of `specs/002-sisyphus-workflow-platform/contracts/api-surface.md`. Everything not
stated here is unchanged.

## Surface

| Procedure                   | Access | Change                                                    |
| --------------------------- | ------ | --------------------------------------------------------- |
| `admin.profiles.setEnabled` | admin  | Gate narrows; no other input, output or error-code change |

Input and output schemas are **unchanged**. The mutation still takes the profile id and the desired state, and
still answers with the profile plus the check verdict.

## Behaviour

### `setEnabled(false)` — unconditional

Never runs the gate. An administrator must always be able to take a profile out of circulation, including one
that could not currently be enabled. Returns the profile with `check: undefined`.

### `setEnabled(true)` — five local checks, no outbound call

The gate makes **no network call of any kind**. It reads the profile's current version, the bundle and
workspace versions that version pins, and that workspace version's entries — then judges them as a pure
function.

| #   | Condition                                                 | Element             | Refusal names                                 |
| --- | --------------------------------------------------------- | ------------------- | --------------------------------------------- |
| 1   | Profile has no published version                          | `profile_version`   | That there is no configuration to validate    |
| 2   | Pinned bundle version or workspace version cannot be read | `profile_version`   | That the pinned rows could not be read        |
| 3   | Pinned setup bundle is archived                           | `setup_bundle`      | The bundle name and version                   |
| 3'  | Pinned setup bundle is disabled (and not archived)        | `setup_bundle`      | The bundle name and version, and to enable it |
| 4   | Pinned workspace is archived                              | `workspace_version` | The workspace name                            |
| 5   | Pinned workspace version holds no entries                 | `workspace_version` | The workspace name and version                |

**Rules that survive verbatim:**

- **Archived beats disabled.** Conditions 3 and 3' are mutually exclusive for one bundle — an archived bundle
  is always disabled too, and reporting both would state one problem twice.
- **Empty workspace short-circuits.** When condition 5 fires, no per-entry reporting follows. (Previously this
  mattered because it suppressed "0 entries unreachable"; it remains because there is nothing further to say.)
- **Every failure, every time.** All applicable conditions are evaluated and reported together.
- **Already enabled and still passing** returns the profile and the verdict, writing nothing and recording no
  second audit entry.
- **A refusal writes nothing.** `CONFLICT`, thrown inside the transaction before any update.

### Removed behaviour

| Was                                                                       | Now                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Each workspace entry probed for repository + branch reachability          | Not checked. Entries are read only to count them        |
| Element `workspace_entry` on the failure list                             | No longer emitted; removed from the closed set          |
| Refusal `workspace entry N (<repo> on <branch>) is unreachable: <reason>` | Never produced                                          |
| A deployment could supply a probe via `SisyphusDependencies`              | The field does not exist                                |
| Default refused every enable when no probe was wired                      | There is no probe and no default; enables are permitted |

## Error contract

`TRPCError` with code `CONFLICT` and a message in the unchanged list format:

```text
This execution profile cannot be enabled yet:
- the setup bundle Payments toolchain (version 3) is disabled; enable it before enabling this profile
- version 4 of the workspace Payments contains no repositories, so a run launched from this profile would have nothing to check out
```

`CONFLICT` rather than `FORBIDDEN` or `BAD_REQUEST`: the caller is entitled to enable profiles and the request
is well-formed — what is wrong is the state of what it points at.

## Panel contract

`describeEnableRefusal` splits the message into one notice per line, each carrying a machine code and a next
action.

| Code                                 | Status                             |
| ------------------------------------ | ---------------------------------- |
| `E_PROFILE_ENABLE_PROFILE_VERSION`   | Unchanged                          |
| `E_PROFILE_ENABLE_SETUP_BUNDLE`      | Unchanged                          |
| `E_PROFILE_ENABLE_WORKSPACE_VERSION` | Unchanged                          |
| `E_PROFILE_ENABLE_WORKSPACE_ENTRY`   | **Removed** — no longer producible |
| `E_PROFILE_ENABLE_UNCLASSIFIED`      | Retained — the graceful fallback   |
| `E_PROFILE_ENABLE_REFUSED`           | Unchanged whole-request refusal    |

The classifier remains a _narrowing_: a line matching no known phrasing becomes `unclassified` and still
carries its own text, a code and an action. No refusal line is ever dropped.

## What the platform no longer claims

The gate does not verify that a repository exists, that a branch exists, or that any credential can read
either. A profile naming a nonexistent repository **enables successfully**. That configuration fails at
bootstrap phase 6 (`entry_checkout`), which names the entry, the repository, the branch and git's own error,
starts no agent, and leaves no partial workspace behind — see
`specs/002-sisyphus-workflow-platform/contracts/executor-protocol.md` and FR-112.
