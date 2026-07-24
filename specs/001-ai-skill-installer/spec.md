# Feature Specification: AI Skill Installer

**Feature Branch**: `feature/spec-kit`

**Created**: 2026-07-23

**Status**: Draft

**Input**: User description: "An automated AI skill installation system. A user runs a one-line command that curls/clones a single bootstrap file from this repo and pipes it into bash; bash invokes the Claude CLI to run an 'install' skill. The skill interactively asks which features/skills the user wants (e.g. merge-management), handles both fresh installs and updates, and downloads the relevant skills from this repo. In this source repo, the skills must NOT be kept in the repo-root `.claude`/`.agents` folders — they are stored in a new dedicated tooling package (in a subfolder) that serves as the distribution source; when installed into a target repo they land in that target's `.agents` + `.claude` folders."

## Glossary

- **Source repository**: This repo. It authors and publishes the skills. Canonical skill content is stored here in a dedicated tooling package subfolder — **not** in this repo's root `.claude`/`.agents` folders.
- **Target repository**: Any project into which a developer installs skills using this system. Installed skills land in the target's `.agents` and `.claude` folders.
- **Shared-skill pattern**: The existing convention — canonical procedure content in `.agents/skills/<name>/SKILL.md`, plus a lightweight per-agent activation stub in `.claude/skills/<name>/SKILL.md` that carries frontmatter and points at the shared file.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Fresh install of selected skills (Priority: P1)

A developer working in a target project that does not yet have these shared skills wants to add a subset of them (for example, merge-management and PR-creation). They run a single command in their terminal. The command fetches a small bootstrap script and runs it; the bootstrap launches an interactive assistant that lists the available skills, lets the developer choose which ones to install, downloads the chosen skills from the source repository, and installs them into the target project's `.agents` and `.claude` folders following the shared-skill pattern. It then clearly reports what was installed and confirms the skills are ready for the agent to discover.

**Why this priority**: This is the core value of the feature — without a working fresh install, nothing else matters. It is the minimum viable product: a developer can go from "no shared skills" to "chosen skills installed and discoverable" in one command.

**Independent Test**: In a clean target project with none of these skills present, run the one-line command, select one skill from the interactive prompt, and confirm the skill's canonical content lands in the target's `.agents/skills/<name>/` and an activation stub lands in the target's `.claude/skills/<name>/`, and that a clear summary is shown.

**Acceptance Scenarios**:

1. **Given** a target project with no previously installed shared skills, **When** the developer runs the one-line install command, **Then** an interactive prompt lists the available skills with short descriptions and lets them select one or more.
2. **Given** the developer has selected one or more skills, **When** the installation completes, **Then** each selected skill's canonical content is written to the target's `.agents/skills/<name>/` and a matching activation stub is written to the target's `.claude/skills/<name>/`.
3. **Given** a completed fresh install, **When** the installer finishes, **Then** it displays a clear summary of what was installed, where, and confirms the skills are discoverable by the developer's AI agent.
4. **Given** the developer selects no skills, **When** they confirm, **Then** the installer exits without changing the project and states that nothing was installed.

---

### User Story 2 - Update already-installed skills (Priority: P2)

A developer who previously installed one or more shared skills into their target project wants to bring them up to date with the latest versions published from the source repository. They run the same one-line command. The installer detects that skills are already present in the target's `.agents`/`.claude` folders, shows which are installed and whether newer versions are available, and lets the developer update selected skills (or all of them). Local changes and installed-but-unselected skills are handled predictably.

**Why this priority**: Skills evolve over time; without a safe update path, installations drift and go stale. This is essential for long-term adoption but depends on fresh install existing first.

**Independent Test**: In a target project where a skill was previously installed, run the command again, choose to update, and confirm the skill's files are refreshed to the latest published version while unselected skills are left untouched.

**Acceptance Scenarios**:

