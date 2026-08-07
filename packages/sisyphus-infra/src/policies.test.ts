import { describe, expect, it } from 'vitest'

import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_CLAIM_PREFIX,
  GITHUB_OIDC_ISSUER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  buildDeployRoleTrustPolicy,
  buildRunnerPolicy,
  buildRunnerTrustPolicy,
  getDeployBranchRef,
  getTrustedSubject,
  type RunnerPolicyConfig,
} from './policies'
import { DEPLOY_STAGES } from './sst-app'

const githubRepo = 'bluetel/universal-react-monorepo'

const runnerConfig: RunnerPolicyConfig = {
  bucketNames: {
    artifacts: 'sisyphus-staging-artifacts',
    bundles: 'sisyphus-staging-bundles',
    logs: 'sisyphus-staging-logs',
    snapshots: 'sisyphus-staging-snapshots',
  },
  workflowId: 'wf_01H8',
}

const runnerActions = (config: RunnerPolicyConfig = runnerConfig): string[] =>
  buildRunnerPolicy(config).Statement.flatMap((statement) => [...statement.Action])

describe('the GitHub OIDC identity', () => {
  it('federates the GitHub Actions issuer', () => {
    expect(GITHUB_OIDC_ISSUER_URL).toBe('https://token.actions.githubusercontent.com')
  })

  it('registers the issuer for the STS audience alone', () => {
    expect(GITHUB_OIDC_AUDIENCE).toBe('sts.amazonaws.com')
  })

  it('reads the token claims from the issuer namespace AWS exposes them under', () => {
    expect(GITHUB_OIDC_CLAIM_PREFIX).toBe('token.actions.githubusercontent.com')
    expect(GITHUB_OIDC_ISSUER_URL).toContain(GITHUB_OIDC_CLAIM_PREFIX)
  })

  it('supplies the thumbprints creation still requires', () => {
    expect(GITHUB_OIDC_THUMBPRINTS.length).toBeGreaterThan(0)
  })
})

