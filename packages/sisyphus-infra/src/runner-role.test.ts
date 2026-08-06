import { describe, expect, it } from 'vitest'

import {
  buildRunnerPolicy,
  buildRunnerRoleSpecification,
  buildRunnerTrustPolicy,
  createRunnerRole,
  type RunnerRoleConfig,
} from './runner-role'

const config: RunnerRoleConfig = {
  scope: { project: 'sisyphus', stack: 'staging' },
  bucketNames: {
    artifacts: 'sisyphus-staging-artifacts',
    bundles: 'sisyphus-staging-bundles',
    logs: 'sisyphus-staging-logs',
    snapshots: 'sisyphus-staging-snapshots',
  },
  workflowId: 'wf_01H8',
}

const allActions = (): string[] => buildRunnerPolicy(config).Statement.flatMap((s) => [...s.Action])

describe('buildRunnerTrustPolicy', () => {
  it('is assumable only by the EC2 service', () => {
    const policy = buildRunnerTrustPolicy()

    expect(policy.Statement[0]?.Principal?.Service).toEqual(['ec2.amazonaws.com'])
    expect(policy.Statement[0]?.Principal?.Federated).toBeUndefined()
    expect(policy.Statement[0]?.Action).toEqual(['sts:AssumeRole'])
  })
})

describe('buildRunnerPolicy — what the executor may do', () => {
  const policy = buildRunnerPolicy(config)

  it('reads the setup bundle archive', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'ReadSetupBundleArchive')

    expect(statement?.Action).toEqual(['s3:GetObject'])
    expect(statement?.Resource).toEqual(['arn:aws:s3:::sisyphus-staging-bundles/*'])
  })

  it('writes logs and artifacts only under its own workflow partition', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'WriteOwnLogsAndArtifacts')

    expect(statement?.Resource).toEqual([
      'arn:aws:s3:::sisyphus-staging-logs/workflow/wf_01H8/*',
      'arn:aws:s3:::sisyphus-staging-artifacts/workflow/wf_01H8/*',
    ])
  })

  it('cannot read another workflow’s objects', () => {
    const other = buildRunnerPolicy({ ...config, workflowId: 'wf_other' })
    const resources = other.Statement.flatMap((statement) => statement.Resource ?? [])

    expect(resources.some((resource) => resource.includes('wf_01H8'))).toBe(false)
  })

  it('reads and writes only its own snapshots', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'ReadWriteOwnSnapshots')

    expect(statement?.Resource).toEqual([
      'arn:aws:s3:::sisyphus-staging-snapshots/workflow/wf_01H8/*',
    ])
  })

  it('holds a Session Manager channel for operator access', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'SessionManagerChannel')

    expect(statement?.Action).toContain('ssmmessages:OpenDataChannel')
  })

  it('grants nothing outside the four scoped statements', () => {
    expect(policy.Statement).toHaveLength(4)
    expect(policy.Statement.every((statement) => statement.Effect === 'Allow')).toBe(true)
  })
})

describe('buildRunnerPolicy — what the executor must never do', () => {
  it('cannot reach the database', () => {
    for (const action of allActions()) {
      expect(action.startsWith('rds')).toBe(false)
    }
  })

  it('cannot read secrets or parameters, because the envelope carries its credential', () => {
    for (const action of allActions()) {
      expect(action.startsWith('secretsmanager:')).toBe(false)
      expect(action.startsWith('ssm:')).toBe(false)
      expect(action.startsWith('kms:')).toBe(false)
    }
  })

  it('cannot terminate or launch instances — teardown belongs to the control plane', () => {
    for (const action of allActions()) {
      expect(action.startsWith('ec2:')).toBe(false)
      expect(action.startsWith('iam:')).toBe(false)
      expect(action.startsWith('sts:')).toBe(false)
    }
  })

  it('has no wildcard action and no wildcard S3 resource', () => {
    for (const action of allActions()) {
      expect(action).not.toBe('*')
      expect(action.endsWith(':*')).toBe(false)
    }

    const s3Resources = buildRunnerPolicy(config)
      .Statement.flatMap((statement) => statement.Resource ?? [])
      .filter((resource) => resource.startsWith('arn:aws:s3:::'))

    for (const resource of s3Resources) {
      expect(resource).not.toBe('arn:aws:s3:::*')
    }
  })

  it('cannot list bucket contents, so it cannot enumerate other workflows', () => {
    expect(allActions()).not.toContain('s3:ListBucket')
  })

  it('cannot delete durable objects — retention is the lifecycle policy’s job', () => {
    for (const action of allActions()) {
      expect(action.startsWith('s3:Delete')).toBe(false)
    }
  })
})

describe('buildRunnerRoleSpecification', () => {
  it('names the role, policy and instance profile under the stage scope', () => {
    const specification = buildRunnerRoleSpecification(config)

    expect(specification.roleName).toBe('sisyphus-staging-executor-runner')
    expect(specification.instanceProfileName).toBe('sisyphus-staging-executor-runner-profile')
    expect(specification.policyName).toBe('sisyphus-staging-executor-runner-policy')
  })
})

describe('createRunnerRole', () => {
  it('attaches the policy and the instance profile to the created role', () => {
    const created = createRunnerRole(
      {
        createRole: (name) => ({ kind: 'role' as const, name }),
        createRolePolicy: (name, args) => ({ kind: 'policy' as const, name, role: args.role.name }),
        createInstanceProfile: (name, args) => ({
          kind: 'profile' as const,
          name,
          role: args.role.name,
        }),
      },
      config,
    )

    expect(created.rolePolicy.role).toBe('sisyphus-staging-executor-runner')
    expect(created.instanceProfile.role).toBe('sisyphus-staging-executor-runner')
    expect(created.specification.policy.Statement).toHaveLength(4)
  })
})
