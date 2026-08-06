# Contract: Setup Bundle

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

A setup bundle turns a bare instance into a worker able to do one client's work. It is authored **outside**
Sisyphus by a platform administrator and uploaded (FR-083, FR-167).

## Archive format

A **gzipped tar archive** with an executable `setup.sh` at the archive root. Supporting files may sit alongside
it.

```
bundle.tar.gz
├── setup.sh          # required, at root, mode 0755
├── credentials/      # optional, whatever setup.sh needs
└── ...
```

**Rejected at bootstrap** (each fails the workflow with a bundle-setup failure naming the failing step, and the
agent is never started — FR-088):

| Condition                                   | Phase that catches it |
| ------------------------------------------- | --------------------- |
| Archive missing from storage                | `bundle_download`     |
| sha256 does not match the registered digest | `bundle_verify`       |
| No `setup.sh` at the archive root           | `bundle_unpack`       |
| `setup.sh` not executable                   | `bundle_unpack`       |
| `setup.sh` exits non-zero                   | `setup_script`        |
| `setup.sh` exceeds the phase timeout        | `setup_script`        |

## `setup.sh` contract

**Environment provided:**

| Variable                    | Value                                           |
| --------------------------- | ----------------------------------------------- |
| `SISYPHUS_WORKSPACE_ROOT`   | `/workspace` — always                           |
| `SISYPHUS_AGENT_CONFIG_DIR` | `/workspace/.agent-config`                      |
| `SISYPHUS_WORKFLOW_ID`      | For log correlation only — **not** a credential |

**Responsibilities.** Install the agent CLI and its credentials, the repository-host credentials, and any
third-party credentials the client's work needs (ticket tracker, package registries, private mirrors) — FR-043,
FR-075.

**Requirements.**

- Exit `0` on success, non-zero on any failure. The exit code is the whole success signal.
- **Idempotent — not "where practical", but required.** `setup.sh` runs on every boot, including the boot that
  restores a snapshot, and reinstalling credentials is how a resumed workflow gets them.
- Write credentials under `/workspace/.agent-config/credentials/`, which is **excluded from the snapshot**.
  Credentials are reinstalled by re-running the bundle, never carried inside a snapshot archive (FR-072).
- Do not assume network egress beyond what the client's work needs.
- Do not depend on the run's prompt, ticket or workspace entries — those do not exist yet at this phase.

**Output handling.** Everything `setup.sh` writes to stdout and stderr is captured and passed through the same
strip-and-redact pipeline as agent output, so a script that echoes a credential cannot leak it into the log
(FR-089). Authors should still avoid echoing secrets — redaction is a backstop, not a licence.

## Trust boundary — stated plainly

`setup.sh` runs as **arbitrary shell with the instance's privileges**, and Sisyphus does not inspect what it
does. Verification is limited to: archive integrity against the registered digest, presence and executability of
`setup.sh`, exit code, and a bounded timeout (Out of Scope, FR-088).

This is deliberate, and it rests on one assumption: **bundles are administrator-authored, never user-supplied.**
That is exactly why registration, replacement, enable and disable all require the `admin` role (FR-167, FR-168)
and why every such action is recorded with the acting admin (FR-178). Widen who can register a bundle and this
boundary is what you have widened.

## Versioning

Archives are **immutable once registered**. Replacing contents creates a new version rather than mutating the
existing one (FR-090), so:

- An in-flight workflow is unaffected by a replacement (FR-090, FR-092).
- A completed workflow still reports the exact version it ran with, and its bootstrap stays reconstructable for
  the retention period (FR-091, SC-021).
- A bundle referenced by an integration or non-terminal workflow cannot be deleted — disable it instead, which
  does not affect runs already in flight (FR-092).

## Validation runs

A bundle can be proven **without** starting an agent (FR-147): provision → download → verify → unpack → run
`setup.sh` → capture redacted output → report per-phase results → tear down. No ticket, workspace or prompt
required.

Recorded against the bundle version with its outcome and output; the panel shows each bundle's most recent
validation result (FR-148, SC-038). This turns the otherwise blind upload-fail-fix-reupload loop into one
command.

**A validation pass is not a guarantee.** A bundle can validate cleanly and still fail in a real run (a
credential valid at validation time expires; a private mirror is reachable from one subnet and not another).
Both results are recorded against the version so the discrepancy is visible rather than confusing.

## Spend-cap declaration

Each bundle declares whether the agent credential it installs makes per-workflow spend caps **enforceable**
(FR-093):

| `spend_caps_enforceable` | Meaning                       | Panel behaviour                                                          |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------ |
| `true`                   | Metered, per-token credential | Spend caps enforced (FR-055)                                             |
| `false`                  | Flat-rate seat credential     | Cap shown as **advisory** wherever it is set for a job using this bundle |

Turn caps are enforced either way. Showing an unenforceable cap as though it were enforced is the failure this
declaration exists to prevent.
