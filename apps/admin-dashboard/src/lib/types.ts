export type TaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

export interface TaskInput {
  repoUrl: string
  baseBranch: string
  prompt: string
  installScript?: string
  engine?: 'kiro' | 'copilot' | 'claude'
  agent?: string
}

export interface TaskArtifact {
  type: string
  value: string
}

export interface UnifiedTask {
  id: string
  protocol: 'a2a' | 'mcp' | 'manual' | 'webhook'
  status: TaskStatus
  repoFullName: string
  queueKey: string
  input: TaskInput
  artifacts: TaskArtifact[]
  error?: { step: string; message: string }
  promptSummary: string | null
  resultSummary: string | null
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  completedAt: string | null
}

export interface TaskFilters {
  status?: TaskStatus[]
  protocol?: ('a2a' | 'mcp' | 'manual' | 'webhook')[]
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export type ReviewDecision = 'approved' | 'rejected'

export interface Review {
  id: string
  status: ReviewStatus
  title: string
  content: string
  context: string | null
  repoFullName: string | null
  branch: string | null
  iteration: number | null
  metadata: Record<string, string>
  decision: ReviewDecision | null
  comment: string
  reviewer: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  decidedAt: string | null
  expiresAt: string | null
}