1. **Given** a target project with skills already installed, **When** the developer runs the install command, **Then** the installer detects the existing installation and presents an update flow rather than treating it as a fresh install.
2. **Given** existing installed skills, **When** the installer compares them to the source, **Then** it indicates which skills are up to date and which have newer versions available.
3. **Given** the developer chooses to update selected skills, **When** the update completes, **Then** only the chosen skills are updated (content and stub) and the others remain unchanged.
4. **Given** an installed skill has been modified locally, **When** an update would overwrite it, **Then** the installer detects the local modification, warns the developer, and does not silently discard local changes.
5. **Given** a locally-modified skill has a newer version available, **When** the developer is warned of the conflict, **Then** the installer presents a clear choice — **keep** the local version (skip), **overwrite** with the new version (discard local changes), or **try to resolve** (merge the new version into the local changes) — and takes no destructive action until the developer chooses.
6. **Given** the developer chooses to resolve/merge, **When** the local and incoming changes do not overlap, **Then** the merge is applied automatically; **When** they conflict, **Then** the developer is shown the conflicting regions and can complete the resolution, with the skill left in a clearly-marked unresolved state rather than a silently broken one until they do.

---

### User Story 3 - Discover and understand available skills before choosing (Priority: P3)

A developer who is unfamiliar with what skills exist wants to understand their options before committing. The interactive prompt presents each available skill with a human-readable name and a one-line description of what it does and when to use it, so the developer can make an informed selection.

**Why this priority**: Improves adoption and reduces wrong selections, but the system is still usable by knowledgeable users without it. It is a usability enhancement layered on top of the core install/update flows.

**Independent Test**: Run the command and confirm that each listed skill shows a name plus a short description before any selection is made.

**Acceptance Scenarios**:

1. **Given** the interactive prompt is shown, **When** the list of available skills is displayed, **Then** each entry includes a name and a concise description.
2. **Given** the developer is unsure, **When** they review the list, **Then** they can select multiple skills in a single run.

---

### User Story 4 - Source repo stores skills in a tooling package (Priority: P2)

The maintainers of the source repository need the canonical skills to live in a single, dedicated tooling package (in a subfolder) rather than in the repo-root `.claude`/`.agents` folders. This tooling package is the distribution source the installer pulls from. The source repo's own agent tooling continues to work by referencing the tooling-package content, so this repo can both publish and use the skills without duplicating them.

**Why this priority**: The distribution model depends on a single authoritative source for skill content. Consolidating skills into the tooling package is a prerequisite for reliable install/update, and it removes drift between this repo's root agent folders and what gets published.

**Independent Test**: Inspect the source repo and confirm canonical skill content resides in the dedicated tooling package subfolder, the repo-root `.claude`/`.agents` no longer hold canonical copies (only references/stubs as needed), and the installer reads its catalog from the tooling package.

**Acceptance Scenarios**:

1. **Given** the source repository, **When** its structure is inspected, **Then** canonical skill content lives in the dedicated tooling package subfolder and not as canonical copies in the repo-root `.claude`/`.agents` folders.
2. **Given** the installer runs, **When** it determines what is available and downloads content, **Then** it sources both the catalog and the content from the tooling package.
3. **Given** the source repo's own agents, **When** they invoke a skill, **Then** they resolve the procedure from the tooling package (no duplicated canonical content in the repo root).

---

### Edge Cases

