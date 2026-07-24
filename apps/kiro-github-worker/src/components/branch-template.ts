/**
 * Branch template renderer and validator.
 *
 * Renders branch names from a configurable template with placeholder substitution,
 * validates templates against Git branch name rules, and provides a slugify utility
 * for converting issue titles to URL-safe kebab-case strings.
 */

/**
 * Converts a title string into a URL-safe kebab-case slug.
 *
 * - Lowercases the input
 * - Replaces non-alphanumeric characters with hyphens
 * - Collapses consecutive hyphens into a single hyphen
 * - Trims leading and trailing hyphens
 */
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')

/**
 * Renders a branch name from a template by substituting placeholders.
 *
 * Supported placeholders:
 * - `{issue_number}` — replaced with the issue number
 * - `{slug}` — replaced with a slugified version of the issue title
 * - `{pr_number}` — replaced with the PR number (left as empty string if not provided)
 *
 * If the rendered name exceeds 255 characters, the slug portion is truncated to fit.
 * The truncated slug will not end with a trailing hyphen.
 */
export const renderBranchName = (
  template: string,
  params: {
    issueNumber: number
    issueTitle: string
    prNumber?: number
  },
): string => {
  const slug = slugify(params.issueTitle)
  const prNumberStr = params.prNumber != null ? String(params.prNumber) : ''
  const issueNumberStr = String(params.issueNumber)

  const slugOccurrences = (template.match(/\{slug\}/g) ?? []).length

  if (slugOccurrences === 0) {
    // No slug placeholder — just do direct substitution
    return template
      .replace(/\{issue_number\}/g, issueNumberStr)
      .replace(/\{pr_number\}/g, prNumberStr)
  }

  // Calculate the fixed-length portion (everything except {slug} placeholders)
  // by replacing all non-slug placeholders first, then measuring without slugs
  const withNonSlugReplaced = template
    .replace(/\{issue_number\}/g, issueNumberStr)
    .replace(/\{pr_number\}/g, prNumberStr)

  // The fixed length is the total length minus the space taken by {slug} literals
  const fixedLength = withNonSlugReplaced.length - '{slug}'.length * slugOccurrences
  const maxTotalSlugLength = 255 - fixedLength

  if (maxTotalSlugLength <= 0) {
    // No room for slug at all — render with empty slug
    return withNonSlugReplaced.replace(/\{slug\}/g, '')
  }

  // Each slug instance gets an equal share of the available space
  const maxPerSlug = Math.floor(maxTotalSlugLength / slugOccurrences)
  const truncatedSlug = truncateSlug(slug, maxPerSlug)

  return withNonSlugReplaced.replace(/\{slug\}/g, truncatedSlug)
}

/**
 * Truncates a slug to a maximum length, ensuring no trailing hyphen.
 */
const truncateSlug = (slug: string, maxLength: number): string => {
  if (slug.length <= maxLength) {
    return slug
  }
  return slug.slice(0, maxLength).replace(/-+$/, '')
}

/**
 * Validates a branch template string against Git branch name rules.
 *
 * Returns `{ valid: false, warnings }` if the template would produce names with:
 * - Spaces
 * - The sequence `..`
 * - A trailing `.lock` suffix
 * - ASCII control characters (0x00–0x1F, 0x7F)
 *
 * Returns `{ valid: true, warnings }` otherwise, with a warning if the template
 * does not contain the `{issue_number}` placeholder.
 */
export const validateTemplate = (template: string): { valid: boolean; warnings: string[] } => {
  const warnings: string[] = []

  if (template.includes(' ')) {
    return { valid: false, warnings: ['Branch template must not contain spaces'] }
  }

  if (template.includes('..')) {
    return { valid: false, warnings: ['Branch template must not contain ".."'] }
  }

  if (template.endsWith('.lock')) {
    return { valid: false, warnings: ['Branch template must not end with ".lock"'] }
  }

  // Check for control characters (0x00-0x1F, 0x7F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(template)) {
    return { valid: false, warnings: ['Branch template must not contain control characters'] }
  }

  if (!template.includes('{issue_number}')) {
    warnings.push(
      'Branch template does not contain {issue_number} — issue-to-branch mapping will rely solely on the Branch_Map',
    )
  }

  return { valid: true, warnings }
}
