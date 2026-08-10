/**
 * The block an agent puts its answer in, and the reader that finds it (T194).
 *
 * A development pass produces prose, tool calls, diffs and — somewhere in all of that — a
 * structured answer the executor has to act on. Something has to mark where the answer is, because
 * the alternative is inferring a branch name out of a paragraph, and a wrong inference here opens a
 * pull request in a client's repository.
 *
 * So the answer is delimited and the delimiter carries a **nonce**. Two properties follow, and
 * both matter:
 *
 * - **A block from an earlier pass cannot be mistaken for this one.** The autonomous loop sends a
 *   second and third development turn into the *same* conversation, and every earlier block is
 *   still sitting in the accumulated transcript. Without the nonce, iteration two would read
 *   iteration one's answer, report it as fresh work, and do it again on iteration three.
 * - **The instruction cannot answer itself.** The turn that asks for the block necessarily shows
 *   the markers, and an agent that quotes the request back would otherwise look like an agent that
 *   answered it. Only assistant text is ever accumulated, and the block that counts is the last
 *   one whose body is a JSON object — so restating the format and then answering reads as one
 *   answer rather than two, and reads it in the right order.
 *
 * Nothing in this module decides whether the answer is any good; `development-proposal.ts` does
 * that. This one only says where the answer is and whether it is intact, and it distinguishes
 * "not there yet" from "opened and never closed" from "closed and not JSON" — because those are
 * three different things to tell an operator, and only the first is worth waiting on.
 */

/** Names the block for a human reading the log, and namespaces it away from ordinary prose. */
export const PROPOSAL_TAG = 'sisyphus-development-proposal'

export interface ProposalMarkers {
  readonly open: string
  readonly close: string
}

/**
 * The pair delimiting one request's answer, for **any** structured question (T194, T196).
 *
 * The tag is a parameter rather than the one constant this module started with, because a review
 * verdict, an integration plan and an integration step's reference are the same problem as a
 * development proposal and must not become a second implementation of it. The tag is also what
 * keeps two *different* questions apart inside one conversation: an autonomous run asks for a
 * development proposal, then a review verdict, then an integration plan, and a reader that matched
 * only on the nonce would still be safe by accident today and unsafe the moment two questions were
 * ever in flight together.
 *
 * Asymmetric on purpose — the closing marker is not a copy of the opening one — so that neither
 * can be produced by truncating the other, and a half-written block is always recognisable as
 * half-written rather than as a complete block of a different shape.
 */
export const answerMarkers = (tag: string, nonce: string): ProposalMarkers => ({
  open: `<<<${tag}:${nonce}`,
  close: `${tag}:${nonce}>>>`,
})

/** {@link answerMarkers} for the development pass's own tag. */
export const proposalMarkers = (nonce: string): ProposalMarkers =>
  answerMarkers(PROPOSAL_TAG, nonce)

/** What the transcript so far contains. Exactly one of these is true at any moment. */
export type ProposalExtraction =
  /** No marker for this request. The agent has not begun to answer. */
  | { readonly kind: 'absent' }
  /** A marker without its pair: still being written, or cut off when the stream ended. */
  | { readonly kind: 'truncated' }
  /** Every complete block there is has a body that is not a JSON object. */
  | { readonly kind: 'malformed'; readonly detail: string }
  /** A complete block whose body is a JSON object — whether or not it says anything useful. */
  | { readonly kind: 'found'; readonly value: Record<string, unknown> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const FENCE = '```'

/**
 * Remove a markdown code fence wrapping the body.
 *
 * Lenient in the same scoped sense `frames.ts` is lenient: an agent writing a JSON block inside a
 * fence has answered the question, and refusing that answer over three backticks would be a halt
 * with nothing wrong behind it. What is *not* forgiven is the body failing to parse — that is a
 * real gap between what was asked for and what came back.
 */
export const stripCodeFence = (body: string): string => {
  const trimmed = body.trim()

  if (!trimmed.startsWith(FENCE) || !trimmed.endsWith(FENCE)) {
    return trimmed
  }

  const firstBreak = trimmed.indexOf('\n')

  if (firstBreak === -1) {
    return trimmed
  }

  return trimmed.slice(firstBreak + 1, trimmed.length - FENCE.length).trim()
}

/** Read one complete block's body. Either it is an object, or it is a sentence about why not. */
const readBody = (body: string): Record<string, unknown> | string => {
  let parsed: unknown

  try {
    parsed = JSON.parse(stripCodeFence(body))
  } catch {
    return 'the block was closed but its body is not JSON'
  }

  return isRecord(parsed)
    ? parsed
    : `the block contains JSON of type ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object`
}

/**
 * Find this request's answer in everything the agent has said so far.
 *
 * Complete blocks are read from the end of the transcript backwards and the first one that is a
 * JSON object wins. Reading backwards is what makes the answer beat the instruction it was asked
 * with; requiring an object is what stops the *example* in that instruction — markers around a
 * line of prose — from being mistaken for a reply. An agent that answered and then carried on
 * talking is still read correctly, because what is being searched for is the block, not the end.
 *
 * @param transcript - Accumulated **assistant** text, in arrival order. Never the user echo.
 * @param tag - Which question this is; see {@link answerMarkers}.
 * @param nonce - The identifier this request's markers carry.
 * @returns Where the answer is, or which way it is not there.
 */
export const extractBlock = (
  transcript: string,
  tag: string,
  nonce: string,
): ProposalExtraction => {
  const { open, close } = answerMarkers(tag, nonce)
  const lastClose = transcript.lastIndexOf(close)

  if (lastClose === -1) {
    return transcript.includes(open) ? { kind: 'truncated' } : { kind: 'absent' }
  }

  let detail: string | undefined
  let closeAt = lastClose

  while (closeAt !== -1) {
    const openAt = transcript.lastIndexOf(open, closeAt)

    if (openAt !== -1) {
      const read = readBody(transcript.slice(openAt + open.length, closeAt))

      if (typeof read !== 'string') {
        return { kind: 'found', value: read }
      }

      detail ??= read
    }

    // `lastIndexOf` treats a negative position as zero, so stepping back from the first match
    // without this would find that same match again, forever.
    closeAt = closeAt === 0 ? -1 : transcript.lastIndexOf(close, closeAt - 1)
  }

  // Nothing readable. An opening marker after the last close means one is still being written or
  // was cut off, which is worth saying separately from a block that was finished and unreadable.
  if (transcript.lastIndexOf(open) > lastClose) {
    return { kind: 'truncated' }
  }

  return detail === undefined
    ? // A closing marker with nothing opening it: reading from the start of the transcript would
      // mean reading whatever prose happened to precede it.
      { kind: 'truncated' }
    : { kind: 'malformed', detail }
}

/** {@link extractBlock} for the development pass's own tag. */
export const extractProposal = (transcript: string, nonce: string): ProposalExtraction =>
  extractBlock(transcript, PROPOSAL_TAG, nonce)
