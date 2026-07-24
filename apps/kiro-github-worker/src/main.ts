/**
 * Kiro GitHub Worker ("Rocky") — Application entry point.
 *
 * Parses configuration, initializes all components, wires the job
 * processing pipeline, starts the HTTP server, and registers graceful
 * shutdown handlers.
 *
 * Job processing pipeline:
 * - `new_issue`: Repo_Cloner → PR_Manager.recordBranch → Kiro_Executor (with branchName in prompt) → Issue_Commenter.postSuccess
 * - `follow_up_comment`: Repo_Cloner → Kiro_Executor → PR_Manager.verifyPushedCommits → Issue_Commenter.postUpdated
 * - `pr_review_comment` / `pr_review_changes_requested` / `pr_comment`: PR_Reviewer (end-to-end)
 */

import { existsSync } from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import type { Router } from 'express'

import { createA2AServer } from './components/a2a-server'
import { createA2ATaskHandler } from './components/a2a-task-handler'
import { createA2ATaskStore } from './components/a2a-task-store'
import { createAdminApiRouter } from './components/admin-api-router'
import { createAdminAuthMiddleware } from './components/admin-auth-middleware'
import { createAgentRegistry } from './components/agent-registry'
import { detectAuth } from './components/auth-detector'
import { createBranchMap } from './components/branch-map'
import { createClaudeExecutor } from './components/claude-executor'
import { createCopilotExecutor } from './components/copilot-executor'
import { createEventFilter } from './components/event-filter'
import { createExecutorRouter } from './components/executor-router'
import {
  addEyesReaction,
  postError,
  postQueued,
  postSuccess,
  postUpdated,
} from './components/issue-commenter'
import { createJobQueue } from './components/job-queue'
import type { JobProcessor } from './components/job-queue'
import { createKiroExecutor } from './components/kiro-executor'
import { createMCPServer } from './components/mcp-server'
import { createMCPTaskHandler } from './components/mcp-task-handler'
import { createMCPTaskStore } from './components/mcp-task-store'
import { createPRManager } from './components/pr-manager'
import { createPRReviewer } from './components/pr-reviewer'
import { createRepoCloner } from './components/repo-cloner'
import { createRepoFilter } from './components/repo-filter'
import { createReviewApiRouter } from './components/review-api-router'
import { createReviewStore } from './components/review-store'
import { createSessionLogWriter } from './components/session-log-writer'
import { isAlreadyReportedError } from './components/setup-script-runner'
import { createSummarizer } from './components/summarizer'
import { createTunnelManager } from './components/tunnel-manager'
import type { TunnelManagerInstance } from './components/tunnel-manager'
import { createWebhookReceiver } from './components/webhook-receiver'
import { parseConfig } from './config'
import type { A2ATaskHandler, AgentCard } from './lib/a2a-types'
import { createLogger } from './lib/logger'
import {
  buildFollowUpPrompt,
  buildNewIssuePrompt,
  buildSetupPrompt,
  resolveWebhookAgent,
} from './lib/prompt-builder'
import type { Job } from './lib/types'
import { createServer } from './server'

