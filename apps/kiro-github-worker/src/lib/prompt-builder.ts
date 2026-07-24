/**
 * Prompt construction for CLI executors (Kiro and Copilot).
 *
 * Builds prompts for the three main event types: new issues, follow-up
 * comments, and PR review feedback. Prompts include repo/issue/PR
 * references so the CLI can fetch additional context via its own tools —
 * full diffs and conversation histories are never inlined.
 *
 * Each prompt includes explicit git instructions telling the CLI
 * to commit, push, and (for new issues) create a pull request. The
 * Worker itself does not perform git operations — the CLI owns the
 * full commit/push/PR lifecycle.
 *
 * Prompt structure follows a deliberate ordering to maximize LLM
 * compliance:
 *   1. Role & environment constraints (highest priority framing)
 *   2. Task-specific instructions (what to do)
 *   3. Context (issue/PR details)
 *   4. Final reminder of critical constraints
 */

// ── Building Blocks ─────────────────────────────────────────────────

/**
 * Role and environment preamble placed at the TOP of every prompt.
 *
 * Establishes the ephemeral environment constraint and commit/push
 * requirement before any task details, ensuring the LLM processes
 * these constraints as high-priority framing rather than an afterthought.
 */
export const ROLE_PREAMBLE = [
  'You are a coding agent operating in an ephemeral environment.',
  'The working directory is a temporary clone that will be destroyed after this session.',
  'Any local changes that are not committed and pushed to a remote branch will be PERMANENTLY LOST.',
  '',
  'CRITICAL RULES:',
  '- NEVER commit directly to the main or master branch. Always create a new feature branch and push to that.',
  '- Before starting work, check the repository for conventions: look for skills, .github/ configs, branch naming patterns, pre-commit hooks, and any skills or steering files.',
  "- Follow the repository's existing conventions for branch naming, commit messages, and code style.",
  '- If the repository has branch protection rules, respect them — create a PR instead of pushing directly.',
  '- You MUST commit all changes and push them to the remote branch.',
  '- Do NOT leave changes uncommitted or unpushed.',
].join('\n')

/**
 * Short closing reminder to reinforce commit/push behavior.
 * Placed at the very end of the prompt for recency bias.
 */
export const CLOSING_REMINDER = [
  'REMINDER: This is an ephemeral environment.',
  '- Commit and push ALL changes before finishing.',
  '- Do NOT push to main/master — use a feature branch.',
  '- Create a pull request if the task requires one.',
].join(' ')

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Joins prompt sections with double newlines for clear visual separation.
 * Filters out empty strings to avoid extra blank lines.
 */
export const joinSections = (...sections: string[]): string =>
  sections.filter((s) => s.length > 0).join('\n\n')

/**
 * Wraps a raw user prompt with the system preamble and closing reminder.
 *
 * Used by A2A and MCP task handlers to give caller-provided prompts the
 * same ephemeral-environment framing that webhook-triggered prompts get
 * via the dedicated prompt builders.
 *
 * @param userPrompt - The caller's raw prompt text
 * @returns The prompt wrapped with ROLE_PREAMBLE and CLOSING_REMINDER
 */
export const buildA2APrompt = (userPrompt: string): string =>
  joinSections(ROLE_PREAMBLE, userPrompt, CLOSING_REMINDER)

// ── Public API ──────────────────────────────────────────────────────

/**
 * Constructs a setup prompt that instructs the LLM agent to inspect the
 * repository, determine the project type and package manager, and run
 * the appropriate install command.
 *
 * The prompt explicitly prohibits committing, pushing, or creating PRs.
 *
 * @returns The constructed setup prompt string
 */
export const buildSetupPrompt = (): string => {
  const role = [
    'You are a setup agent preparing a repository for a coding task.',
    'Your ONLY job is to inspect the repository and install dependencies.',
  ].join('\n')

  const jsTs = [
    '## JavaScript / TypeScript Projects',
    '### Node version',
    'Before installing dependencies, check if an `.nvmrc` file exists in the repository root.',
    'If `.nvmrc` is present, run `nvm install` (which reads the version from `.nvmrc`) to ensure the correct Node.js version is active, then proceed with dependency installation below.',
    '',
    '### Dependency installation',
    'Check for lockfiles in the following priority order and use the corresponding package manager:',
    '1. `pnpm-lock.yaml` → run `pnpm install`',
    '2. `yarn.lock` → run `yarn install`',
    '3. `bun.lockb` or `bun.lock` → run `bun install`',
    '4. `package-lock.json` → run `npm install`',
    'If none of these lockfiles are present but a `package.json` exists, fall back to `npm install`.',
  ].join('\n')

  const python = [
    '## Python Projects',
    'Look for the following files and use the corresponding tool:',
    '- `requirements.txt` → run `pip install -r requirements.txt`',
    '- `pyproject.toml` → run `pip install .` or use `poetry install` if a poetry section is present',
    '- `Pipfile` → run `pipenv install`',
    '- `setup.py` → run `pip install -e .`',
  ].join('\n')

  const otherLangs = [
    '## Other Languages',
    '- **Go**: If `go.mod` is present, run `go mod download`.',
    '- **Rust**: If `Cargo.toml` is present, run `cargo build`.',
    '- **Ruby**: If `Gemfile` is present, run `bundle install`.',
    '- **Java/Kotlin**: If `pom.xml` is present, run `mvn install -DskipTests`. If `build.gradle` is present, run `gradle build -x test`.',
  ].join('\n')

  const fallback = [
    '## Fallback: README, Makefile, and docker-compose',
    'When standard lockfiles or project configuration files are absent, read the following files for setup instructions:',
    '- `README` or `README.md` — look for "Getting Started", "Installation", or "Setup" sections.',
    '- `Makefile` — look for an `install`, `setup`, or `deps` target.',
    '- `docker-compose.yml` — check if the project is meant to run via Docker.',
    'Follow any setup instructions you find in these files.',
  ].join('\n')

  const constraints = [
    '## HARD CONSTRAINTS',
    'You MUST follow these rules strictly:',
    '- Do NOT commit any changes.',
    '- Do NOT push to any branch.',
    '- Do NOT create pull requests.',
    '- Do NOT modify source code files.',
    '- Only install dependencies and configure the build environment.',
  ].join('\n')

  const skip = [
    '## Skip Behavior',
    'If no recognizable project configuration is found (no package.json, no requirements.txt, no go.mod, no Cargo.toml, no Gemfile, no pom.xml, no build.gradle, no Makefile, no README with setup instructions), exit successfully without error. Do not fail — simply finish with a success status.',
  ].join('\n')

  return joinSections(role, jsTs, python, otherLangs, fallback, constraints, skip)
}