- **No network / source unreachable**: The bootstrap or a skill download fails to reach the source repository. The installer must report the failure clearly and leave the target project unchanged rather than partially installing.
- **Claude CLI not installed / not on PATH**: The bootstrap invokes the AI CLI but it is absent. The installer must detect this and give an actionable message (how to install or where to get it) instead of a raw error.
- **Interrupted install**: The process is cancelled partway through writing files. The target project must not be left in a broken half-installed state.
- **Re-selecting an already-installed skill in fresh-install context**: The installer must recognize the existing copy in the target's `.agents`/`.claude` and route to the update flow rather than duplicating it.
- **Target `.agents`/`.claude` folders do not yet exist**: The installer must create them as needed without disturbing unrelated existing content.
- **Version metadata missing on an installed skill**: The installer cannot determine whether an update is needed; it must treat this safely (e.g., prompt the user) rather than assume up to date or forcibly overwrite.
- **Non-interactive environment (CI, piped stdin)**: When no interactive terminal is available for selection, the installer must fail clearly or support an explicit non-interactive selection mechanism rather than hanging.
- **Stub and content out of sync in the target**: If a target has a `.claude` stub without matching `.agents` content (or vice versa), the installer must detect the inconsistency and repair it during install/update.
- **Locally-modified skill updated again**: A developer edited an installed skill in the target and later re-runs the update. The installer must not silently overwrite; it must offer keep / overwrite / resolve, and for resolve produce a merge (auto when non-overlapping, conflict-marked when overlapping).
- **Merge base unavailable**: The originally-installed version needed to compute a three-way merge cannot be retrieved (e.g. source offline, ref removed). The installer must report this and fall back to the keep/overwrite choice rather than attempting an unreliable merge.
- **Merge leaves unresolved conflicts**: After a resolve attempt, conflicting regions remain. The installer must leave the file in a clearly-marked, recoverable state and report that manual resolution is required, rather than recording the skill as successfully updated.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST provide a single publishable bootstrap file that a user can fetch and execute with one command (fetch-and-pipe-to-shell), with no prior setup beyond having the AI CLI available.
- **FR-002**: The bootstrap MUST invoke the AI CLI to run an interactive "install" skill that drives the rest of the process.
- **FR-003**: The install skill MUST present the user with the set of available skills to install, each with a name and a short description.
- **FR-004**: Users MUST be able to select one or more skills (or none) to install in a single run.
- **FR-005**: The system MUST download only the selected skills, and their required supporting files, from the source repository's tooling package.
- **FR-006**: In the **source repository**, canonical skill content MUST be stored in a dedicated tooling package (in a subfolder), and MUST NOT be kept as canonical copies in the repo-root `.claude`/`.agents` folders.
- **FR-007**: When installing into a **target repository**, the system MUST place each selected skill's canonical content into the target's `.agents/skills/<name>/` and a matching activation stub into the target's `.claude/skills/<name>/`, following the shared-skill pattern.
- **FR-008**: After installation, the system MUST clearly communicate what was installed, where it was placed, and confirm the skills are discoverable by the user's AI agent (including any remaining manual step, if one exists).
- **FR-009**: The system MUST distinguish a fresh install from an update by detecting whether the selected skills already exist in the target's `.agents`/`.claude` folders.
- **FR-010**: For updates, the system MUST refresh selected installed skills (content and stub) to the latest published version while leaving unselected skills unchanged.
- **FR-011**: For updates, the system MUST indicate which installed skills are current and which have newer versions available.
- **FR-012**: The system MUST detect when an installed skill has local modifications, warn the user before any overwrite, and MUST NOT silently discard those changes.
- **FR-012a**: When updating a locally-modified skill, the system MUST offer the user an explicit choice between at least: **keep** the local version unchanged, **overwrite** it with the incoming version, or **resolve** (merge the incoming version into the local changes). No option may be applied without the user selecting it (or supplying an equivalent explicit non-interactive flag).
- **FR-012b**: When the user chooses to resolve/merge, the system MUST apply a merge of the incoming changes on top of the local changes. Where the two do not overlap the merge MUST complete automatically; where they conflict the system MUST surface the conflicting regions and leave the skill in a clearly-marked unresolved state (never a silently corrupted file), and MUST report that manual resolution is required. If a reliable merge base cannot be obtained, the system MUST say so and fall back to the keep/overwrite choice rather than guessing.
- **FR-013**: On any failure (network, missing dependency, interruption), the system MUST leave the target project in a consistent state and report the failure with an actionable message.
- **FR-014**: The system MUST detect when the required AI CLI is not available and provide guidance rather than failing opaquely.
- **FR-015**: The available-skills catalog presented to the user MUST be derived from the tooling package so it stays in sync with what the source repository actually publishes (no stale or missing entries).
- **FR-016**: The system MUST allow the same one-line command to be used for both fresh installs and updates (single entry point).
- **FR-017**: The source repository's own agent tooling MUST continue to resolve skills from the tooling package after consolidation, without duplicating canonical content in the repo root.