// ── Bootstrap ───────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  // 0. Load .env.local — try app-level first, then workspace root
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.resolve(__dirname, '..')
  const workspaceRoot = path.resolve(projectRoot, '../..')
  dotenv.config({ path: path.join(projectRoot, '.env.local') })
  dotenv.config({ path: path.join(workspaceRoot, '.env.local') })

  // 1. Parse and validate config from environment
  const config = parseConfig()

  // Capture worker start time for uptime calculation
  const startedAt = new Date()

  // 2. Initialize logger
  const logger = createLogger(config.logLevel)
  const log = logger.child({ component: 'main' })

  log.info('Starting Kiro GitHub Worker (Rocky)')

  // 3. Run auth detection (exit on failure)
  const auth = await detectAuth(config, logger)
  log.info({ mode: auth.mode }, 'Authentication active')

  // 4. Initialize Branch_Map and rebuild from GitHub API
  const branchMap = createBranchMap(auth.botUsername, logger)
  await branchMap.rebuild(auth.octokit, config.allowedRepos)

  // 5. Initialize components
  const repoFilter = createRepoFilter(
    { allowedRepos: config.allowedRepos, deniedRepos: config.deniedRepos },
    logger,
  )

  const eventFilter = createEventFilter(
    { triggerLabels: config.triggerLabels, botUsername: auth.botUsername },
    branchMap,
    logger,
  )

  const repoCloner = createRepoCloner(
    { workingDirBase: config.workingDirBase, setupScriptTimeoutMs: config.setupScriptTimeoutMs },
    logger,
  )

  const kiroExecutor = createKiroExecutor(
    {
      kiroCliPath: config.kiroCliPath,
      kiroApiKey: config.kiroApiKey,
      timeoutMs: config.kiroTimeoutMs,
    },
    logger,
  )

  const copilotExecutor = config.copilotCliPath
    ? createCopilotExecutor(
        {
          copilotCliPath: config.copilotCliPath,
          copilotGithubToken: config.copilotGithubToken,
          timeoutMs: config.kiroTimeoutMs,
        },
        logger,
      )
    : null

  const claudeExecutor = config.claudeCliPath
    ? createClaudeExecutor(
        {
          claudeCliPath: config.claudeCliPath,
          anthropicApiKey: config.anthropicApiKey,
          timeoutMs: config.kiroTimeoutMs,
        },
        logger,
      )
    : null

  const sessionLogWriter = createSessionLogWriter(
    {
      sessionLogDir: config.sessionLogDir,
      sessionLogMaxFiles: config.sessionLogMaxFiles,
      sessionLogMaxAgeHours: config.sessionLogMaxAgeHours,
      sessionLogEnabled: config.sessionLogEnabled,
    },
    logger,
  )

  await sessionLogWriter.ensureDirectory()

  const summarizer = createSummarizer(
    {
      kiroCliPath: config.kiroCliPath,
      kiroApiKey: config.kiroApiKey,
      timeoutMs: 30_000,
    },
    logger,
  )

  const executorRouter = createExecutorRouter(
    { defaultEngine: config.defaultEngine },
    { kiroExecutor, copilotExecutor, claudeExecutor, sessionLogWriter, logger },
  )

  // Initialize Agent Registry (async, non-blocking)
  const agentRegistry = createAgentRegistry({ kiroCliPath: config.kiroCliPath }, logger)

  // Log copilot availability
  if (config.copilotCliPath) {
    log.info(
      { copilotCliPath: config.copilotCliPath, defaultEngine: config.defaultEngine },
      'Copilot CLI configured',
    )
  } else {
    log.debug('Copilot engine not available (COPILOT_CLI_PATH not configured)')
  }

  // Log claude availability
  if (config.claudeCliPath) {
    log.info(
      { claudeCliPath: config.claudeCliPath, defaultEngine: config.defaultEngine },
      'Claude Code CLI configured',
    )
  } else {
    log.debug('Claude engine not available (CLAUDE_CLI_PATH not configured)')
  }

  const prManager = createPRManager({ branchTemplate: config.branchTemplate }, logger)

  const prReviewer = createPRReviewer({
    repoCloner,
    executorRouter,
    sessionLogWriter,
    prManager,
    logger,
    defaultAgent: config.defaultAgent,
  })

  // 5b. Initialize A2A components when enabled
  let a2aRouter: Router | undefined
  let agentCard: AgentCard | undefined
  let a2aTaskHandler: A2ATaskHandler | undefined

  const a2aTaskStore = createA2ATaskStore(logger)

  if (config.a2aEnabled) {
    a2aTaskHandler = createA2ATaskHandler({
      repoCloner,
      executorRouter,
      sessionLogWriter,
      taskStore: a2aTaskStore,
      jobQueue: {},
      authResult: auth,
      config,
      logger,
      summarizer,
    })

    // Simple sequential-per-key queue for A2A tasks
    const a2aQueues = new Map<string, Promise<void>>()
    const enqueueA2AJob = (queueKey: string, jobFn: () => Promise<void>): void => {
      const previous = a2aQueues.get(queueKey) ?? Promise.resolve()
      const next = previous.then(jobFn, jobFn).finally(() => {
        // Clean up the queue entry when the chain completes
        if (a2aQueues.get(queueKey) === next) {
          a2aQueues.delete(queueKey)
        }
      })
      a2aQueues.set(queueKey, next)
    }

    const a2aServer = createA2AServer(
      { a2aPath: config.a2aPath, a2aAuthToken: config.a2aAuthToken },
      {
        taskHandler: a2aTaskHandler,
        taskStore: a2aTaskStore,
        logger,
        enqueueJob: enqueueA2AJob,
      },
    )

    a2aRouter = a2aServer.router
    agentCard = a2aServer.agentCard

    log.info(
      {
        a2aPath: config.a2aPath,
        authEnabled: config.a2aAuthToken != null,
      },
      `A2A endpoint enabled at ${config.a2aPath}`,
    )
  }

  // 5c. Initialize MCP components when enabled
  let mcpRouter: Router | undefined

  const mcpTaskStore = createMCPTaskStore(logger)
  const reviewStore = createReviewStore(logger)

  const mcpTaskHandler = createMCPTaskHandler({
    repoCloner,
    executorRouter,
    sessionLogWriter,
    taskStore: mcpTaskStore,
    jobQueue: {},
    authResult: auth,
    config,
    logger,
    summarizer,
  })

  if (config.mcpEnabled) {
    // Simple sequential-per-key queue for MCP tasks
    const mcpQueues = new Map<string, Promise<void>>()
    const enqueueMCPJob = (queueKey: string, jobFn: () => Promise<void>): void => {
      const previous = mcpQueues.get(queueKey) ?? Promise.resolve()
      const next = previous.then(jobFn, jobFn).finally(() => {
        // Clean up the queue entry when the chain completes
        if (mcpQueues.get(queueKey) === next) {
          mcpQueues.delete(queueKey)
        }
      })
      mcpQueues.set(queueKey, next)
    }

    const mcpServer = createMCPServer(
      { mcpPath: config.mcpPath, mcpAuthToken: config.mcpAuthToken },
      {
        taskHandler: mcpTaskHandler,
        taskStore: mcpTaskStore,
        logger,
        enqueueJob: enqueueMCPJob,
      },
    )

    mcpRouter = mcpServer.router

    log.info(
      {
        mcpPath: config.mcpPath,
        authEnabled: config.mcpAuthToken != null,
      },
      `MCP endpoint enabled at ${config.mcpPath}`,
    )
  }

  // 6. Build the job processor that routes events to the correct handler
  const processJob: JobProcessor = async (job: Job): Promise<void> => {
    const { event } = job
    const jobLog = logger.child({ jobId: job.id, type: event.type, repo: event.repo })

    jobLog.info('Processing job')

    switch (event.type) {
      case 'new_issue': {
        let workingDir: string | undefined
        try {
          const token = await auth.getCloneToken()

          // Clone repository (setup script runs automatically via Repo_Cloner)
          const cloneResult = await repoCloner.cloneForNewIssue(
            event.repo,
            event.issueNumber,
            token,
            auth.octokit,
          )
          workingDir = cloneResult.workingDir

          // Write session log for rocky.sh output so it appears in admin dashboard
          if (cloneResult.setupScriptResult != null) {
            void sessionLogWriter.writeSessionLog(
              {
                success: cloneResult.setupScriptResult.exitCode === 0,
                hasChanges: false,
                stdout: cloneResult.setupScriptResult.stdout,
                stderr: cloneResult.setupScriptResult.stderr,
                exitCode: cloneResult.setupScriptResult.exitCode,
              },
              {
                engine: config.defaultEngine,
                repoFullName: event.repo,
                executionContext: `setup-task-${job.id}`,
              },
            )
          }

          // Run setup execution when no rocky.sh is present
          const rockyShExistsNewIssue = existsSync(path.join(workingDir, 'rocky.sh'))
          if (!rockyShExistsNewIssue) {
            jobLog.info({ repo: event.repo }, 'No rocky.sh found, running setup execution')
            const setupPrompt = buildSetupPrompt()
            const setupResult = await executorRouter.execute(workingDir, setupPrompt, {
              context: {
                engine: config.defaultEngine,
                repoFullName: event.repo,
                executionContext: `setup-task-${job.id}`,
              },
            })
            if (!setupResult.success) {
              jobLog.error({ exitCode: setupResult.exitCode }, 'Setup execution failed')
              await postError(
                auth.octokit,
                event.repo,
                event.issueNumber,
                'setup-script',
                setupResult.stderr || 'Setup execution failed',
              )
              return
            }
            jobLog.info('Setup execution completed successfully')
          } else {
            jobLog.debug('rocky.sh present, skipping setup execution')
          }

          // Record branch in Branch_Map to get the rendered branchName
          const { branchName } = prManager.recordBranch({
            repoFullName: event.repo,
            issueNumber: event.issueNumber,
            issueTitle: event.issueTitle,
            branchMap,
          })

          // Build prompt with branchName and execute Kiro CLI
          const prompt = buildNewIssuePrompt(
            event.issueTitle,
            event.issueBody,
            event.repo,
            event.issueNumber,
            branchName,
          )
          const agent = resolveWebhookAgent(event.issueBody, '', config.defaultAgent)
          const result = await executorRouter.execute(workingDir, prompt, {
            agent,
            context: {
              engine: config.defaultEngine,
              repoFullName: event.repo,
              executionContext: `task-${job.id}`,
            },
          })

          if (!result.success) {
            jobLog.error({ exitCode: result.exitCode }, 'CLI engine failed for new issue')
            await postError(
              auth.octokit,
              event.repo,
              event.issueNumber,
              'kiro-cli',
              result.stderr || 'Kiro CLI failed',
            )
            return
          }

          if (!result.hasChanges) {
            jobLog.info('No changes produced by Kiro CLI')
            await postError(
              auth.octokit,
              event.repo,
              event.issueNumber,
              'kiro-cli',
              'Kiro CLI completed but produced no file changes',
            )
            return
          }

          // Post success comment (PR was created by Kiro CLI)
          await postSuccess(auth.octokit, event.repo, event.issueNumber, `Branch: ${branchName}`)
          jobLog.info({ branchName }, 'New issue processed successfully')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          jobLog.error({ error: message }, 'Failed to process new issue')
          if (!isAlreadyReportedError(error)) {
            try {
              await postError(auth.octokit, event.repo, event.issueNumber, 'processing', message)
            } catch {
              jobLog.warn('Failed to post error comment')
            }
          }
        } finally {
          if (workingDir) {
            await repoCloner.cleanup(workingDir)
          }
        }
        break
      }

      case 'follow_up_comment': {
        // Acknowledge receipt with 👀 reaction
        void addEyesReaction(auth.octokit, event.repo, event.commentId).catch(() => {})

        let workingDir: string | undefined
        try {
          const token = await auth.getCloneToken()

          // Look up existing branch from Branch_Map
          const existingBranch = branchMap.get(event.repo, event.issueNumber)
          if (existingBranch == null) {
            jobLog.warn('No existing branch found for follow-up comment, treating as new issue')
            await postError(
              auth.octokit,
              event.repo,
              event.issueNumber,
              'follow-up',
              'No existing branch found for this issue. Please re-label the issue to trigger a fresh run.',
            )
            return
          }

          // Clone and checkout existing branch (setup script runs automatically via Repo_Cloner)
          const cloneResult = await repoCloner.cloneForFollowUp(
            event.repo,
            event.issueNumber,
            existingBranch,
            token,
            auth.octokit,
          )
          workingDir = cloneResult.workingDir

          // Write session log for rocky.sh output so it appears in admin dashboard
          if (cloneResult.setupScriptResult != null) {
            void sessionLogWriter.writeSessionLog(
              {
                success: cloneResult.setupScriptResult.exitCode === 0,
                hasChanges: false,
                stdout: cloneResult.setupScriptResult.stdout,
                stderr: cloneResult.setupScriptResult.stderr,
                exitCode: cloneResult.setupScriptResult.exitCode,
              },
              {
                engine: config.defaultEngine,
                repoFullName: event.repo,
                executionContext: `setup-task-${job.id}`,
              },
            )
          }

          // Run setup execution when no rocky.sh is present
          const rockyShExistsFollowUp = existsSync(path.join(workingDir, 'rocky.sh'))
          if (!rockyShExistsFollowUp) {
            jobLog.info({ repo: event.repo }, 'No rocky.sh found, running setup execution')
            const setupPrompt = buildSetupPrompt()
            const setupResult = await executorRouter.execute(workingDir, setupPrompt, {
              context: {
                engine: config.defaultEngine,
                repoFullName: event.repo,
                executionContext: `setup-task-${job.id}`,
              },
            })
            if (!setupResult.success) {
              jobLog.error({ exitCode: setupResult.exitCode }, 'Setup execution failed')
              await postError(
                auth.octokit,
                event.repo,
                event.issueNumber,
                'setup-script',
                setupResult.stderr || 'Setup execution failed',
              )
              return
            }
            jobLog.info('Setup execution completed successfully')
          } else {
            jobLog.debug('rocky.sh present, skipping setup execution')
          }

          // Build prompt and execute Kiro CLI
          const prompt = buildFollowUpPrompt(
            event.issueTitle,
            event.issueBody,
            event.commentBody,
            event.repo,
            event.issueNumber,
          )
          const agent = resolveWebhookAgent(event.issueBody, event.commentBody, config.defaultAgent)
          const result = await executorRouter.execute(workingDir, prompt, {
            agent,
            context: {
              engine: config.defaultEngine,
              repoFullName: event.repo,
              executionContext: `task-${job.id}`,
            },
          })

          if (!result.success) {
            jobLog.error({ exitCode: result.exitCode }, 'CLI engine failed for follow-up')
            await postError(
              auth.octokit,
              event.repo,
              event.issueNumber,
              'kiro-cli',
              result.stderr || 'Kiro CLI failed',
            )
            return
          }

          if (!result.hasChanges) {
            jobLog.info('No changes produced by Kiro CLI for follow-up')
            await postError(
              auth.octokit,
              event.repo,
              event.issueNumber,
              'kiro-cli',
              'Kiro CLI completed but produced no file changes',
            )
            return
          }

          // Verify Kiro CLI pushed commits (bookkeeping only — Kiro CLI pushed the changes)
          const hasCommits = await prManager.verifyPushedCommits({
            repoFullName: event.repo,
            branchName: existingBranch,
            workingDir,
          })

          if (!hasCommits) {
            jobLog.warn('verifyPushedCommits returned false after Kiro CLI reported changes')
          }

          // Post updated comment
          await postUpdated(auth.octokit, event.repo, event.issueNumber, existingBranch)
          jobLog.info({ branchName: existingBranch }, 'Follow-up comment processed successfully')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          jobLog.error({ error: message }, 'Failed to process follow-up comment')
          if (!isAlreadyReportedError(error)) {
            try {
              await postError(auth.octokit, event.repo, event.issueNumber, 'processing', message)
            } catch {
              jobLog.warn('Failed to post error comment')
            }
          }
        } finally {
          if (workingDir) {
            await repoCloner.cleanup(workingDir)
          }
        }
        break
      }

      case 'pr_review_comment': {
        // Acknowledge receipt with 👀 reaction
        void addEyesReaction(auth.octokit, event.repo, event.commentId).catch(() => {})

        // Use branchRef from the event payload directly
        const branchName = event.branchRef

        // Fetch issue context for the prompt
        const issueNumber = event.issueNumber ?? 0
        let issueTitle = ''
        let issueBody = ''
        if (issueNumber > 0) {
          try {
            const { owner, repo } = splitRepo(event.repo)
            const { data: issue } = await auth.octokit.issues.get({
              owner,
              repo,
              issue_number: issueNumber,
            })
            issueTitle = issue.title
            issueBody = issue.body ?? ''
          } catch {
            jobLog.warn('Could not fetch issue details for PR review prompt')
          }
        }

        await prReviewer.handleReviewComment({
          octokit: auth.octokit,
          token: await auth.getCloneToken(),
          repoFullName: event.repo,
          prNumber: event.prNumber,
          issueNumber: event.issueNumber,
          commentBody: event.commentBody,
          commentAuthor: '',
          filePath: event.filePath,
          lineContext: event.lineContext,
          branchName,
          issueTitle,
          issueBody,
          botUsername: auth.botUsername,
          jobId: job.id,
        })
        break
      }

      case 'pr_review_changes_requested': {
        const branchName = event.branchRef

        const issueNumber = event.issueNumber ?? 0
        let issueTitle = ''
        let issueBody = ''
        if (issueNumber > 0) {
          try {
            const { owner, repo } = splitRepo(event.repo)
            const { data: issue } = await auth.octokit.issues.get({
              owner,
              repo,
              issue_number: issueNumber,
            })
            issueTitle = issue.title
            issueBody = issue.body ?? ''
          } catch {
            jobLog.warn('Could not fetch issue details for changes requested prompt')
          }
        }

        await prReviewer.handleChangesRequested({
          octokit: auth.octokit,
          token: await auth.getCloneToken(),
          repoFullName: event.repo,
          prNumber: event.prNumber,
          issueNumber: event.issueNumber,
          reviewBody: event.reviewBody,
          reviewAuthor: '',
          reviewComments: event.reviewComments,
          branchName,
          issueTitle,
          issueBody,
          botUsername: auth.botUsername,
          jobId: job.id,
        })
        break
      }

      case 'pr_comment': {
        // Acknowledge receipt with 👀 reaction
        void addEyesReaction(auth.octokit, event.repo, event.commentId).catch(() => {})

        // branchRef may be null for issue_comment on PR — fetch from API
        let branchName = event.branchRef
        if (branchName == null) {
          try {
            const { owner, repo } = splitRepo(event.repo)
            const { data: pr } = await auth.octokit.pulls.get({
              owner,
              repo,
              pull_number: event.prNumber,
            })
            branchName = pr.head.ref
          } catch {
            jobLog.warn('Could not fetch PR details for branch ref')
            return
          }
        }

        const issueNumber = event.issueNumber ?? 0
        let issueTitle = ''
        let issueBody = ''
        if (issueNumber > 0) {
          try {
            const { owner, repo } = splitRepo(event.repo)
            const { data: issue } = await auth.octokit.issues.get({
              owner,
              repo,
              issue_number: issueNumber,
            })
            issueTitle = issue.title
            issueBody = issue.body ?? ''
          } catch {
            jobLog.warn('Could not fetch issue details for PR comment prompt')
          }
        }

        await prReviewer.handlePRComment({
          octokit: auth.octokit,
          token: await auth.getCloneToken(),
          repoFullName: event.repo,
          prNumber: event.prNumber,
          issueNumber: event.issueNumber,
          commentBody: event.commentBody,
          commentAuthor: '',
          branchName,
          issueTitle,
          issueBody,
          botUsername: auth.botUsername,
          jobId: job.id,
        })
        break
      }
    }
  }

  // 7. Initialize Job_Queue with the job processor and queued comment callback
  const jobQueue = createJobQueue(async (job: Job) => {
    await processJob(job)
  }, logger)

  // Wrap enqueue to post queued comments when position > 0
  const originalEnqueue = jobQueue.enqueue.bind(jobQueue)
  const enqueueWithNotification = (event: Job['event']): Job => {
    const job = originalEnqueue(event)

    // Check queue position after enqueue — if > 0, post queued comment
    const position = jobQueue.getQueuePosition(job.queueKey)
    if (position > 0) {
      const issueNumber = getIssueNumberFromEvent(event)
      if (issueNumber != null) {
        void postQueued(auth.octokit, event.repo, issueNumber, position).catch((err: unknown) => {
          log.warn({ err }, 'Failed to post queued comment')
        })
      }
    }

    return job
  }

  // Replace enqueue on the queue instance for the webhook receiver
  const jobQueueWithNotification = {
    ...jobQueue,
    enqueue: enqueueWithNotification,
  }

  // 8. Create webhook receiver and Express server
  const webhookReceiver = createWebhookReceiver(
    { webhookPath: config.webhookPath, webhookSecret: config.githubWebhookSecret },
    {
      repoFilter,
      eventFilter,
      jobQueue: jobQueueWithNotification,
      logger,
    },
  )

  // 8b. Initialize admin API auth middleware and router
  const adminAuthMiddleware = createAdminAuthMiddleware(
    { adminApiToken: config.adminApiToken },
    logger,
  )

  // Simple sequential-per-key queue for admin-created tasks
  const adminQueues = new Map<string, Promise<void>>()
  const enqueueAdminJob = (queueKey: string, jobFn: () => Promise<void>): void => {
    const previous = adminQueues.get(queueKey) ?? Promise.resolve()
    const next = previous.then(jobFn, jobFn).finally(() => {
      if (adminQueues.get(queueKey) === next) {
        adminQueues.delete(queueKey)
      }
    })
    adminQueues.set(queueKey, next)
  }

  const adminRouter = createAdminApiRouter(
    { adminApiToken: config.adminApiToken },
    {
      a2aTaskStore,
      mcpTaskStore,
      jobQueue,
      sessionLogDir: config.sessionLogDir,
      logger,
      startedAt,
      mcpTaskHandler,
      a2aTaskHandler,
      config,
      authResult: auth,
      agentRegistry,
      enqueueJob: enqueueAdminJob,
    },
  )

  const reviewRouter = createReviewApiRouter({ reviewStore, logger })

  const app = createServer({
    webhookReceiver,
    webhookPath: config.webhookPath,
    logger,
    a2aRouter,
    agentCard,
    mcpRouter,
    adminAuthMiddleware,
    adminRouter,
    reviewRouter,
  })

  // 9. Start tunnel manager in dev mode
  let tunnelManager: TunnelManagerInstance | null = null
  if (process.env['NODE_ENV'] !== 'production') {
    tunnelManager = createTunnelManager({ port: config.port }, logger)
    try {
      const tunnelUrl = await tunnelManager.start()
      if (tunnelUrl) {
        log.info({ tunnelUrl }, 'Development tunnel established')

        // Auto-update GitHub App webhook URL in dev mode using JWT auth.
        if (auth.mode === 'github-app' && config.githubAppId && config.githubAppPrivateKey) {
          const webhookUrl = `${tunnelUrl}${config.webhookPath}`
          try {
            // Manually generate JWT for App-level API calls
            const { createAppAuth } = await import('@octokit/auth-app')
            const appAuth = createAppAuth({
              appId: config.githubAppId,
              privateKey: config.githubAppPrivateKey,
            })
            const { token: jwt } = await appAuth({ type: 'app' })

            const response = await fetch('https://api.github.com/app/hook/config', {
              method: 'PATCH',
              headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${jwt}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url: webhookUrl }),
            })
            if (response.ok) {
              log.info({ webhookUrl }, 'Updated GitHub App webhook URL')
            } else {
              const body = await response.text()
              log.warn({ status: response.status, body }, 'Failed to update webhook URL via API')
            }
          } catch (err) {
            log.warn({ err }, 'Failed to update GitHub App webhook URL (update manually)')
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to start development tunnel (continuing without tunnel)')
      tunnelManager = null
    }
  }

  // 10. Start HTTP server
  const server: http.Server = app.listen(config.port, () => {
    log.info(
      {
        authMode: auth.mode,
        port: config.port,
        webhookPath: config.webhookPath,
        triggerLabels: config.triggerLabels,
        botUsername: auth.botUsername,
      },
      `Rocky is listening on port ${String(config.port)}`,
    )
  })

  // 11. Register graceful shutdown handlers
  const shutdown = (signal: string): void => {
    log.info({ signal }, 'Shutdown signal received, cleaning up…')

    // Close tunnel
    if (tunnelManager) {
      tunnelManager.stop()
    }

    // Close HTTP server
    server.close(() => {
      log.info('HTTP server closed')
      process.exit(0)
    })

    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Splits a repository full name (e.g. `owner/repo`) into its owner and
 * repo components for use with the Octokit API.
 */
const splitRepo = (repoFullName: string): { owner: string; repo: string } => {
  const slashIdx = repoFullName.indexOf('/')
  return {
    owner: repoFullName.slice(0, slashIdx),
    repo: repoFullName.slice(slashIdx + 1),
  }
}

/**
 * Extracts the issue number from a FilteredEvent for posting queued comments.
 */
const getIssueNumberFromEvent = (event: Job['event']): number | null => {
  switch (event.type) {
    case 'new_issue':
    case 'follow_up_comment':
      return event.issueNumber
    case 'pr_review_comment':
    case 'pr_review_changes_requested':
    case 'pr_comment':
      return event.issueNumber ?? event.prNumber
  }
}

// ── Run ─────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})
