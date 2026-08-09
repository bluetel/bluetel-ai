/**
 * The deployed panel.
 *
 * The whole of this module's value is in two things it fixes rather than in
 * anything it computes.
 *
 * **The logical name is a constant, not an argument.** `SisyphusPanel` is part
 * of the Pulumi URN of every already-deployed site; changing it does not rename
 * the site, it destroys it and creates another. Holding it here means no config
 * file can spell it differently, and a rename becomes a deliberate edit to one
 * line with this comment attached to it.
 *
 * **The argument types are the deployment tool's own.** Every option below is
 * projected out of the component's constructor signature with
 * `ConstructorParameters`, so upgrading the tool either keeps compiling or fails
 * at the one place that has to change. Restating those shapes by hand is the
 * indirection FR-066 forbids: a hand-written copy compiles happily while
 * describing arguments the provider will reject.
 */

import { omitReservedLambdaEnv } from './reserved-lambda-env'

type NextjsArgs = NonNullable<ConstructorParameters<typeof sst.aws.Nextjs>[1]>

/**
 * Logical name of the panel's site. See the note above before changing it.
 */
export const NEXTJS_WEBSITE_NAME = 'SisyphusPanel'

export interface NextjsWebsiteConfig {
  /** Directory the Next.js app is built from, relative to the config file. */
  readonly path: NextjsArgs['path']
  readonly environment: NextjsArgs['environment']
  readonly domain?: NextjsArgs['domain']
  readonly permissions?: NextjsArgs['permissions']
  readonly server?: NextjsArgs['server']
  readonly transform?: NextjsArgs['transform']
  readonly vpc?: NextjsArgs['vpc']
}

export const createNextjsWebsite = (config: NextjsWebsiteConfig): sst.aws.Nextjs =>
  new sst.aws.Nextjs(NEXTJS_WEBSITE_NAME, {
    path: config.path,
    // The server function's environment is a Lambda environment underneath;
    // AWS_REGION is injected by the runtime itself and a deploy is rejected
    // outright if it is also declared here. `environment` is an `Input`, not
    // necessarily a plain object, so it is resolved through `$output` before
    // the reserved key can be filtered out of it.
    environment:
      config.environment === undefined
        ? undefined
        : $output(config.environment).apply((environment) => omitReservedLambdaEnv(environment)),
    domain: config.domain,
    permissions: config.permissions,
    server: config.server,
    transform: config.transform,
    vpc: config.vpc,
  })
