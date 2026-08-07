/**
 * The authoring identity of a Jira comment, as reported by the Jira REST API.
 * Both fields are optional because Jira omits `emailAddress` when the caller
 * lacks the profile-visibility permission, and omits `accountId` for comments
 * authored by an app rather than a user.
 */
export interface JiraCommentAuthor {
  accountId?: string
  emailAddress?: string
}

/**
 * The Sisyphus service account configured on the integration — the identity
 * Sisyphus itself comments as.
 */
export interface PlatformIdentity {
  accountId?: string
  emailAddress?: string
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase()

/**
 * Decides whether a Jira comment was authored by Sisyphus itself.
 *
 * FR-161: platform-authored comments are excluded from the prompt, otherwise a
 * second run on the same ticket reads Sisyphus's own prior write-back back in
 * as task input and the loop compounds on every iteration.
 *
 * The decision is made from the authoring *identity* only — never by
 * pattern-matching the comment body, which a human can trivially reproduce.
 * `accountId` is preferred because it is stable; the email address is a
 * fallback for the Jira deployments that do not return an account id.
 * An author that matches on neither field is treated as human, which is the
 * safe default: including a human comment is a prompt-quality issue, whereas
 * excluding one loses task input.
 */
export const isPlatformAuthored = (
  author: JiraCommentAuthor,
  platform: PlatformIdentity,
): boolean => {
  if (author.accountId !== undefined && platform.accountId !== undefined) {
    return author.accountId === platform.accountId
  }

  if (author.emailAddress !== undefined && platform.emailAddress !== undefined) {
    return normaliseEmail(author.emailAddress) === normaliseEmail(platform.emailAddress)
  }

  return false
}
