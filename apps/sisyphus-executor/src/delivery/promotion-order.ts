/**
 * The order cross-repository changes are integrated in (T106, FR-117).
 *
 * ## There is no ordering in this file
 *
 * FR-117: the order in which cross-repository pull requests are integrated is
 * defined by the primary entry's `sisyphus-integration` skill, **never by
 * Sisyphus**. So there is no default here — not a constant, not an argument
 * default, not a `sort`, and not the workspace's own declaration order used as
 * a stand-in. That absence is the requirement, and it is worth being explicit
 * about why, because every plausible-looking default is wrong for somebody:
 *
 * - *Primary first* is wrong for the client whose shared library is a secondary
 *   entry that every other repository compiles against.
 * - *Declaration order* is wrong the moment an administrator reorders the
 *   workspace for readability and silently changes what integrates first.
 * - *Alphabetical* is not an opinion about anything at all.
 *
 * And the cost of guessing is not a wrong answer that someone notices. It is a
 * consumer promoted before the API it depends on, in a client's estate, by a
 * process nobody is watching — which looks deliberate afterwards. So a
 * workspace of several repositories whose skill states no order **halts**,
 * naming the skill and the step, exactly as `./conventions.ts` halts for a
 * missing branch rule (FR-058).
 *
 * ## Where the declaration comes from
 *
 * The same seam the delivery conventions use. `src/skills` resolves
 * `sisyphus-integration` from the primary entry and records its digest, but
 * deliberately does not parse instructions out of it: a skill's meaning is its
 * prose, and a resolver extracting an order from front matter would be its own
 * kind of hardcoding. So the value validated here is what the **agent**
 * produced by following the resolved skill, and this module's job is to insist
 * it is complete, unambiguous and about *this* workspace before anything
 * irreversible is done in its name.
 *
 * ## The one case that needs no declaration
 *
 * A workspace of exactly one entry. There is one permutation of one item, so
 * nothing is being chosen and no client's order is being overridden — and
 * requiring a single-repository run to carry an integration skill would make
 * FR-109's "simple, common case" the expensive one. Every workspace with a
 * second entry must declare.
 */

/** The skill the order is read from, and the only skill this module names. */
export const PROMOTION_SKILL_NAME = 'sisyphus-integration'

/** What the skill said, as the agent read it. Entry ids, first to last. */
export interface DeclaredPromotionOrder {
  readonly entryIds: readonly string[]
}

/** An entry this module can place: anything the workspace identifies. */
export interface OrderableEntry {
  readonly entryId: string
}

/** One repository's place in the declared order. */
export interface PromotionStep<TEntry extends OrderableEntry = OrderableEntry> {
  readonly entry: TEntry
  /** 1-based, so a halt or a description can say "second of three". */
  readonly position: number
}

/**
 * FR-058's halt for this step: names the skill, the step, and what was wrong.
 *
 * Carries no suggested order of any kind. There is nothing on this error a
 * caller could mistake for a usable default, which is the same property
 * `SkillResolutionError` holds and for the same reason.
 */
export const promotionOrderError = (step: string, problems: readonly string[]): Error =>
  new Error(
    `${PROMOTION_SKILL_NAME} did not give the ${step} step a usable integration order: ` +
      `${problems.join('; ')}. The workflow stops here rather than choosing an order across the ` +
      "client's repositories (FR-117).",
  )

const listOf = (values: readonly string[]): string => values.join(', ')

/**
 * The first element, honestly typed. `noUncheckedIndexedAccess` is off in this
 * project, so `values[0]` is typed as present even when the array is empty.
 */
const firstOf = <TValue>(values: readonly TValue[]): TValue | undefined => values[0]

/**
 * Place every entry of the workspace in the order the skill declared.
 *
 * @param declared - What the agent read out of `sisyphus-integration`, possibly
 *   absent or incomplete.
 * @param options - The workspace's entries and the step named in a halt.
 * @returns Each entry with its 1-based position, in declared order.
 * @throws When the declaration is missing, partial, unknown or repeated.
 */
export const requirePromotionOrder = <TEntry extends OrderableEntry>(
  declared: Partial<DeclaredPromotionOrder> | undefined,
  options: { readonly entries: readonly TEntry[]; readonly step: string },
): readonly PromotionStep<TEntry>[] => {
  const { entries, step } = options

  if (entries.length === 0) {
    throw promotionOrderError(step, ['the workspace has no entries to order'])
  }

  const declaredIds = (declared?.entryIds ?? []).map((entryId) => entryId.trim()).filter(Boolean)

  if (declaredIds.length === 0) {
    const only = firstOf(entries)

    if (entries.length === 1 && only !== undefined) {
      // One permutation of one item. Nothing is chosen, so nothing is guessed.
      return [{ entry: only, position: 1 }]
    }

    throw promotionOrderError(step, [
      `the workspace spans ${String(entries.length)} repositories and the skill states no order ` +
        'for them',
    ])
  }

  const byId = new Map(entries.map((entry) => [entry.entryId, entry]))
  const problems: string[] = []
  const placed = new Set<string>()
  const steps: PromotionStep<TEntry>[] = []

  for (const entryId of declaredIds) {
    const entry = byId.get(entryId)

    if (entry === undefined) {
      // Naming a repository the workspace does not contain means the skill and
      // the workspace disagree about what this run is. Dropping the unknown id
      // and ordering the rest would act on the half of the instruction that
      // happened to parse.
      problems.push(`it names "${entryId}", which is not an entry of this workspace`)
      continue
    }

    if (placed.has(entryId)) {
      problems.push(`it names "${entryId}" more than once, so its position is ambiguous`)
      continue
    }

    placed.add(entryId)
    steps.push({ entry, position: steps.length + 1 })
  }

  const missing = entries.filter((entry) => !placed.has(entry.entryId))

  if (missing.length > 0) {
    // An omitted entry has no position, and "last" is a position somebody chose.
    problems.push(
      `it does not place ${listOf(missing.map((entry) => `"${entry.entryId}"`))}, so ` +
        `${missing.length === 1 ? 'that repository has' : 'those repositories have'} no place ` +
        'in the order',
    )
  }

  if (problems.length > 0) {
    throw promotionOrderError(step, problems)
  }

  return steps
}