describe('getDeployBranchRef', () => {
  it('maps production to main and staging to staging', () => {
    expect(getDeployBranchRef('production')).toBe('refs/heads/main')
    expect(getDeployBranchRef('staging')).toBe('refs/heads/staging')
  })

  it('gives a personal stage no CI branch at all', () => {
    expect(getDeployBranchRef('dev-harry')).toBeUndefined()
    expect(getDeployBranchRef('')).toBeUndefined()
  })

  it('gives every stage CI deploys a protected branch, and no other stage one', () => {
    for (const stage of DEPLOY_STAGES) {
      expect(getDeployBranchRef(stage)).toMatch(/^refs\/heads\//)
    }

    expect(getDeployBranchRef('production-bootstrap')).toBeUndefined()
  })
})

describe('getTrustedSubject', () => {
  it('builds the production subject exactly as GitHub emits it', () => {
    expect(getTrustedSubject(githubRepo, 'production')).toBe(
      'repo:bluetel/universal-react-monorepo:ref:refs/heads/main',
    )
  })

  it('builds the staging subject exactly as GitHub emits it', () => {
    expect(getTrustedSubject(githubRepo, 'staging')).toBe(
      'repo:bluetel/universal-react-monorepo:ref:refs/heads/staging',
    )
  })

  it('never emits a wildcard', () => {
    for (const stage of DEPLOY_STAGES) {
      expect(getTrustedSubject(githubRepo, stage)).not.toContain('*')
    }
  })

  it('refuses to issue a subject for a stage with no protected branch', () => {
    expect(() => getTrustedSubject(githubRepo, 'dev-harry')).toThrow(
      'has no protected deploy branch',
    )
  })
})

describe('buildDeployRoleTrustPolicy', () => {
  const policy = buildDeployRoleTrustPolicy({
    oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
    githubRepo,
    stage: 'production',
  })

  it('federates the supplied provider for web-identity assumption only', () => {
    expect(policy.Statement[0]?.Principal?.Federated).toEqual([
      'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
    ])
    expect(policy.Statement[0]?.Action).toEqual(['sts:AssumeRoleWithWebIdentity'])
  })

  it('pins the audience to STS', () => {
    expect(
      policy.Statement[0]?.Condition?.StringEquals?.['token.actions.githubusercontent.com:aud'],
    ).toEqual([GITHUB_OIDC_AUDIENCE])
  })

  it('conditions on the exact sub claim, so IAM enforces the protected branch', () => {
    expect(
      policy.Statement[0]?.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub'],
    ).toEqual(['repo:bluetel/universal-react-monorepo:ref:refs/heads/main'])
  })

  it('uses StringEquals rather than StringLike, so no wildcard can widen it', () => {
    expect(Object.keys(policy.Statement[0]?.Condition ?? {})).toEqual(['StringEquals'])
    expect(policy.Statement[0]?.Condition?.StringLike).toBeUndefined()
  })

  it('gives staging a different subject from production', () => {
    const staging = buildDeployRoleTrustPolicy({
      oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/x',
      githubRepo,
      stage: 'staging',
    })

    expect(
      staging.Statement[0]?.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub'],
    ).toEqual(['repo:bluetel/universal-react-monorepo:ref:refs/heads/staging'])
  })

  it('refuses to issue a trust policy for a stage CI does not deploy', () => {
    expect(() =>
      buildDeployRoleTrustPolicy({
        oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/x',
        githubRepo,
        stage: 'dev-harry',
      }),
    ).toThrow('has no protected deploy branch')
  })
})

describe('buildRunnerTrustPolicy', () => {
  it('is assumable only by the EC2 service', () => {
    const policy = buildRunnerTrustPolicy()

    expect(policy.Statement[0]?.Principal?.Service).toEqual(['ec2.amazonaws.com'])
    expect(policy.Statement[0]?.Principal?.Federated).toBeUndefined()
    expect(policy.Statement[0]?.Action).toEqual(['sts:AssumeRole'])
  })
})

describe('buildRunnerPolicy — what the executor may do', () => {
  const policy = buildRunnerPolicy(runnerConfig)

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
    const other = buildRunnerPolicy({ ...runnerConfig, workflowId: 'wf_other' })
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
    for (const action of runnerActions()) {
      expect(action.startsWith('rds')).toBe(false)
    }
  })

  it('cannot read secrets or parameters, because the envelope carries its credential', () => {
    for (const action of runnerActions()) {
      expect(action.startsWith('secretsmanager:')).toBe(false)
      expect(action.startsWith('ssm:')).toBe(false)
      expect(action.startsWith('kms:')).toBe(false)
    }
  })

  it('cannot terminate or launch instances — teardown belongs to the control plane', () => {
    for (const action of runnerActions()) {
      expect(action.startsWith('ec2:')).toBe(false)
      expect(action.startsWith('iam:')).toBe(false)
      expect(action.startsWith('sts:')).toBe(false)
    }
  })

  it('has no wildcard action and no wildcard S3 resource', () => {
    for (const action of runnerActions()) {
      expect(action).not.toBe('*')
      expect(action.endsWith(':*')).toBe(false)
    }

    const s3Resources = buildRunnerPolicy(runnerConfig)
      .Statement.flatMap((statement) => statement.Resource ?? [])
      .filter((resource) => resource.startsWith('arn:aws:s3:::'))

    for (const resource of s3Resources) {
      expect(resource).not.toBe('arn:aws:s3:::*')
    }
  })

  it('cannot list bucket contents, so it cannot enumerate other workflows', () => {
    expect(runnerActions()).not.toContain('s3:ListBucket')
  })

  it('cannot delete durable objects — retention is the lifecycle policy’s job', () => {
    for (const action of runnerActions()) {
      expect(action.startsWith('s3:Delete')).toBe(false)
    }
  })

  it('refuses a policy with no workflow to scope its grants to', () => {
    expect(() => buildRunnerPolicy({ ...runnerConfig, workflowId: '' })).toThrow(
      'empty workflow id',
    )
  })
})
