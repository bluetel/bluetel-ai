/**
 * MCP (Model Context Protocol) types for Rocky.
 *
 * Defines all TypeScript types for the MCP invocation path:
 * task lifecycle models, tool input/output types, component interfaces,
 * and server configuration.
 */

import type express from 'express'

import type { AuthResult, CloneResult, Engine, ExecutionResult, WorkerConfig } from './types'

// ── MCP Task Models ─────────────────────────────────────────────────

export interface MCPTaskInput {
  /** GitHub repository URL (HTTPS format: https://github.com/{owner}/{repo}) */
  repoUrl: string
  /** Branch to clone and start work from */
  baseBranch: string
  /** Multi-line shell script to run after cloning for environment setup (optional) */
  installScript?: string
  /** Detailed task description passed directly to Kiro CLI */
  prompt: string
  /** Execution engine override — selects which CLI engine processes the task (optional, defaults to configured DEFAULT_ENGINE) */
  engine?: Engine
  /** Kiro CLI agent name to use for this task */
  agent?: string
}

export type MCPTaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

export interface MCPTaskArtifact {
  /** Artifact type (e.g. "stdout", "branch", "pr_url", "commit_sha", "install_output") */
  type: string
  /** Artifact value */
  value: string
}

export interface MCPTask {
  /** Unique task identifier (UUID v4) */
  id: string
  /** Current task status */
  status: MCPTaskStatus
  /** Parsed task input from the caller */
  input: MCPTaskInput
  /** Repository full name derived from repoUrl (e.g. "owner/repo") */
  repoFullName: string
  /** Job queue key: "{repoFullName}:mcp-{taskId}" */
  queueKey: string
  /** Collected output artifacts */
  artifacts: MCPTaskArtifact[]
  /** Error details if the task failed */
  error?: {
    step: 'clone' | 'install' | 'kiro-cli'
    message: string
  }
  /** AI-generated summary of what the task was asked to do */
  promptSummary: string | null
  /** AI-generated summary of what the task accomplished */
  resultSummary: string | null
  /** Timestamp when the task was created */
  createdAt: Date
  /** Timestamp of the last status update */
  updatedAt: Date
  /** Timestamp when the task completed (success, failure, or cancellation) */
  completedAt: Date | null
}

// ── MCP Tool Response Types ─────────────────────────────────────────

export interface ExecuteTaskResult {
  taskId: string
  status: 'working'
}

export interface GetTaskStatusResult {
  taskId: string
  status: MCPTaskStatus
  error?: {
    step: string
    message: string
  }
  artifacts?: MCPTaskArtifact[]
}

export interface CancelTaskResult {
  taskId: string
  status: MCPTaskStatus
  canceled: boolean
}

// ── Validation Error ────────────────────────────────────────────────

export interface MCPValidationError {
  valid: false
  field: string
  message: string
}

// ── Server Configuration ────────────────────────────────────────────

export interface MCPServerConfig {
  /** MCP endpoint path (default: "/mcp") */
  mcpPath: string
  /** Optional Bearer token for connection authentication */
  mcpAuthToken?: string
}

export interface MCPServerInstance {
  /** Express router to mount on the app (handles Streamable HTTP endpoints) */
  router: express.Router
}

// ── Component Interfaces ────────────────────────────────────────────

export interface MCPTaskHandler {
  /** Validate and parse task input from MCP tool arguments */
  parseTaskInput(args: Record<string, unknown>): MCPTaskInput | MCPValidationError
  /** Execute the full task pipeline (called by Job_Queue processor) */
  executeTask(task: MCPTask): Promise<void>
  /** Cancel a task (kill in-progress process or remove from queue) */
  cancelTask(taskId: string): Promise<boolean>
}

export interface MCPTaskStore {
  /** Create a new task record from parsed input */
  create(input: MCPTaskInput, repoFullName: string): MCPTask
  /** Retrieve a task by ID */
  get(taskId: string): MCPTask | undefined
  /** Retrieve all tasks */
  getAll(): MCPTask[]
  /** Update a task's status */
  updateStatus(taskId: string, status: MCPTaskStatus): void
  /** Set error details on a task */
  setError(taskId: string, step: string, message: string): void
  /** Append an artifact to a task */
  addArtifact(taskId: string, artifact: MCPTaskArtifact): void
  /** Mark a task as completed with a completion timestamp */
  setCompleted(taskId: string): void
  /** Set the AI-generated prompt summary on a task */
  setPromptSummary(taskId: string, summary: string): void
  /** Set the AI-generated result summary on a task */
  setResultSummary(taskId: string, summary: string): void
}

// ── Repo Cloner MCP Extension ───────────────────────────────────────

export interface RepoClonerMCP {
  cloneAtBranch(repoFullName: string, branchName: string, token: string): Promise<CloneResult>
  cleanup(workingDir: string): Promise<void>
}

// ── Re-exports for convenience ──────────────────────────────────────

export type { AuthResult, CloneResult, ExecutionResult, WorkerConfig }
