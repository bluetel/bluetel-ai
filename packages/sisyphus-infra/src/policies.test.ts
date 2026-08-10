import { describe, expect, it } from 'vitest'

import { getAgentCredentialSecretPrefix, getStackScope } from './lib'
import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_CLAIM_PREFIX,
  GITHUB_OIDC_ISSUER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  buildControlPlanePolicy,
  buildDeployRoleTrustPolicy,
  buildPanelBundlesPolicy,
  buildPanelPolicy,
  buildRunnerPolicy,
  buildRunnerTrustPolicy,
  getDeployBranchRef,
  getTrustedSubject,
  type ControlPlanePolicyConfig,
  type PanelBundlesPolicyConfig,
  type PanelPolicyConfig,
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

const controlPlaneConfig: ControlPlanePolicyConfig = {
  region: 'eu-west-2',
  accountId: '429776178057',
  executorRunnerRoleArn: 'arn:aws:iam::429776178057:role/sisyphus-staging-executor-runner',
  agentCredentialSecretPrefix: getAgentCredentialSecretPrefix(getStackScope('staging')),
}

const panelBundlesConfig: PanelBundlesPolicyConfig = {
  region: 'eu-west-2',
  accountId: '429776178057',
  bundlesBucketName: 'sisyphus-staging-bundles',
}

const panelConfig: PanelPolicyConfig = {
  ...panelBundlesConfig,
  // The same helper the control-plane config above uses, and deliberately so — see the suite.
  agentCredentialSecretPrefix: getAgentCredentialSecretPrefix(getStackScope('staging')),
}

const controlPlaneActions = (config: ControlPlanePolicyConfig = controlPlaneConfig): string[] =>
  buildControlPlanePolicy(config).Statement.flatMap((statement) => [...statement.Action])

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
    expect(getDeployBranchRef('local')).toBeUndefined()
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
    expect(() => getTrustedSubject(githubRepo, 'local')).toThrow('has no protected deploy branch')
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
        stage: 'local',
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

  it('refuses an empty workflow id rather than treating it as deliberately fleet-wide', () => {
    expect(() => buildRunnerPolicy({ ...runnerConfig, workflowId: '' })).toThrow(
      'empty workflow id',
    )
  })
})

describe('buildRunnerPolicy — the fleet-wide profile, when no workflow id is given', () => {
  const fleetWideConfig: RunnerPolicyConfig = { bucketNames: runnerConfig.bucketNames }
  const policy = buildRunnerPolicy(fleetWideConfig)

  it('grants the whole bucket rather than a workflow partition', () => {
    const logsAndArtifacts = policy.Statement.find(
      (entry) => entry.Sid === 'WriteOwnLogsAndArtifacts',
    )
    const snapshots = policy.Statement.find((entry) => entry.Sid === 'ReadWriteOwnSnapshots')

    expect(logsAndArtifacts?.Resource).toEqual([
      'arn:aws:s3:::sisyphus-staging-logs/*',
      'arn:aws:s3:::sisyphus-staging-artifacts/*',
    ])
    expect(snapshots?.Resource).toEqual(['arn:aws:s3:::sisyphus-staging-snapshots/*'])
  })

  it('is otherwise the same document — bundle read and the Session Manager channel unaffected', () => {
    const bundles = policy.Statement.find((entry) => entry.Sid === 'ReadSetupBundleArchive')
    const sessionManager = policy.Statement.find((entry) => entry.Sid === 'SessionManagerChannel')

    expect(bundles?.Resource).toEqual(['arn:aws:s3:::sisyphus-staging-bundles/*'])
    expect(sessionManager?.Action).toContain('ssmmessages:OpenDataChannel')
  })

  it('still refuses an explicit empty string, distinguishing it from an omitted id', () => {
    expect(() => buildRunnerPolicy({ ...fleetWideConfig, workflowId: '' })).toThrow(
      'empty workflow id',
    )
  })
})

describe('buildPanelBundlesPolicy', () => {
  const policy = buildPanelBundlesPolicy(panelBundlesConfig)

  it('registers an archive into the bundles bucket and nothing else', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'RegisterSetupBundleArchive')

    expect(statement?.Action).toEqual(['s3:PutObject'])
    expect(statement?.Resource).toEqual(['arn:aws:s3:::sisyphus-staging-bundles/*'])
  })

  it('encrypts under the managed key the upload path asks for, not every key in the account', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'EncryptSetupBundleArchive')

    expect(statement?.Action).toEqual(['kms:GenerateDataKey'])
    expect(statement?.Resource).toEqual(['arn:aws:kms:eu-west-2:429776178057:alias/aws/s3'])
  })

  it('cannot read a bundle back — validation and executor boot read through the runner role', () => {
    const actions = policy.Statement.flatMap((statement) => [...statement.Action])

    expect(actions).not.toContain('s3:GetObject')
    expect(actions).not.toContain('s3:DeleteObject')
    expect(policy.Statement).toHaveLength(2)
  })
})

