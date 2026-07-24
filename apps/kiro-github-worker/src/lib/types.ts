import type { Octokit } from '@octokit/rest'

// ── Engine Selection ────────────────────────────────────────────────

/** CLI engine used to execute a code-generation task. */
export type Engine = 'kiro' | 'copilot' | 'claude'

// ── Worker Configuration ────────────────────────────────────────────

export interface WorkerConfig {
  // Required
  githubWebhookSecret: string
  kiroApiKey: string
  kiroCliPath: string
  botUsername: string

  // Auth (one set required)
  githubToken?: string
  githubAppId?: string
  githubAppPrivateKey?: string
  githubAppInstallationId?: string

  // Optional with defaults
  port: number
  webhookPath: string
  triggerLabels: string[]
  kiroTimeoutMs: number
  setupScriptTimeoutMs: number
  workingDirBase: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  branchTemplate: string

  // Optional
  allowedRepos: string[] | null
  deniedRepos: string[] | null

  // A2A configuration
  a2aEnabled: boolean
  a2aPath: string
  a2aAuthToken?: string

  // MCP configuration
  mcpEnabled: boolean
  mcpPath: string
  mcpAuthToken?: string

  // Clone authentication
  githubApiKey?: string

  // Copilot CLI configuration
  copilotCliPath?: string
  copilotGithubToken?: string

  // Claude Code CLI configuration
  claudeCliPath?: string
  anthropicApiKey?: string

  defaultEngine: Engine

  // Agent selection
  defaultAgent?: string

  // Session logging configuration
  sessionLogEnabled: boolean
  sessionLogDir: string
  sessionLogMaxFiles: number
  sessionLogMaxAgeHours: number

  // Admin dashboard configuration
  adminApiToken?: string
  adminDashboardToken?: string
}

// ── Authentication ──────────────────────────────────────────────────

export type AuthMode = 'github-app' | 'pat'

export interface AuthResult {
  mode: AuthMode
  octokit: Octokit
  botUsername: string
  getToken(): Promise<string>
  getCloneToken(): Promise<string>
}

// ── Event Types ─────────────────────────────────────────────────────

export interface ReviewComment {
  body: string
  path: string
  line: number | null
}

export type FilteredEvent =
  | { type: 'new_issue'; repo: string; issueNumber: number; issueTitle: string; issueBody: string }
  | {
      type: 'follow_up_comment'
      repo: string
      issueNumber: number
      issueTitle: string
      issueBody: string
      commentBody: string
      commentId: number
    }
  | {
      type: 'pr_review_comment'
      repo: string
      prNumber: number
      issueNumber: number | null
      commentBody: string
      commentId: number
      filePath: string
      lineContext: string
      branchRef: string
    }
  | {
      type: 'pr_review_changes_requested'
      repo: string
      prNumber: number
      issueNumber: number | null
      reviewBody: string
      reviewComments: ReviewComment[]
      branchRef: string
    }
  | {
      type: 'pr_comment'
      repo: string
      prNumber: number
      issueNumber: number | null
      commentBody: string
      commentId: number
      branchRef: string | null
    }

// ── Job Queue ───────────────────────────────────────────────────────

export interface Job {
  id: string
  queueKey: string
  status: 'queued' | 'in-progress' | 'completed' | 'failed'
  event: FilteredEvent
  enqueuedAt: Date
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
}

// ── Clone & Execution ───────────────────────────────────────────────

export interface CloneResult {
  workingDir: string
  branch: string
  /** Output from rocky.sh setup script, if it was executed. */
  setupScriptResult?: {
    executed: boolean
    exitCode: number | null
    stdout: string
    stderr: string
  }
}

export interface ExecutionResult {
  success: boolean
  hasChanges: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

// ── Webhook Payloads ────────────────────────────────────────────────

export interface IssueEventPayload {
  action: 'labeled'
  repository: { full_name: string }
  issue: {
    number: number
    title: string
    body: string | null
    labels: Array<{ name: string }>
  }
  label: { name: string }
}

export interface IssueCommentPayload {
  action: 'created'
  repository: { full_name: string }
  issue: {
    number: number
    title: string
    body: string | null
    labels: Array<{ name: string }>
    pull_request?: { url: string }
  }
  comment: {
    id: number
    body: string
    user: { login: string }
  }
}

export interface PRReviewCommentPayload {
  action: 'created'
  repository: { full_name: string }
  pull_request: {
    number: number
    head: { ref: string }
    user: { login: string }
  }
  comment: {
    id: number
    body: string
    path: string
    line: number | null
    user: { login: string }
  }
}

export interface PRReviewPayload {
  action: 'submitted'
  repository: { full_name: string }
  pull_request: {
    number: number
    head: { ref: string }
    user: { login: string }
  }
  review: {
    state: 'changes_requested' | 'approved' | 'commented'
    body: string | null
    user: { login: string }
  }
}

// ── Comment Templates ───────────────────────────────────────────────

export const COMMENT_MARKER = '<!-- rocky-worker -->'

export const TEMPLATES = {
  success: `${COMMENT_MARKER}\n🤖 **Rocky** — PR created successfully: {prUrl}`,
  updated: `${COMMENT_MARKER}\n🤖 **Rocky** — I've pushed updates to the PR. Latest commit: {commitSha}`,
  queued: `${COMMENT_MARKER}\n🤖 **Rocky** — Your request is queued (position #{position}). I'll get to it shortly.`,
  error: `${COMMENT_MARKER}\n🤖 **Rocky** — Something went wrong during {step}: {error}`,
  conflict: `${COMMENT_MARKER}\n🤖 **Rocky** — The branch has merge conflicts with the default branch. Please resolve them before I can continue.`,
  prFeedbackAck: `${COMMENT_MARKER}\n🤖 **Rocky** — I've addressed your feedback. See commit: {commitSha}`,
  prFeedbackError: `${COMMENT_MARKER}\n🤖 **Rocky** — Something went wrong while addressing your feedback: {error}`,
} as const
