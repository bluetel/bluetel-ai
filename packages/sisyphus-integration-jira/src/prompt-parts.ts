import type {
  CandidateItem,
  ItemComment,
  PromptContext,
  PromptParts,
} from '@bluetel-ai/sisyphus-api/contracts'

/**
 * The ticket-derived layers of the prompt (T112, FR-159, FR-161, FR-163).
 *
 * ## The exclusion, and the failure it prevents
 *
 * Sisyphus comments on a ticket when it picks it up, when it declines it and when it finishes
 * (FR-142, FR-143, FR-144). A ticket's comments go into the prompt (FR-159). Put those two
 * together on a ticket that is worked twice and the second run is handed Sisyphus's own account of
 * the first as though a human had written it: "Sisyphus has picked this ticket up and started a
 * run" arrives as task input. The third run gets that plus the second run's, and so on. It does
 * not fail once and stop — **it compounds on every iteration**, and each run is a real instance
 * with a real bill.
 *
 * So platform-authored comments are dropped, and dropped **by authoring identity**
 * (`./is-platform-authored`), decided when the candidate was built. Never by looking at the text.
 * A text rule is wrong in both directions and both are live:
 *
 * - A human quoting or replying to a Sisyphus comment — which is exactly what people do — has
 *   their comment silently deleted from the task description.
 * - Sisyphus changes its own wording, or a run posts a comment in a shape the pattern does not
 *   cover, and the loop reopens with no sign that anything changed.
 *
 * `prompt-parts.test.ts` holds both directions with a ticket that only an identity rule can get
 * right: a human comment that reproduces Sisyphus's wording *and* its marker verbatim, and a
 * platform comment that reads like ordinary prose.
 *
 * ## Bounding (FR-163)
 *
 * The title, the URL and the description are the task, so nothing here drops them. Comments are
 * context, so they are what gives when the content has to fit: oldest first, until the remainder
 * is inside the budget, with the number dropped reported so the record says what the agent was
 * *not* told. Redaction is applied by the layer that stores the assembled prompt, not here.
 */

/** Comments are the layer that gives; this is how much of it there is by default. */
export const DEFAULT_MAX_COMMENT_CHARACTERS = 20_000

/** A hard stop on count, for a ticket with a very long tail of very short comments. */
export const DEFAULT_MAX_COMMENTS = 50

const isUsable = (comment: ItemComment): boolean =>
  !comment.isPlatformAuthored && comment.body.trim().length > 0

/**
 * Keep the newest comments that fit, oldest-first being what goes.
 *
 * A single comment larger than the whole budget goes too. Keeping it would mean the bound was not
 * a bound, and the newest comments — the ones most likely to matter — would be the ones dropped
 * to make room for it.
 */
const withinBudget = (
  comments: readonly ItemComment[],
  maxCharacters: number,
  maxComments: number,
): readonly ItemComment[] => {
  const kept: ItemComment[] = []
  let used = 0

  for (const comment of [...comments].reverse()) {
    if (kept.length >= maxComments || used + comment.body.length > maxCharacters) {
      break
    }

    used += comment.body.length
    kept.push(comment)
  }

  return kept.reverse()
}

/**
 * @param item - The ticket, with authorship already decided on each comment.
 * @param ctx - The bound to assemble within.
 * @returns The parts, in the order FR-159 fixes.
 */
export const assemblePromptParts = (item: CandidateItem, ctx: PromptContext): PromptParts => {
  const usable = item.comments.filter(isUsable)
  const kept = withinBudget(
    usable,
    ctx.maxCommentCharacters ?? DEFAULT_MAX_COMMENT_CHARACTERS,
    ctx.maxComments ?? DEFAULT_MAX_COMMENTS,
  )

  return {
    title: item.title,
    url: item.url,
    body: item.body,
    comments: kept.map((comment) => comment.body),
    // Only what the bound dropped. An excluded platform comment was never task input, so counting
    // it here would report the prompt as truncated when nothing was lost.
    truncatedComments: usable.length - kept.length,
  }
}