describe('buildPanelPolicy — the whole of what the panel’s server function may do', () => {
  const policy = buildPanelPolicy(panelConfig)

  it('carries the bundles grants unchanged, so the two builders cannot drift', () => {
    // Composed rather than restated. Asserted by equality against the other builder's output so
    // that adding a bundles statement there cannot silently leave the panel's real policy behind.
    const bundles = buildPanelBundlesPolicy(panelBundlesConfig).Statement

    expect(policy.Statement.slice(0, bundles.length)).toEqual(bundles)
  })

  it('reads and writes agent credential material, scoped to this stage’s prefix (003/FR-012)', () => {
    const statement = policy.Statement.find(
      (entry) => entry.Sid === 'ReadAndWriteAgentCredentialMaterial',
    )

    expect(statement?.Action).toEqual([
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
    ])
    expect(statement?.Resource).toEqual([
      'arn:aws:secretsmanager:eu-west-2:429776178057:secret:sisyphus/staging/agent-credential/*',
    ])
  })

  it('is scoped to the same prefix the control plane writes under', () => {
    // The control plane creates the secret and the panel's machine surface reads it back. Two
    // prefixes would be two different secrets, and the failure would be a boot-time authorisation
    // error against a name nothing had ever written.
    const panelResources = policy.Statement.filter((entry) =>
      entry.Action.some((action) => action.startsWith('secretsmanager:')),
    ).flatMap((entry) => [...(entry.Resource ?? [])])
    const controlPlaneResources = buildControlPlanePolicy(controlPlaneConfig)
      .Statement.filter((entry) =>
        entry.Action.some((action) => action.startsWith('secretsmanager:')),
      )
      .flatMap((entry) => [...(entry.Resource ?? [])])

    expect(panelResources).toEqual(controlPlaneResources)
  })

  it.each([
    'secretsmanager:CreateSecret',
    'secretsmanager:DeleteSecret',
    'secretsmanager:ListSecrets',
    'secretsmanager:UpdateSecret',
  ])('does not grant %s', (action) => {
    // Each for its own reason — see the builder. `ListSecrets` is the one that matters most:
    // it takes no resource-level permission, so granting it would defeat the ARN scoping above
    // entirely rather than merely widening it.
    expect(policy.Statement.flatMap((entry) => [...entry.Action])).not.toContain(action)
  })

  it('never scopes a secret grant to a wildcard', () => {
    const resources = policy.Statement.flatMap((entry) => [...(entry.Resource ?? [])])

    expect(resources).not.toContain('*')
    expect(resources.every((resource) => resource.startsWith('arn:aws:'))).toBe(true)
  })

  it('refuses an empty prefix rather than widening to every secret in the account', () => {
    expect(() => buildPanelPolicy({ ...panelConfig, agentCredentialSecretPrefix: '   ' })).toThrow(
      'empty agent credential prefix',
    )
  })
})

