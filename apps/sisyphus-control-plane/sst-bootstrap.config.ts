/**
 * The control plane's once-per-stage prerequisite: the configuration entry its
 * application config reads from.
 *
 * ---------------------------------------------------------------------------
 * Why this stack is small, and why it still has to exist
 * ---------------------------------------------------------------------------
 * The account's CI identity provider and the stage's deploy role live in the
 * panel's bootstrap (`apps/sisyphus-admin/sst-bootstrap.config.ts`). Both are
 * shared: AWS permits one identity provider per issuer URL per account, and one
 * deploy role per stage serves all three deployables. Declaring either here as
 * well would give a resource two owners and two stacks that fight over it — the
 * same reason the panel owns the buckets and the database.
 *
 * What is *not* shared is deploy-time configuration: the control plane's
 * environment has almost nothing in common with the panel's, and one entry with
 * three writers is a merge conflict in a parameter. So each deployable owns its
 * own entry, and creating it is what this stack is for.
 *
 * That makes this a genuine prerequisite rather than a formality: the
 * application config's first act is to read this entry, so the entry has to be
 * created by something that does not read it. A single config branching on a
 * stage suffix cannot be that something — it would evaluate the application
 * config's preconditions on the way to satisfying them (FR-199).
 *
 * Configuration is resolved inside `app()` / `run()` and every import is dynamic,
 * because the ambient globals do not exist at module-evaluation time (FR-202).
 */

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
 * it works with no stack in place (FR-202).
 */
const loadStageConfiguration = async (sstStage: string): Promise<string> => {
  const { DEFAULT_AWS_REGION } = await import('@bluetel-ai/sisyphus-infra')
  const { fetchSsmParamToProcessEnv, getEnvParameterName } =
    await import('@bluetel-ai/sisyphus-infra/scripts')

  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION

  await fetchSsmParamToProcessEnv({
    parameterName: getEnvParameterName('control-plane', sstStage),
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
      name: 'sisyphus-control-plane',
      home: 'aws',
      // Derived from the *plain* stage, so `production-bootstrap` is protected
      // exactly as `production` is.
      ...getStageRemoval(input.stage),
      // Identical to `sst.config.ts` and `sst-install.config.ts`.
      providers: { aws: { version: '6.66.2', region: region as aws.Region } },
    }
  },

  run: async () => {
    const { getStackScope } = await import('@bluetel-ai/sisyphus-infra')
    const { getEnvParameterName } = await import('@bluetel-ai/sisyphus-infra/scripts')

    await loadStageConfiguration($app.stage)

    const stage = getStackScope($app.stage).stack

    const configuration = new aws.ssm.Parameter(
      'SisyphusControlPlaneConfiguration',
      {
        name: getEnvParameterName('control-plane', stage),
        type: 'SecureString',
        value: CONFIGURATION_PLACEHOLDER,
        description: `Deploy-time environment for the Sisyphus control plane on stage "${stage}"`,
      },
      // Created once, then owned by whoever populates it. Without this, every
      // bootstrap would reset the stage's configuration to the placeholder.
      { ignoreChanges: ['value'] },
    )

    return { configurationParameter: configuration.name }
  },
})
