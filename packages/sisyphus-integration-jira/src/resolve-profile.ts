/* cspell:words issuetype */
import type {
  CandidateItem,
  IntegrationMapping,
  MappingResolution,
} from '@bluetel-ai/sisyphus-api/contracts'

/**
 * Resolving a ticket to an execution profile (T111, FR-130).
 *
 * ## Why there is no fallback
 *
 * An execution profile carries the repository, the workspace, the setup bundle, the model and the
 * caps (FR-096). Guessing one is not a small inaccuracy: it is a client's ticket cloned into
 * another client's repository, run against another client's bundle, billed to another client's
 * cap. So a ticket that matches nothing is skipped, the reason is recorded (FR-105) and said on
 * the ticket (FR-143) — and this function has no branch that returns a profile it was not told to.
 *
 * The contract makes that structural rather than a matter of care: the unmatched half of
 * {@link MappingResolution} has no `executionProfileId` field to put a guess in.
 *
 * ## First match, by position, deterministically
 *
 * Mappings are evaluated in `position` order — not in the order they were handed over, which is
 * whatever the query returned. Two mappings sharing a position would make the winner depend on row
 * order, so that is not resolved arbitrarily either: it is reported as unresolvable, because a
 * ticket whose profile depends on the database's mood is exactly what FR-131 (recording *why* a
 * run got its settings) cannot survive.
 *
 * ## Criteria
 *
 * A criterion names an attribute (`components`, `issuetype`, `status`, `labels`, `project`) and
 * the value or values that satisfy it. Comparison is case-insensitive and trimmed, because "Bug"
 * and "bug" are the same issue type to everyone except a string comparison. A criterion this
 * connector cannot evaluate — a shape that is neither a string nor a list of them — stops
 * resolution rather than being treated as "did not match": falling through would hand the ticket
 * to whichever *later* mapping happened to match, which is a guess wearing a rule's clothes.
 */

const normalise = (value: string): string => value.trim().toLowerCase()

const asComparableList = (value: unknown): readonly string[] | undefined => {
  if (typeof value === 'string') {
    return [normalise(value)]
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.map(normalise)
  }

  return undefined
}

interface CriterionOutcome {
  readonly satisfied: boolean
  /** Set when the criterion could not be evaluated at all. */
  readonly unreadable?: string
}

const evaluateCriterion = (
  item: CandidateItem,
  field: string,
  expected: unknown,
): CriterionOutcome => {
  const wanted = asComparableList(expected)

  if (wanted === undefined) {
    return {
      satisfied: false,
      unreadable: `criterion "${field}" is neither a value nor a list of values`,
    }
  }

  const actual = asComparableList(item.attributes[field])

  if (actual === undefined) {
    return { satisfied: false }
  }

  return { satisfied: actual.some((entry) => wanted.includes(entry)) }
}

/**
 * @param item - The ticket.
 * @param mappings - The integration's rules, in any order; `position` decides.
 * @returns The profile it resolved to, or the reason it resolved to none.
 */
export const resolveProfile = (
  item: CandidateItem,
  mappings: readonly IntegrationMapping[],
): MappingResolution => {
  if (mappings.length === 0) {
    return {
      matched: false,
      reason: 'The integration has no execution profile mappings, so nothing can be started.',
    }
  }

  const ordered = [...mappings].sort((left, right) => left.position - right.position)
  const positions = new Set(ordered.map((mapping) => mapping.position))

  if (positions.size !== ordered.length) {
    return {
      matched: false,
      reason:
        'Two mappings share a position, so which profile this ticket resolves to would depend ' +
        'on row order. Resolution is refused until the order is decided.',
    }
  }

  for (const mapping of ordered) {
    // The declared catch-all. It matches by being reached in position order, which is why it
    // belongs last: anything after it is unreachable.
    if (mapping.isDefault) {
      return {
        matched: true,
        executionProfileId: mapping.executionProfileId,
        mappingId: mapping.id,
      }
    }

    const entries = Object.entries(mapping.criteria)
    let satisfied = true

    for (const [field, expected] of entries) {
      const outcome = evaluateCriterion(item, field, expected)

      if (outcome.unreadable !== undefined) {
        return {
          matched: false,
          reason:
            `Mapping at position ${String(mapping.position)} cannot be evaluated: ` +
            `${outcome.unreadable}. Resolution stops here rather than falling through to a ` +
            'mapping that was never meant to catch this ticket.',
        }
      }

      if (!outcome.satisfied) {
        satisfied = false
        break
      }
    }

    // An empty criteria set is a catch-all by construction: nothing was asked, so nothing failed.
    if (satisfied) {
      return {
        matched: true,
        executionProfileId: mapping.executionProfileId,
        mappingId: mapping.id,
      }
    }
  }

  return {
    matched: false,
    reason:
      `No mapping matched this ticket (${String(ordered.length)} evaluated, in position order). ` +
      'It is skipped rather than started under a guessed execution profile.',
  }
}