### Key Entities _(include if feature involves data)_

- **Bootstrap script**: The single file published from the source repository that a user fetches and pipes into a shell; responsible only for preparing the environment and launching the install skill via the AI CLI.
- **Install skill**: The interactive procedure that lists available skills, captures the user's selection, distinguishes install vs. update, downloads content from the tooling package, writes it into the target's `.agents`/`.claude` folders, and reports results.
- **Dedicated tooling package (source repo)**: The new in-repo package, with skills stored in a subfolder, that holds the canonical skill content and catalog. It is the single distribution source and replaces the repo-root `.claude`/`.agents` as the home of canonical content.
- **Available skill (catalog entry)**: A named, describable unit that can be installed (e.g., merge-management, PR-creation), with associated canonical procedure content, activation stub, any supporting files, and version information used to decide whether an update is available.
- **Target install layout**: In each target repo, a skill occupies `.agents/skills/<name>/` (canonical content) and `.claude/skills/<name>/` (activation stub).
- **Installation record / version metadata**: Information about which skills are installed and at what version, used to drive update detection and local-modification warnings.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A developer can go from no shared skills to a chosen set installed using a single command and one interactive selection, with no manual file copying.
- **SC-002**: In a fresh install, 100% of selected skills appear in the target's `.agents/skills/<name>/` (content) and `.claude/skills/<name>/` (stub), and the agent can discover them without further manual file edits.
- **SC-003**: Running the command a second time on an already-installed target results in an update flow, never an unintended duplicate or a silent overwrite of locally modified skills.
- **SC-004**: After any run, the user is shown a summary that unambiguously lists installed skills and their locations, such that a developer unfamiliar with the system can confirm success without external help.
- **SC-005**: When the source is unreachable or the AI CLI is missing, the installer reports the specific problem and leaves the target project unchanged in 100% of such cases (no partial installs).
- **SC-006**: The available-skills list presented to the user matches the set of skills actually publishable from the tooling package (no missing or phantom entries).
- **SC-007**: In the source repository, canonical skill content exists only in the tooling package subfolder (zero canonical duplicates remain in the repo-root `.claude`/`.agents`), and the repo's own agents still resolve every skill correctly.
- **SC-008**: When a locally-modified skill is updated, the developer is offered keep / overwrite / resolve in 100% of such cases; choosing "keep" leaves the file byte-for-byte unchanged, "overwrite" yields the incoming version, and "resolve" produces either a clean automatic merge or a file whose only differences from a clean merge are clearly-marked conflict regions — never a silently corrupted or half-written file.

## Assumptions

- The target user is a developer with a terminal and permission to run a fetch-and-pipe-to-shell command in their project.
- The AI CLI referenced is the Claude CLI; the bootstrap assumes it is (or can be made) available on the user's machine, and detects its absence gracefully.
- The source repository is the single source of truth for skill content, published from the dedicated tooling package.
- Installed skills follow the existing shared-skill pattern: canonical content in the target's `.agents/skills/<name>/` plus a lightweight activation stub in the target's `.claude/skills/<name>/`. "Discoverable" means the agent can locate and invoke the installed skill via that stub.
- The initial scope targets the Claude agent (`.claude` stubs); other agents (Kiro, Copilot) may reuse the shared `.agents` content later but generating their stubs is out of scope for v1.
- The dedicated tooling package is a new package in this repo; its exact name and the subfolder layout are a planning-phase decision, constrained only by "canonical content is not kept in the repo-root `.claude`/`.agents`."
- Version/update detection relies on some form of version metadata carried with each installed skill; the exact mechanism is a planning-phase decision.
- Consolidating this repo's existing skills into the tooling package (and repointing the repo's own root stubs/references at it) is in scope, since the tooling package must be the single distribution source.

## Dependencies

- Access to the source repository from the target machine (network access to fetch the bootstrap and download skills).
- The Claude CLI being installable/available on the target machine.
- The existing shared-skill structure and content (`merging`, `pr-creation`, `speckit-*`, etc.) that will be consolidated into the tooling package and become the installable catalog.
