import { describe, expect, it, vi } from 'vitest'

import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_ISSUER_URL,
  buildDeployRoleTrustPolicy,
  buildOidcProviderSpecification,
  getDeployBranchRef,
  getMissingOidcProviderMessage,
  getTrustedSubject,
  resolveOidcProviderArn,
} from './oidc-provider'

const scope = { project: 'sisyphus', stack: 'production-bootstrap' }
const githubRepo = 'bluetel/universal-react-monorepo'

describe('GITHUB_OIDC_ISSUER_URL', () => {
  it('is the GitHub Actions issuer', () => {
    expect(GITHUB_OIDC_ISSUER_URL).toBe('https://token.actions.githubusercontent.com')
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
    expect(getTrustedSubject(githubRepo, 'production')).not.toContain('*')
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
})

describe('buildOidcProviderSpecification', () => {
  it('registers the GitHub issuer for the STS audience', () => {
    const specification = buildOidcProviderSpecification()

    expect(specification.url).toBe(GITHUB_OIDC_ISSUER_URL)
    expect(specification.clientIdList).toEqual([GITHUB_OIDC_AUDIENCE])
    expect(specification.thumbprintList.length).toBeGreaterThan(0)
  })
})

describe('resolveOidcProviderArn', () => {
  const createdArn = 'arn:aws:iam::123456789012:oidc-provider/created'
  const existingArn = 'arn:aws:iam::123456789012:oidc-provider/existing'

  it('creates the provider on production', async () => {
    const lookupProvider = vi.fn()

    const arn = await resolveOidcProviderArn(
      {
        createProvider: (name) => {
          expect(name).toBe('sisyphus-production-bootstrap-github-oidc')

          return { arn: createdArn }
        },
        lookupProvider,
      },
      { scope, stage: 'production' },
    )

    expect(arn).toBe(createdArn)
    expect(lookupProvider).not.toHaveBeenCalled()
  })

  it('looks the provider up on every other stage', async () => {
    const createProvider = vi.fn()

    const arn = await resolveOidcProviderArn(
      {
        createProvider,
        lookupProvider: (url) => {
          expect(url).toBe(GITHUB_OIDC_ISSUER_URL)

          return Promise.resolve({ arn: existingArn })
        },
      },
      { scope: { project: 'sisyphus', stack: 'staging-bootstrap' }, stage: 'staging' },
    )

    expect(arn).toBe(existingArn)
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('translates an absent provider into a message naming the bootstrap step', async () => {
    await expect(
      resolveOidcProviderArn(
        {
          createProvider: () => ({ arn: createdArn }),
          lookupProvider: () => Promise.reject(new Error('NoSuchEntity')),
        },
        { scope, stage: 'dev-harry' },
      ),
    ).rejects.toThrow(getMissingOidcProviderMessage('dev-harry'))
  })
})

describe('getMissingOidcProviderMessage', () => {
  const message = getMissingOidcProviderMessage('staging')

  it('names the stage that failed', () => {
    expect(message).toContain('"staging"')
  })

  it('names the bootstrap command to run', () => {
    expect(message).toContain('pnpm nx run sisyphus-admin:bootstrap --configuration=production')
  })
})