/**
 * Constructs a prompt for processing a newly labeled GitHub issue.
 *
 * @param title - Issue title
 * @param body - Issue body (may be empty)
 * @param repo - Repository full name (e.g. "org/repo")
 * @param issueNumber - GitHub issue number
 * @param branchName - Target branch name to push to
 * @returns The constructed prompt string
 */
export const buildNewIssuePrompt = (
  title: string,
  body: string,
  repo: string,
  issueNumber: number,
  branchName: string,
): string => {
  const task = [
    `TASK: Implement GitHub issue #${String(issueNumber)} in repository ${repo}.`,
    `After implementing, commit your work, push to branch '${branchName}', and create a pull request against the default branch.`,
    `PR title: '[Kiro] ${title}'`,
    `PR body must contain: 'Closes #${String(issueNumber)}'`,
  ].join('\n')

  const context = [
    '--- ISSUE DETAILS ---',
    `Title: ${title}`,
    `Body: ${body || '(no body provided)'}`,
    '--- END ISSUE DETAILS ---',
  ].join('\n')

  const tools = `Use your GitHub tools to fetch any additional context you need from ${repo} issue #${String(issueNumber)}.`

  return joinSections(ROLE_PREAMBLE, task, context, tools, CLOSING_REMINDER)
}

/**
 * Constructs a prompt for processing a follow-up comment on an issue.
 *
 * @param title - Original issue title
 * @param body - Original issue body (may be empty)
 * @param commentBody - The new follow-up comment text
 * @param repo - Repository full name (e.g. "org/repo")
 * @param issueNumber - GitHub issue number
 * @returns The constructed prompt string
 */
export const buildFollowUpPrompt = (
  title: string,
  body: string,
  commentBody: string,
  repo: string,
  issueNumber: number,
): string => {
  const task = [
    `TASK: Continue working on GitHub issue #${String(issueNumber)} in ${repo} based on new instructions.`,
    'After making changes, commit and push them to the current branch.',
  ].join('\n')

  const context = [
    '--- ORIGINAL ISSUE ---',
    `Title: ${title}`,
    `Body: ${body || '(no body provided)'}`,
    '--- END ORIGINAL ISSUE ---',
    '',
    '--- NEW INSTRUCTION ---',
    commentBody,
    '--- END NEW INSTRUCTION ---',
  ].join('\n')

  const tools = `Use your GitHub tools to fetch the conversation history and any additional context from ${repo} issue #${String(issueNumber)}.`

  return joinSections(ROLE_PREAMBLE, task, context, tools, CLOSING_REMINDER)
}

/**
 * Constructs a prompt for addressing PR review feedback.
 *
 * @param title - Original issue title
 * @param body - Original issue body (may be empty)
 * @param feedback - The review feedback text (review body or comment body)
 * @param repo - Repository full name (e.g. "org/repo")
 * @param issueNumber - GitHub issue number
 * @param prNumber - Pull request number
 * @returns The constructed prompt string
 */
export const buildPRReviewPrompt = (
  title: string,
  body: string,
  feedback: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
): string => {
  const task = [
    `TASK: Address review feedback on PR #${String(prNumber)} in ${repo} (related to issue #${String(issueNumber)}).`,
    'After making changes, commit and push them to the current branch, then leave a reply comment on the PR summarizing what you changed.',
  ].join('\n')

  const context = [
    '--- ORIGINAL ISSUE ---',
    `Title: ${title}`,
    `Body: ${body || '(no body provided)'}`,
    '--- END ORIGINAL ISSUE ---',
    '',
    '--- REVIEW FEEDBACK ---',
    feedback,
    '--- END REVIEW FEEDBACK ---',
  ].join('\n')

  const tools = `Use your GitHub tools to fetch the PR diff and any additional context from ${repo} PR #${String(prNumber)}.`

  return joinSections(ROLE_PREAMBLE, task, context, tools, CLOSING_REMINDER)
}

// ── Agent Resolution ────────────────────────────────────────────────

import { parseAgentDirective } from './parse-agent-directive'

/**
 * Resolves the agent for a webhook-triggered task.
 *
 * Priority: explicit agent: directive in issue/comment → DEFAULT_AGENT env → undefined
 *
 * @param issueBody - Issue body text
 * @param commentBody - Comment body text (may be empty)
 * @param defaultAgent - DEFAULT_AGENT from config (may be undefined)
 * @returns Resolved agent name or undefined
 */
export const resolveWebhookAgent = (
  issueBody: string,
  commentBody: string,
  defaultAgent?: string,
): string | undefined => {
  const explicit = parseAgentDirective(issueBody) ?? parseAgentDirective(commentBody)
  return explicit ?? defaultAgent
}
