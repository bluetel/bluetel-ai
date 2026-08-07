/**
 * The stage's once-per-stage prerequisites: the configuration entry every other
 * config reads from, the account's CI identity provider, and the deploy role.
 *
 * ---------------------------------------------------------------------------
 * Why this is a separate file rather than a branch
 * ---------------------------------------------------------------------------
 * This config has to run when the stage does not exist yet — no stack, no
 * outputs, and on the very first run no configuration entry either. The
 * application config's first act is to resolve a dozen values from that entry,
 * so folding the two together makes the bootstrap evaluate a precondition only
 * the bootstrap can satisfy. Splitting them also removes the sharper failure:
 * with one file, a mistyped stage string was enough to point a deploy at the
 * wrong stack. Now the config file selects the stack and the stage selects only
 * the environment (FR-199).
 *
 * ---------------------------------------------------------------------------
 * What lives here and nowhere else
 * ---------------------------------------------------------------------------
 * The **identity provider** is account-level: AWS permits one per issuer URL per
 * account, so the production bootstrap creates it and every other stage looks it
 * up. The **deploy role** is per stage and shared by all three deployables —
 * there is one CI identity for `staging` and one for `production`, named by
 * `getDeployRoleName` so the CI script can rebuild the ARN from the same
 * constant instead of a second literal (FR-200). The **configuration entry** is
 * per deployable, because a resource with two owners is a resource two stacks
 * fight over.
 *
 * The role is not narrowed by permission — it must be able to create every kind
 * of resource a stage contains. It is narrowed by *trust*:
 * `buildDeployRoleTrustPolicy` pins the `sub` claim to a single branch with
 * `StringEquals`, so a workflow on any other ref cannot assume it at all
 * (FR-067). That is the control; the pipeline's branch conditions are defence in
 * depth.
 *
 * ---------------------------------------------------------------------------
 * Running it the first time
 * ---------------------------------------------------------------------------
 * The configuration entry is created *by this stack*, so on the first bootstrap
 * of a stage it cannot be read — the load below tolerates its absence and
 * `SISYPHUS_GITHUB_REPO` must come from the shell for that one run. Afterwards
 * the operator populates the entry and every later invocation reads it from
 * there. The entry's value is created once and then left alone: `ignoreChanges`
 * means re-running the bootstrap never overwrites what an operator put in it.
 */

/** Every stage's deploy role gets this; it is narrowed by trust, not permission. */
const DEPLOY_ROLE_POLICY_ARN = 'arn:aws:iam::aws:policy/AdministratorAccess'

/**
 * What a freshly created configuration entry holds until an operator fills it
 * in. A parameter cannot be created without a value, and an empty string is not
 * accepted.
 */
const CONFIGURATION_PLACEHOLDER = '# Replace with this deployable’s deploy-time environment.\n'

/**
 * Loads the stage's configuration entry into `process.env` if it exists.
 *
 * Tolerates absence: the entry is created by this stack, so the first bootstrap
 * of a stage necessarily runs before it. Uses the ambient credential chain, so
 * it works with no stack and no deploy role in place (FR-202).
 */
const loadStageConfiguration = async (sstStage: string): Promise<string> => {
  const { DEFAULT_AWS_REGION } = await import('@bluetel-ai/sisyphus-infra')
  const { fetchSsmParamToProcessEnv, getEnvParameterName } =
    await import('@bluetel-ai/sisyphus-infra/scripts')

  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

  await fetchSsmParamToProcessEnv({
    parameterName: getEnvParameterName('admin', sstStage),
    region,
    optional: true,
  })

  return region
}

export default $config({
  app: async (input) => {
    const { getStageRemoval, isBootstrapStage } = await import('@bluetel-ai/sisyphus-infra')

    // The config file selects the stack; the stage selects only the environment.
    // This is the other half of that: a stage belonging to the sibling config is
    // refused outright, so neither half of the pair can be reached by getting a
    // stage string wrong (FR-199).
    if (!isBootstrapStage(input.stage)) {
      throw new Error(
        `Stage "${input.stage}" is not a bootstrap stage. This config builds the once-per-stage ` +
          `prerequisites and must be deployed against "<stage>-bootstrap"; the application stack ` +
          `is sst.config.ts.`,
      )
    }

    const region = await loadStageConfiguration(input.stage)

    return {
      name: 'sisyphus-admin',
      home: 'aws',
      // Derived from the *plain* stage, so `production-bootstrap` is protected
      // exactly as `production` is — this stack holds the account's identity
      // provider, whose accidental removal breaks every stage's ability to
      // deploy.
      ...getStageRemoval(input.stage),
      // Identical to `sst.config.ts` and `sst-install.config.ts`.
      providers: { aws: { version: '6.66.2', region: region as aws.Region } },
    }
  },

  run: async () => {
    const {
      buildDeployRoleTrustPolicy,
      createOidcProvider,
      getStackScope,
      readEnvRecord,
      // The package barrel — never a module inside it.
    } = await import('@bluetel-ai/sisyphus-infra')

    const { getDeployRoleName, getEnvParameterName } =
      await import('@bluetel-ai/sisyphus-infra/scripts')

    await loadStageConfiguration($app.stage)

    const scope = getStackScope($app.stage)
    const stage = scope.stack
    const environment = readEnvRecord(process.env)

    // ----------------------------------------------------------------------
    // The configuration entry every other config for this deployable reads.
    // Declared before anything that could fail, so a first bootstrap still
    // leaves the operator something to populate.
    // ----------------------------------------------------------------------
    const parameterName = getEnvParameterName('admin', stage)

    const configuration = new aws.ssm.Parameter(
      'SisyphusAdminConfiguration',
      {
        name: parameterName,
        type: 'SecureString',
        value: CONFIGURATION_PLACEHOLDER,
        description: `Deploy-time environment for the Sisyphus panel on stage "${stage}"`,
      },
      // Created once, then owned by whoever populates it. Without this, every
      // bootstrap would reset the stage's configuration to the placeholder.
      { ignoreChanges: ['value'] },
    )

    // ----------------------------------------------------------------------
    // The CI identity (FR-068): created on production, looked up elsewhere.
    // ----------------------------------------------------------------------
    const githubRepo: string | undefined = environment.SISYPHUS_GITHUB_REPO

    if (!githubRepo) {
      throw new Error(
        `Missing environment variable: SISYPHUS_GITHUB_REPO. On the first bootstrap of a stage ` +
          `the parameter "${parameterName}" does not exist yet, so set it in the shell for that ` +
          `run; afterwards, put it in the parameter.`,
      )
    }

    const oidcProvider = await createOidcProvider({ scope, stage })

    const deployRoleName = getDeployRoleName(scope)

    const deployRole = new aws.iam.Role(deployRoleName, {
      name: deployRoleName,
      assumeRolePolicy: $output(oidcProvider.arn).apply((arn) =>
        JSON.stringify(buildDeployRoleTrustPolicy({ oidcProviderArn: arn, githubRepo, stage })),
      ),
    })

    new aws.iam.RolePolicyAttachment(`${deployRoleName}-policy`, {
      role: deployRole.name,
      policyArn: DEPLOY_ROLE_POLICY_ARN,
    })

    return {
      configurationParameter: configuration.name,
      deployRoleArn: deployRole.arn,
      deployRoleName,
    }
  },
})
