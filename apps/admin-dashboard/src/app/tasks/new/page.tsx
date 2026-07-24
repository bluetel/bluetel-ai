'use client'

import { useAuth } from '@admin-dashboard/hooks'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

interface FormData {
  repoUrl: string
  baseBranch: string
  prompt: string
  installScript: string
  engine: 'kiro' | 'copilot' | 'claude'
  agent: string
}

interface FormErrors {
  repoUrl?: string
  baseBranch?: string
  prompt?: string
}

interface CreateTaskResponse {
  id: string
}

interface ErrorResponse {
  error?: string
  message?: string
}

interface AgentOption {
  name: string
  scope: string
  description: string
  isDefault: boolean
}

const REPO_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+(\.git)?$/

// eslint-disable-next-line no-control-regex
const BRANCH_INVALID_PATTERN = /[\s\x00-\x1f]/

const validateForm = (data: FormData): FormErrors => {
  const errors: FormErrors = {}

  if (!data.repoUrl.trim()) {
    errors.repoUrl = 'Repository URL is required'
  } else if (!REPO_URL_PATTERN.test(data.repoUrl.trim())) {
    errors.repoUrl = 'Must be a valid GitHub URL (https://github.com/{owner}/{repo})'
  }

  if (!data.baseBranch.trim()) {
    errors.baseBranch = 'Base branch is required'
  } else if (BRANCH_INVALID_PATTERN.test(data.baseBranch)) {
    errors.baseBranch = 'Branch name must not contain spaces or control characters'
  }

  if (!data.prompt.trim()) {
    errors.prompt = 'Prompt is required'
  }

  return errors
}

export default function NewTaskPage() {
  const router = useRouter()
  const { token } = useAuth()

  const [formData, setFormData] = useState<FormData>({
    repoUrl: '',
    baseBranch: '',
    prompt: '',
    installScript: '',
    engine: 'kiro',
    agent: '',
  })

  const [errors, setErrors] = useState<FormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [agentsError, setAgentsError] = useState(false)

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const headers: Record<string, string> = {}
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch('/api/agents', { headers })
        if (!res.ok) {
          setAgentsError(true)
          return
        }
        const data = (await res.json()) as { agents: AgentOption[] }
        setAgents(data.agents)
      } catch {
        setAgentsError(true)
      }
    }
    void fetchAgents()
  }, [token])

  const handleChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    // Clear field error on change
    if (field in errors) {
      setErrors((prev) => {
        const next = { ...prev }
        if (field === 'repoUrl') delete next.repoUrl
        else if (field === 'baseBranch') delete next.baseBranch
        else if (field === 'prompt') delete next.prompt
        return next
      })
    }
  }

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setServerError(null)

    const validationErrors = validateForm(formData)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setErrors({})
    setIsSubmitting(true)

    try {
      const body: Record<string, string> = {
        repoUrl: formData.repoUrl.trim(),
        baseBranch: formData.baseBranch.trim(),
        prompt: formData.prompt.trim(),
      }

      if (formData.installScript.trim()) {
        body.installScript = formData.installScript.trim()
      }

      body.engine = formData.engine

      if (formData.agent) {
        body.agent = formData.agent
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (response.status === 201) {
        const data = (await response.json()) as CreateTaskResponse
        router.push(`/tasks?id=${data.id}`)
        return
      }

      const errorData = (await response.json().catch(() => null)) as ErrorResponse | null
      const message = errorData?.error ?? errorData?.message ?? `Server error (${response.status})`
      setServerError(message)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif', maxWidth: '640px' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>New Task</h1>

      {serverError && (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            marginBottom: '1rem',
            color: '#c00',
          }}
        >
          {serverError}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)}>
        {/* Repository URL */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="repoUrl"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Repository URL <span style={{ color: '#c00' }}>*</span>
          </label>
          <input
            id="repoUrl"
            type="text"
            value={formData.repoUrl}
            onChange={(e) => handleChange('repoUrl', e.target.value)}
            placeholder="https://github.com/owner/repo"
            style={{
              width: '100%',
              padding: '0.5rem',
              border: errors.repoUrl ? '1px solid #c00' : '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              boxSizing: 'border-box',
            }}
          />
          {errors.repoUrl && (
            <p style={{ color: '#c00', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
              {errors.repoUrl}
            </p>
          )}
        </div>

        {/* Base Branch */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="baseBranch"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Base Branch <span style={{ color: '#c00' }}>*</span>
          </label>
          <input
            id="baseBranch"
            type="text"
            value={formData.baseBranch}
            onChange={(e) => handleChange('baseBranch', e.target.value)}
            placeholder="main"
            style={{
              width: '100%',
              padding: '0.5rem',
              border: errors.baseBranch ? '1px solid #c00' : '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              boxSizing: 'border-box',
            }}
          />
          {errors.baseBranch && (
            <p style={{ color: '#c00', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
              {errors.baseBranch}
            </p>
          )}
        </div>

        {/* Prompt */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="prompt"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Prompt <span style={{ color: '#c00' }}>*</span>
          </label>
          <textarea
            id="prompt"
            value={formData.prompt}
            onChange={(e) => handleChange('prompt', e.target.value)}
            placeholder="Describe the task to execute..."
            rows={5}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: errors.prompt ? '1px solid #c00' : '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          {errors.prompt && (
            <p style={{ color: '#c00', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
              {errors.prompt}
            </p>
          )}
        </div>

        {/* Install Script */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="installScript"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Install Script <span style={{ color: '#888', fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            id="installScript"
            value={formData.installScript}
            onChange={(e) => handleChange('installScript', e.target.value)}
            placeholder="npm install"
            rows={3}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Engine */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="engine"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Engine <span style={{ color: '#888', fontWeight: 400 }}>(optional)</span>
          </label>
          <select
            id="engine"
            value={formData.engine}
            onChange={(e) => handleChange('engine', e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              boxSizing: 'border-box',
            }}
          >
            <option value="kiro">kiro</option>
            <option value="copilot">copilot</option>
            <option value="claude">claude</option>
          </select>
        </div>

        {/* Agent */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="agent"
            style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}
          >
            Agent <span style={{ color: '#888', fontWeight: 400 }}>(optional)</span>
          </label>
          <select
            id="agent"
            value={formData.agent}
            onChange={(e) => handleChange('agent', e.target.value)}
            disabled={agentsError}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '0.9rem',
              boxSizing: 'border-box',
              opacity: agentsError ? 0.6 : 1,
            }}
          >
            {agentsError ? (
              <option value="">Unable to load agents</option>
            ) : (
              <>
                <option value="">Default (no override)</option>
                {[...agents]
                  .sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1))
                  .map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name} ({agent.scope}){agent.isDefault ? ' (Default)' : ''}
                    </option>
                  ))}
              </>
            )}
          </select>
          {formData.agent &&
            (() => {
              const selected = agents.find((a) => a.name === formData.agent)
              return selected?.description ? (
                <p style={{ color: '#888', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
                  {selected.description}
                </p>
              ) : null
            })()}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: '0.5rem 1.25rem',
              backgroundColor: isSubmitting ? '#999' : '#0070f3',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '0.9rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            {isSubmitting ? 'Creating...' : 'Create Task'}
          </button>
          <Link
            href="/tasks"
            style={{
              padding: '0.5rem 1.25rem',
              color: '#666',
              textDecoration: 'none',
              fontSize: '0.9rem',
            }}
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  )
}
