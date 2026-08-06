/**
 * Delivery conventions, taken entirely from the repository's `sisyphus-dev`
 * skill (T068, T069, FR-058).
 *
 * **Nothing in this directory has a default branch name, a default base, a
 * default remote or a title format.** Those belong to the client's repository
 * and are stated in its skill; a fallback here would mean a run against a
 * repository whose skill is missing quietly pushes to `main` and opens a pull
 * request titled something Sisyphus invented. FR-058 is explicit that a
 * missing, unreadable or self-contradictory skill halts the workflow naming
 * the skill and the step, **with no guessed action on branches or tickets** —
 * so the only thing this module can do with an incomplete convention is refuse.
 *
 * ## Where these values come from
 *
 * `src/skills` resolves `sisyphus-dev` from the primary workspace entry and
 * reports its content digest, but it deliberately does not parse conventions
 * out of it — a skill's meaning is its prose, and a resolver extracting branch
 * rules from front matter would be its own kind of hardcoding. So the values
 * below are what the **agent** produced by following the resolved skill, and
 * this module's job is to insist they are complete before anything
 * irreversible is attempted with them. Neither half guesses: skill resolution
 * has no fallback document, and this has no fallback value.
 */

/** The skill every delivery convention below is read from. */
export const DEV_SKILL_NAME = 'sisyphus-dev'

export interface DeliveryConventions {
  /** Remote the work was pushed to, named by the skill. */
  readonly remote: string
  /** Branch carrying the work, derived by the skill's naming rule. */
  readonly branchName: string
  /** Branch the work is proposed onto, named by the skill. */
  readonly baseBranch: string
  /** Title, composed by the skill's rule. */
  readonly pullRequestTitle: string
  /** Optional text the skill requires above the summary in the description. */
  readonly bodyPreamble?: string
}

/**
 * FR-058's halt: names the skill and the step, and says what was missing.
 *
 * The step matters as much as the skill. "sisyphus-dev is incomplete" sends an
 * engineer to read a file; "sisyphus-dev did not give the delivery step a base
 * branch" sends them to the line.
 */
export const skillConventionError = (step: string, problems: readonly string[]): Error =>
  new Error(
    `${DEV_SKILL_NAME} did not give the ${step} step what it needs: ${problems.join('; ')}. ` +
      'The workflow stops here rather than guessing a branch or a title.',
  )

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === ''

/**
 * Every field the skill must supply, with the wording used when it does not.
 * Ordered so a wholly absent skill reports its problems in a readable order.
 */
const REQUIRED_FIELDS: readonly {
  readonly key: keyof DeliveryConventions
  readonly problem: string
}[] = [
  { key: 'remote', problem: 'no remote to verify the push against' },
  { key: 'branchName', problem: 'no branch name for the work' },
  { key: 'baseBranch', problem: 'no base branch to propose onto' },
  { key: 'pullRequestTitle', problem: 'no pull request title' },
]

/**
 * Validate a resolved skill's delivery conventions.
 *
 * @param resolved - What skill resolution produced, possibly incomplete.
 * @param step - The step being attempted, named in the halt message.
 * @returns The same conventions, once every field is known to be present.
 */
export const requireDeliveryConventions = (
  resolved: Partial<DeliveryConventions>,
  step: string,
): DeliveryConventions => {
  const problems = REQUIRED_FIELDS.filter(({ key }) => isBlank(resolved[key])).map(
    ({ problem }) => problem,
  )

  // A branch proposed onto itself is the self-contradiction FR-058 names: the
  // skill has said two things that cannot both be acted on, and picking one is
  // exactly the guess that is forbidden.
  if (problems.length === 0 && resolved.branchName?.trim() === resolved.baseBranch?.trim()) {
    problems.push(
      `the branch and the base are both "${String(resolved.branchName)}", which cannot be proposed onto itself`,
    )
  }

  if (problems.length > 0) {
    throw skillConventionError(step, problems)
  }

  return {
    remote: String(resolved.remote).trim(),
    branchName: String(resolved.branchName).trim(),
    baseBranch: String(resolved.baseBranch).trim(),
    pullRequestTitle: String(resolved.pullRequestTitle).trim(),
    ...(isBlank(resolved.bodyPreamble) ? {} : { bodyPreamble: String(resolved.bodyPreamble) }),
  }
}