describe('buildControlPlanePolicy — what the control plane may do', () => {
  const policy = buildControlPlanePolicy(controlPlaneConfig)

  it('can enumerate the fleet, with the wildcard resource DescribeInstances requires', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'ReconcileFleetVisibility')

    expect(statement?.Action).toEqual(['ec2:DescribeInstances'])
    expect(statement?.Resource).toEqual(['*'])
  })

  it('can launch and terminate instances scoped to its own account and region', () => {
    const statement = policy.Statement.find(
      (entry) => entry.Sid === 'LaunchAndTerminateExecutorInstances',
    )

    expect(statement?.Action).toEqual([
      'ec2:RunInstances',
      'ec2:TerminateInstances',
      'ec2:CreateTags',
    ])
    expect(statement?.Resource).toEqual(['arn:aws:ec2:eu-west-2:429776178057:instance/*'])
  })

  it('grants RunInstances the dependent resources it also needs permission on', () => {
    const statement = policy.Statement.find(
      (entry) => entry.Sid === 'RunInstancesResourceDependencies',
    )

    expect(statement?.Action).toEqual(['ec2:RunInstances'])
    expect(statement?.Resource).toEqual([
      'arn:aws:ec2:eu-west-2::image/*',
      'arn:aws:ec2:eu-west-2:429776178057:subnet/*',
      'arn:aws:ec2:eu-west-2:429776178057:network-interface/*',
      'arn:aws:ec2:eu-west-2:429776178057:security-group/*',
      'arn:aws:ec2:eu-west-2:429776178057:volume/*',
    ])
  })

  it('may pass exactly the executor runner role, and no other', () => {
    const statement = policy.Statement.find(
      (entry) => entry.Sid === 'PassExecutorRunnerRoleToLaunchedInstances',
    )

    expect(statement?.Action).toEqual(['iam:PassRole'])
    expect(statement?.Resource).toEqual([controlPlaneConfig.executorRunnerRoleArn])
  })

  it('scopes every EC2 resource ARN to the region and account supplied, not another stage’s', () => {
    const other = buildControlPlanePolicy({
      region: 'us-east-1',
      accountId: '111111111111',
      executorRunnerRoleArn: 'arn:aws:iam::111111111111:role/sisyphus-other-executor-runner',
      agentCredentialSecretPrefix: getAgentCredentialSecretPrefix(getStackScope('production')),
    })
    const ec2Resources = other.Statement.filter(
      (statement) => statement.Sid !== 'PassExecutorRunnerRoleToLaunchedInstances',
    )
      .flatMap((statement) => statement.Resource ?? [])
      .filter((resource) => resource !== '*')

    for (const resource of ec2Resources) {
      expect(resource.includes('eu-west-2')).toBe(false)
      expect(resource.includes('429776178057')).toBe(false)
    }
  })

  it('creates, describes, reads and rotates agent credential secrets', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'ManageAgentCredentialSecrets')

    expect(statement?.Action).toEqual([
      'secretsmanager:CreateSecret',
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
    ])
  })

  it('scopes those secrets to the stage’s own prefix, never to every secret in the account', () => {
    const statement = policy.Statement.find((entry) => entry.Sid === 'ManageAgentCredentialSecrets')

    expect(statement?.Resource).toEqual([
      'arn:aws:secretsmanager:eu-west-2:429776178057:secret:sisyphus/staging/agent-credential/*',
    ])
    expect(statement?.Resource).not.toContain('*')
    expect(statement?.Resource).not.toContain(
      'arn:aws:secretsmanager:eu-west-2:429776178057:secret:*',
    )
  })

  it('cannot reach another stage’s agent credentials', () => {
    const production = buildControlPlanePolicy({
      ...controlPlaneConfig,
      agentCredentialSecretPrefix: getAgentCredentialSecretPrefix(getStackScope('production')),
    })
    const secretResources = production.Statement.flatMap(
      (statement) => statement.Resource ?? [],
    ).filter((resource) => resource.startsWith('arn:aws:secretsmanager:'))

    expect(secretResources).toHaveLength(1)
    for (const resource of secretResources) {
      expect(resource).toContain('sisyphus/production/agent-credential/')
      expect(resource).not.toContain('staging')
    }
  })

  it('refuses an empty prefix rather than scoping the grant to secret:/*', () => {
    expect(() =>
      buildControlPlanePolicy({ ...controlPlaneConfig, agentCredentialSecretPrefix: '   ' }),
    ).toThrow('empty agent credential prefix')
  })

  it('grants nothing outside the five scoped statements', () => {
    expect(policy.Statement).toHaveLength(5)
    expect(policy.Statement.every((statement) => statement.Effect === 'Allow')).toBe(true)
  })
})

describe('buildControlPlanePolicy — what the control plane must never do', () => {
  it('cannot reach the database or Parameter Store', () => {
    for (const action of controlPlaneActions()) {
      expect(action.startsWith('rds')).toBe(false)
      expect(action.startsWith('ssm:')).toBe(false)
    }
  })

  it('cannot delete a secret or enumerate the ones outside its prefix', () => {
    const actions = controlPlaneActions()

    expect(actions).not.toContain('secretsmanager:DeleteSecret')
    expect(actions).not.toContain('secretsmanager:ListSecrets')
    expect(actions).not.toContain('secretsmanager:ListSecretVersionIds')
  })

  it('holds no Secrets Manager action on a resource other than the agent credential prefix', () => {
    const policy = buildControlPlanePolicy(controlPlaneConfig)
    const secretStatements = policy.Statement.filter((statement) =>
      statement.Action.some((action) => action.startsWith('secretsmanager:')),
    )

    expect(secretStatements).toHaveLength(1)
    for (const resource of secretStatements[0]?.Resource ?? []) {
      expect(resource).toBe(
        `arn:aws:secretsmanager:eu-west-2:429776178057:secret:${controlPlaneConfig.agentCredentialSecretPrefix}/*`,
      )
    }
  })

  it('cannot touch S3 — the buckets rely on their own bucket policies, not this role', () => {
    for (const action of controlPlaneActions()) {
      expect(action.startsWith('s3:')).toBe(false)
    }
  })

  it('has no wildcard action, and passes no role by wildcard', () => {
    for (const action of controlPlaneActions()) {
      expect(action).not.toBe('*')
      expect(action.endsWith(':*')).toBe(false)
    }

    const passRoleResources = buildControlPlanePolicy(controlPlaneConfig).Statement.find((entry) =>
      entry.Action.includes('iam:PassRole'),
    )?.Resource

    expect(passRoleResources).not.toContain('*')
  })
})
