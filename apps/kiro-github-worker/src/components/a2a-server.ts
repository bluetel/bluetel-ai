/**
 * A2A JSON-RPC 2.0 server for Rocky.
 *
 * Exposes a single POST endpoint that dispatches `tasks/send`,
 * `tasks/get`, and `tasks/cancel` methods. Validates Bearer token
 * authentication when `A2A_AUTH_TOKEN` is configured. Builds the
 * agent card JSON object for discovery at `/.well-known/agent.json`.
 */

import express from 'express'
import type pino from 'pino'

import type {
  A2AServerConfig,
  A2AServerInstance,
  A2ATask,
  A2ATaskHandler,
  A2ATaskMessage,
  A2ATaskStore,
  AgentCard,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskCancelParams,
  TaskGetParams,
} from '../lib/a2a-types'

import { extractRepoFullName, isValidationError } from './a2a-task-handler'

// ── JSON-RPC Error Codes ────────────────────────────────────────────

const JSON_RPC_PARSE_ERROR = -32700
const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32603
const JSON_RPC_UNAUTHORIZED = -32001

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Builds a JSON-RPC 2.0 error response.
 */
const buildErrorResponse = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
})

/**
 * Builds a JSON-RPC 2.0 success response for a task.
 */
const buildTaskResponse = (id: string | number, task: A2ATask): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result: {
    id: task.id,
    status: {
      state: task.status,
      ...(task.error ? { message: `${task.error.step}: ${task.error.message}` } : {}),
    },
    ...(task.promptSummary != null ? { promptSummary: task.promptSummary } : {}),
    ...(task.resultSummary != null ? { resultSummary: task.resultSummary } : {}),
    ...(task.artifacts.length > 0 ? { artifacts: task.artifacts } : {}),
  },
})

/**
 * Validates the basic structure of a JSON-RPC 2.0 request.
 * Returns an error response if invalid, or `null` if valid.
 */
const validateJsonRpcRequest = (
  body: unknown,
): { request: JsonRpcRequest } | { error: JsonRpcErrorResponse } => {
  if (body == null || typeof body !== 'object') {
    return { error: buildErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid request') }
  }

  const obj = body as Record<string, unknown>

  if (obj['jsonrpc'] !== '2.0') {
    return {
      error: buildErrorResponse(extractId(obj), JSON_RPC_INVALID_REQUEST, 'Invalid request'),
    }
  }

  const id = obj['id']
  if (id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number')) {
    return { error: buildErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid request') }
  }

  const method = obj['method']
  if (typeof method !== 'string') {
    return {
      error: buildErrorResponse(id, JSON_RPC_INVALID_REQUEST, 'Invalid request'),
    }
  }

  const validMethods = ['tasks/send', 'tasks/get', 'tasks/cancel']
  if (!validMethods.includes(method)) {
    return {
      error: buildErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found'),
    }
  }

  const params = obj['params']
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return {
      error: buildErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        'Invalid params: params must be an object',
      ),
    }
  }

  return {
    request: {
      jsonrpc: '2.0',
      id: id,
      method: method as JsonRpcRequest['method'],
      params: params as Record<string, unknown>,
    },
  }
}

/**
 * Extracts the `id` field from a raw request body for error responses.
 */
const extractId = (obj: Record<string, unknown>): string | number | null => {
  const id = obj['id']
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}

// ── Agent Card Builder ──────────────────────────────────────────────

const buildAgentCard = (a2aPath: string): AgentCard => ({
  name: 'Rocky',
  description:
    'Kiro GitHub Worker — clones repositories, runs Kiro CLI headlessly to implement changes, and manages pull requests. Supports repository setup via caller-provided install scripts.',
  url: a2aPath,
  version: '0.0.0',
  capabilities: {
    methods: ['tasks/send', 'tasks/get', 'tasks/cancel'],
  },
  inputSchema: {
    type: 'object',
    properties: {
      repoUrl: {
        type: 'string',
        description: 'GitHub repository URL (HTTPS format: https://github.com/{owner}/{repo})',
        required: true,
      },
      baseBranch: {
        type: 'string',
        description: 'Branch to clone and start work from',
        required: true,
      },
      installScript: {
        type: 'string',
        description:
          'Multi-line shell script to run after cloning for environment setup. Written to rocky-install.sh and executed with bash.',
        required: false,
      },
      prompt: {
        type: 'string',
        description:
          'Detailed task description passed directly to Kiro CLI. Should contain all instructions including any desired git operations.',
        required: true,
      },
      engine: {
        type: 'string',
        description:
          'CLI engine to use for this task. Valid values: "kiro", "copilot". Defaults to the configured DEFAULT_ENGINE.',
      },
    },
  },
})

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an A2A server with a JSON-RPC 2.0 endpoint and agent card.
 *
 * @param config - A2A server configuration (path, auth token)
 * @param deps - Dependencies: taskHandler, taskStore, logger, enqueueJob
 * @returns An object with the Express router and agent card
 */
