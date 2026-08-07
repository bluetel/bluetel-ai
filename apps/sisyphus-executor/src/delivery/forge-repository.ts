/**
 * Turning a repository reference into the pair the host's API addresses (T195).
 *
 * ## Why this is a module and not three lines in the client
 *
 * Everything upstream calls a repository a `repository: string`, and what
 * actually arrives there is `workspace.entries[].repositoryUrl` from the job
 * envelope — whatever an administrator typed when the workspace was
 * configured. In practice that is any of:
 *
 * ```
 * https://forge.example/acme/web
 * https://forge.example/acme/web.git
 * https://forge.example/acme/web/
 * ssh://git@forge.example/acme/web.git
 * git@forge.example:acme/web.git
 * acme/web
 * ```
 *
 * All six name one repository, and a client that handled four of them would
 * fail the other two with a 404 — which pushed-commit verification would then
 * report to the engineer as "your branch is not on the forge". Getting this
 * wrong is not a cosmetic parsing bug; it is a wrong answer to the one question
 * `./pull-request.ts` refuses to guess at.
 *
 * ## The last two segments, and no more cleverness than that
 *
 * Owner and name are the final two path segments. That is deliberately
 * indifferent to the host, the scheme, the port and any mount prefix a
 * self-hosted instance sits behind, all of which vary and none of which change
 * which repository is meant.
 *
 * ## The host, for the one caller that needs it
 *
 * {@link parseRepositoryLocation} answers the other half — the authority the
 * reference names — and it lives here rather than beside its caller for the
 * reason the module comment above gives: six spellings of one repository, one
 * place that knows how to take them apart. A second parser somewhere else would
 * be a second set of the same six cases, and the one that drifts is the one
 * nobody is looking at. `run/forge-credential.ts` uses it to ask git's
 * credential helper about the right host; nothing in this directory does.
 *
 * ## The reference can contain a credential, so the refusal quotes nothing
 *
 * `https://x-access-token:<token>@forge.example/acme/web` is a perfectly
 * ordinary way to write a clone URL, and a bundle that installs credentials by
 * rewriting remotes will produce one. A parse failure that echoed its input
 * would put that token in a run record (FR-072), so the user-information part
 * is removed before the reference appears in any message.
 */

export interface RepositorySlug {
  readonly owner: string
  readonly name: string
  /** `owner/name`, ready to interpolate into a path. */
  readonly path: string
}

/**
 * Strip `user:password@` out of a reference.
 *
 * Greedy to the last `@` of the authority, because the user half is often an
 * email address and carries an `@` of its own.
 */
export const withoutUserInfo = (reference: string): string =>
  reference.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/, '$1').replace(/^[^/@]*@(?=[^/]*:)/, '')

export const repositorySlugError = (reference: string): Error =>
  new Error(
    `the repository "${withoutUserInfo(reference)}" does not name an owner and a repository, so ` +
      'no request can be addressed to the forge for it. No pull request was opened.',
  )

/** Everything before the path: a scheme and authority, or an `scp`-style `host:`. */
const stripLocation = (reference: string): string => {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*\//.exec(reference)

  if (scheme !== null) {
    return reference.slice(scheme[0].length)
  }

  // `git@forge.example:acme/web.git` — the colon is the separator, not a port.
  const scp = /^[^/]*:/.exec(reference)

  return scp === null ? reference : reference.slice(scp[0].length)
}

/**
 * Read `owner/name` out of whatever form the workspace recorded.
 *
 * @param reference - The repository as the envelope carried it.
 * @returns The owner and repository name.
 * @throws When the reference names fewer than two path segments.
 */
export const parseRepositorySlug = (reference: string): RepositorySlug => {
  const trimmed = reference.trim()
  const segments = stripLocation(withoutUserInfo(trimmed))
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')

  const name = segments.pop()?.replace(/\.git$/, '')
  const owner = segments.pop()

  if (owner === undefined || name === undefined || name === '') {
    throw repositorySlugError(trimmed)
  }

  return { owner, name, path: `${owner}/${name}` }
}

/** The authority a repository reference names, in the shape git asks about it. */
export interface RepositoryLocation {
  /** `forge.example`, or `forge.example:8443` when the reference pinned a web port. */
  readonly host: string
  /** What git calls the protocol. `https` unless the reference explicitly said `http`. */
  readonly protocol: 'http' | 'https'
}

export const repositoryLocationError = (reference: string): Error =>
  new Error(
    `the repository "${withoutUserInfo(reference)}" names no host, so there is nobody to ask for ` +
      'a credential and no forge to address. Nothing was attempted.',
  )

/** `https://forge.example:8443/git/acme/web` → `['https', 'forge.example:8443']`. */
const SCHEMED = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)/
/** `forge.example:acme/web.git`, once the user information has been removed. */
const SCP_STYLE = /^([^/:]+):(?!\/)/

/**
 * Read the host a reference points at.
 *
 * The port is kept only for `http` and `https`, and dropped otherwise: an
 * `ssh://forge.example:22/acme/web` names port 22 for ssh, and carrying that
 * into a `host=forge.example:22` credential query would ask git about an
 * authority no credential was ever stored against. Every other scheme — `ssh`,
 * `git`, and the scp-style form a bundle's rewritten remote often uses — is
 * reported as `https`, because the forge's REST API and its https credential
 * are what this host name is wanted for; a reference that clones over ssh and
 * has no https credential fails at the fill, saying so.
 *
 * @param reference - The repository as the envelope carried it.
 * @returns The host, and the protocol to ask about it under.
 * @throws When the reference names no authority at all — `acme/web` has none.
 */
export const parseRepositoryLocation = (reference: string): RepositoryLocation => {
  const trimmed = reference.trim()
  const bare = withoutUserInfo(trimmed)
  const schemed = SCHEMED.exec(bare)

  if (schemed !== null) {
    const scheme = schemed[1].toLowerCase()
    const web = scheme === 'http' || scheme === 'https'
    const authority = web ? schemed[2] : schemed[2].replace(/:\d+$/, '')

    if (authority === '') {
      throw repositoryLocationError(trimmed)
    }

    return { host: authority, protocol: scheme === 'http' ? 'http' : 'https' }
  }

  const scp = SCP_STYLE.exec(bare)

  if (scp === null) {
    throw repositoryLocationError(trimmed)
  }

  return { host: scp[1], protocol: 'https' }
}
