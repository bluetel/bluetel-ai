/**
 * A2A (Agent-to-Agent) protocol types for Rocky.
 *
 * Defines all TypeScript types for the A2A invocation path:
 * JSON-RPC 2.0 request/response envelopes, task lifecycle models,
 * agent card, and component interfaces.
 */

import type express from 'express'

import type { AuthResult, CloneResult, Engine, ExecutionResult, WorkerConfig } from './types'

// ── A2A Task Models ─────────────────────────────────────────────────

export interface A2ATaskInput {
  /** GitHub repository URL (HTTPS format: https://github.com/{owner}/{repo}) */
  repoUrl: string
  /** Branch to clone and start work from */
  baseBranch: string
  /** Multi-line shell script to run after cloning for environment setup (optional) */
  installScript?: string
  /** Detailed task description passed directly to Kiro CLI */
  prompt: string
  /** CLI engine to use for this task (defaults to configured DEFAULT_ENGINE) */
  engine?: Engine
  /** Kiro CLI agent name to use for this task */
  agent?: string
}

export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

export interface A2ATaskArtifact {
  /** Artifact type (e.g. "stdout", "branch", "pr_url", "commit_sha", "install_output") */
  type: string
  /** Artifact value */
  value: string
}

export interface A2ATask {
  /** Unique task identifier (UUID v4) */
  id: string
  /** Current task status */
  status: A2ATaskStatus
  /** Parsed task input from the caller */
  input: A2ATaskInput
  /** Repository full name derived from repoUrl (e.g. "owner/repo") */
  repoFullName: string
  /** Job queue key: "{repoFullName}:a2a-{taskId}" */
  queueKey: string
  /** Collected output artifacts */
  artifacts: A2ATaskArtifact[]
  /** Error details if the task failed */
  error?: {
    step: 'clone' | 'install' | 'kiro-cli'
    message: string
  }
  /** AI-generated summary of what the task was asked to do (max 256 chars) */
  promptSummary: string | null
  /** AI-generated summary of what the task accomplished (max 256 chars) */
  resultSummary: string | null
  /** Timestamp when the task was created */
  createdAt: Date
  /** Timestamp of the last status update */
  updatedAt: Date
  /** Timestamp when the task completed (success, failure, or cancellation) */
  completedAt: Date | null
}

export interface A2ATaskMessage {
  role: 'user'
  parts: Array<{
    type: 'text'
    text: string
  }>
}

// ── JSON-RPC 2.0 Models ────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: 'tasks/send' | 'tasks/get' | 'tasks/cancel'
  params: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result: {
    id: string
    status: {
      state: A2ATaskStatus
      message?: string
    }
    promptSummary?: string
    resultSummary?: string
    artifacts?: A2ATaskArtifact[]
  }
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

// ── JSON-RPC Method Params ──────────────────────────────────────────

export interface TaskSendParams {
  message: A2ATaskMessage
}

export interface TaskGetParams {
  id: string
}

export interface TaskCancelParams {
  id: string
}

// ── Agent Card ──────────────────────────────────────────────────────

export interface AgentCard {
  name: string
  description: string
  url: string
  version: string
  capabilities: {
    methods: string[]
  }
  inputSchema: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description: string
        required?: boolean
      }
    >
  }
}

// ── Component Interfaces ────────────────────────────────────────────

export interface A2AServerConfig {
  /** A2A endpoint path (default: "/a2a") */
  a2aPath: string
  /** Optional Bearer token for request authentication */
  a2aAuthToken?: string
}

export interface A2AServerInstance {
  /** Express router to mount on the app */
  router: express.Router
  /** Agent card JSON object */
  agentCard: AgentCard
}

export interface A2ATaskHandler {
  /** Validate and parse task input, returning parsed fields or a validation error */
  parseTaskInput(message: A2ATaskMessage): A2ATaskInput | A2AValidationError
  /** Execute the full task pipeline (called by Job_Queue processor) */
  executeTask(task: A2ATask): Promise<void>
  /** Cancel a task (kill in-progress process or remove from queue) */
  cancelTask(taskId: string): Promise<boolean>
}

export interface A2ATaskStore {
  /** Create a new task record from parsed input */
  create(input: A2ATaskInput, repoFullName: string): A2ATask
  /** Retrieve a task by ID */
  get(taskId: string): A2ATask | undefined
  /** Retrieve all tasks */
  getAll(): A2ATask[]
  /** Update a task's status */
  updateStatus(taskId: string, status: A2ATaskStatus): void
  /** Set error details on a task */
  setError(taskId: string, step: string, message: string): void
  /** Append an artifact to a task */
  addArtifact(taskId: string, artifact: A2ATaskArtifact): void
  /** Mark a task as completed with a completion timestamp */
  setCompleted(taskId: string): void
  /** Set the AI-generated prompt summary on a task */
  setPromptSummary(taskId: string, summary: string): void
  /** Set the AI-generated result summary on a task */
  setResultSummary(taskId: string, summary: string): void
}

// ── Validation Error ────────────────────────────────────────────────

export interface A2AValidationError {
  valid: false
  field: string
  message: string
}

// ── Repo Cloner A2A Extension ───────────────────────────────────────

export interface RepoClonerA2A {
  cloneAtBranch(repoFullName: string, branchName: string, token: string): Promise<CloneResult>
  cleanup(workingDir: string): Promise<void>
}

// ── Re-exports for convenience ──────────────────────────────────────

export type { AuthResult, CloneResult, ExecutionResult, WorkerConfig }