export const createA2AServer = (
  config: A2AServerConfig,
  deps: {
    taskHandler: A2ATaskHandler
    taskStore: A2ATaskStore
    logger: pino.Logger
    enqueueJob: (queueKey: string, jobFn: () => Promise<void>) => void
  },
): A2AServerInstance => {
  const { taskHandler, taskStore, logger, enqueueJob } = deps
  const log = logger.child({ component: 'a2a-server' })

  // Log auth status at creation time
  if (config.a2aAuthToken) {
    log.info('A2A Bearer token authentication enabled')
  } else {
    log.warn('A2A_AUTH_TOKEN not configured — accepting all A2A requests without authentication')
  }

  const router = express.Router()

  // ── Bearer Token Validation ─────────────────────────────────────

  const validateAuth = (
    authHeader: string | undefined,
    requestId: string | number | null,
  ): JsonRpcErrorResponse | null => {
    // If no auth token configured, accept all requests
    if (!config.a2aAuthToken) return null

    if (!authHeader) {
      return buildErrorResponse(requestId, JSON_RPC_UNAUTHORIZED, 'Unauthorized')
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== config.a2aAuthToken) {
      return buildErrorResponse(requestId, JSON_RPC_UNAUTHORIZED, 'Unauthorized')
    }

    return null
  }

  // ── Method Handlers ─────────────────────────────────────────────

  const handleTasksSend = (
    requestId: string | number,
    params: Record<string, unknown>,
  ): JsonRpcResponse | JsonRpcErrorResponse => {
    // Validate params structure
    const sendParams = params as { message?: { parts?: unknown[]; role?: string } }
    if (!sendParams.message?.parts || !sendParams.message.role) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        'Invalid params: message with role and parts is required',
      )
    }

    // Parse and validate task input
    const parseResult = taskHandler.parseTaskInput(sendParams.message as unknown as A2ATaskMessage)
    if (isValidationError(parseResult)) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        `Invalid params: ${parseResult.field} — ${parseResult.message}`,
      )
    }

    // Extract repoFullName and create task in store
    const repoFullName = extractRepoFullName(parseResult.repoUrl)
    const task = taskStore.create(parseResult, repoFullName)

    // Enqueue the job for async execution
    enqueueJob(task.queueKey, async () => {
      await taskHandler.executeTask(task)
    })

    // Update status to working and return initial response
    taskStore.updateStatus(task.id, 'working')

    return buildTaskResponse(requestId, task)
  }

  const handleTasksGet = (
    requestId: string | number,
    params: Record<string, unknown>,
  ): JsonRpcResponse | JsonRpcErrorResponse => {
    const getParams = params as unknown as TaskGetParams
    if (!getParams.id || typeof getParams.id !== 'string') {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        'Invalid params: id is required and must be a string',
      )
    }

    const task = taskStore.get(getParams.id)
    if (!task) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        `Task not found: ${getParams.id}`,
      )
    }

    return buildTaskResponse(requestId, task)
  }

  const handleTasksCancel = async (
    requestId: string | number,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse | JsonRpcErrorResponse> => {
    const cancelParams = params as unknown as TaskCancelParams
    if (!cancelParams.id || typeof cancelParams.id !== 'string') {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        'Invalid params: id is required and must be a string',
      )
    }

    const task = taskStore.get(cancelParams.id)
    if (!task) {
      return buildErrorResponse(
        requestId,
        JSON_RPC_INVALID_PARAMS,
        `Task not found: ${cancelParams.id}`,
      )
    }

    await taskHandler.cancelTask(cancelParams.id)

    // Re-fetch the task to get the updated status
    const updatedTask = taskStore.get(cancelParams.id)
    if (!updatedTask) {
      return buildErrorResponse(requestId, JSON_RPC_INTERNAL_ERROR, 'Internal error')
    }

    return buildTaskResponse(requestId, updatedTask)
  }

  // ── POST Handler ────────────────────────────────────────────────

  router.post(config.a2aPath, express.json(), async (req, res) => {
    const reqLog = log.child({ path: config.a2aPath })

    try {
      // Handle JSON parse errors (express.json() sets body to undefined on parse failure)
      if (req.body === undefined) {
        reqLog.warn('JSON parse error in request body')
        res.status(200).json(buildErrorResponse(null, JSON_RPC_PARSE_ERROR, 'Parse error'))
        return
      }

      // Validate JSON-RPC structure
      const validation = validateJsonRpcRequest(req.body)
      if ('error' in validation) {
        reqLog.warn({ error: validation.error }, 'Invalid JSON-RPC request')
        res.status(200).json(validation.error)
        return
      }

      const { request } = validation

      // Validate Bearer token
      const authError = validateAuth(req.headers.authorization, request.id)
      if (authError) {
        reqLog.warn('Unauthorized A2A request')
        res.status(200).json(authError)
        return
      }

      reqLog.info({ method: request.method, id: request.id }, 'A2A request received')

      // Dispatch to method handler
      let response: JsonRpcResponse | JsonRpcErrorResponse

      switch (request.method) {
        case 'tasks/send':
          response = handleTasksSend(request.id, request.params)
          break
        case 'tasks/get':
          response = handleTasksGet(request.id, request.params)
          break
        case 'tasks/cancel':
          response = await handleTasksCancel(request.id, request.params)
          break
      }

      res.status(200).json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reqLog.error({ error: message }, 'Internal error processing A2A request')
      res.status(200).json(buildErrorResponse(null, JSON_RPC_INTERNAL_ERROR, 'Internal error'))
    }
  })

  const agentCard = buildAgentCard(config.a2aPath)

  return { router, agentCard }
}
