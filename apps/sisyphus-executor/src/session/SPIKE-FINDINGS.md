<!-- cspell:ignore bsdtar -->

# Spike S2 — cross-instance snapshot restore

**Task**: T012 | **Gates**: US3 (resume) | **Research**: R2, S2 | **Date**: 2026-08-05

## Question

Does a snapshot taken on instance A restore correctly on instance B — `--resume` finds the session, uncommitted
work is present, and a deliberately truncated final line in the append-only conversation log is discarded
rather than being fatal (FR-050, FR-051, FR-053)?

## What was run

**No EC2, no AWS, no cloud resource of any kind. No real `claude` invocation.** Instance identity was simulated
by directory. `spike-restore.ts`, covered by `spike-restore.test.ts`.

The simulation was built not to cheat on the property under test. R2's claim is that restore works _because_
the workspace root is a fixed absolute path, so both halves use the **same** absolute pinned root and the root
is destroyed in between:

1. **Instance A** creates the pinned root, `git init`s a repository inside it, commits a baseline, then leaves
   an uncommitted edit to a tracked file and an untracked file. It writes an agent config tree **inside** the
   pinned root (`.agent-config/projects/<mangled root>/<session-id>.jsonl`), whose final line is deliberately
   cut mid-token. It also writes credential material under `.agent-config/credentials/`.
2. **Archive** — real `tar --create`, excluding the credential subtree **at pack time** (deleting afterwards
   would mean the secret was in the archive for a while, which is what FR-072 forbids), then real `zstd`.
3. **Instance A is destroyed** — the pinned root is removed and its absence is asserted, so instance B cannot
   be reading leftovers.
4. **Instance B** takes delivery of the archive in a separate directory, decompresses and extracts it back to
   the **identical** absolute path, then verifies.

Separately, and this is real rather than synthetic: the local `claude` installation on this machine stores
sessions at `~/.claude/projects/<absolute cwd with non-alphanumerics replaced by dashes>/<session-uuid>.jsonl`,
and each log line carries a top-level `sessionId`. R2's path-mangling premise was therefore confirmed against a
real installation, not assumed from documentation.

## What was observed

```
rootDestroyedBetweenInstances : true
compression                   : zstd          (recorded, not assumed)
archiveBytes                  : 14300
sessionIdsFoundOnB            : ["abc-123"]
committedFilePresent          : true
modifiedFileContentsOnB       : "edited by the agent, never committed\n"
untrackedFilePresentOnB       : true
gitStatusOnB                  : ["M tracked.txt", "?? scratch-notes.md"]
conversationLinesOnA          : 6
conversationEntriesOnB        : 5
truncationRepaired            : true
credentialExcludedFromArchive : true
```

- **The session is findable at the pinned path.** Instance B derived the same mangled directory name from the
  same absolute root and found `abc-123.jsonl` there, so `--resume abc-123` has something to resume.
- **Uncommitted work survived.** Both the edit to a tracked file and the untracked file are present, and
  `git status --porcelain` reports them — `.git` came across intact, so the tree is still a repository that
  knows it has been modified rather than a bag of files.
- **The truncated tail was dropped, not fatal.** Six lines in, five entries out, `truncationRepaired: true`.
  A line that fails to parse anywhere other than at the end still throws, because that is corruption rather
  than truncation and the two must not be conflated.
- **The credential never entered the archive.** Excluded at pack time; absent after restore.

## What was NOT observed

**Instance identity was simulated by directory.** That simulation is honest about paths — the pinned absolute
root is genuinely shared and genuinely destroyed in between — but it is still one machine, one filesystem, one
kernel, one process owner. Specifically **not** proven:

- **Anything about EC2.** No instance metadata, no IMDS, no spot reclamation notice, no user-data hand-off, no
  instance profile or credential differences between A and B. A restore that fails because instance B cannot
  read its own metadata would not be caught here.
- **Anything about S3.** The archive was copied between local directories. Upload, download, multipart
  behaviour, transient unavailability, and the park-and-retry path at a snapshot boundary (FR-082, T092) are
  all untested.
- **That the real agent accepts the restored tree.** `--resume` was **not** run: the session id is discoverable
  and the log parses, but whether the agent resumes cleanly against it, and whether its filesystem beliefs
  match the restored tree, requires a prompted session and was not attempted.
- **The real `/workspace`.** A test cannot create `/workspace`, so the pinned root sits under a per-run scratch
  directory. The invariant tested — both instances use the same absolute path — is the right one, but the
  production path itself is untested, and its mangled name will differ.
- **`CLAUDE_CONFIG_DIR` actually relocating the tree.** The config tree was placed inside the pinned root by
  construction. That the environment variable makes the real agent put it there is assumed, not shown, and is
  a one-line check to add in T055/T056.
- **Cross-platform `tar`.** This ran on macOS `bsdtar` (libarchive). Production is Linux with GNU `tar`, where
  exclusion-pattern matching and archive metadata differ. An archive packed on one and unpacked on the other
  was not exercised — though in production both ends are Linux, so the mismatch is a local-development
  concern rather than a production one.
- **Scale.** One small repository, a handful of files, a 14 KB archive. Nothing about a multi-gigabyte
  workspace, many entries (US10), or archive timing.

## Decision

**Proceed. R2's design stands; no fallback needed.** Every mechanical claim S2 was written to test held: the
pinned absolute path makes the mangled session directory reproducible across instances, the whole state tree is
a single archive target, uncommitted work and `.git` survive intact, the truncated tail is an ordinary path,
and excluding the credential subtree at pack time costs nothing.

**Two items carry forward rather than blocking:**

1. A real `--resume` against a restored tree — one prompted invocation, to be folded into T056's single paid
   confirmation run rather than paid for twice.
2. The first genuine two-instance restore lands with T066 (provisioning) and is the real close on the EC2
   half. Until then, treat "restores across instances" as proven for the filesystem and unproven for the
   machine.

`parseConversationLog`, `mangleWorkspacePath`, `sessionLogDirectory` and `discoverSessionIds` are written to be
used by the restore path itself (T055, T091), not thrown away with the spike.
