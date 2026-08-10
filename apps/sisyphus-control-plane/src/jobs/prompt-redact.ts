import type { PromptParts } from '@bluetel-ai/sisyphus-api/contracts'

/* cspell:ignore AKIA AKIAFIXTUREONLY redactor Wtle */

/**
 * Redacting and bounding an integration-assembled prompt **before it is stored** (T116, FR-163).
 *
 * ## There is deliberately no redaction algorithm in this file
 *
 * FR-163 says the assembled prompt is redacted "to the same standard as run output". Run output
 * already has that standard, implemented once, in `apps/sisyphus-executor/src/output/`: private-key
 * block suppression, then every credential the bundle installed removed in every encoding derivable
 * from its value, then the pattern stage for formats nobody handed us. A second implementation here
 * would not be "the same standard" for long — the two would drift on the first pattern anyone added
 * to one of them, and the half that drifted would be the half nobody was looking at.
 *
 * So this module **takes a redactor** ({@link PromptRedactor}, one method, structurally identical
 * to the executor's `Redactor`) and never builds one. The composition root supplies the executor's
 * `createRedactor(...)`, and the repository keeps exactly one redaction implementation.
 *
 * ## What stops a *worse* redactor being injected
 *
 * A port alone would let a deployment pass `{ redact: (text) => text }` and satisfy the type. So
 * the standard is stated as an executable corpus — {@link REDACTION_CONFORMANCE_CASES} — and
 * {@link assertRedactorConformance} runs it. Whatever is wired in has to actually remove a PEM
 * private key, an access-key id, a bearer header and a supplied known value, or wiring fails
 * loudly at start-up rather than quietly storing a customer's ticket with a token in it.
 *
 * The corpus is not a reimplementation: it asserts on *outcomes* ("this string must not survive"),
 * which is the thing that must not drift, rather than on how they are reached.
 *
 * ## The default refuses
 *
 * {@link createRefusingPromptRedactor} throws on every call. Refusing by default is the right shape
 * here because the refusal is *survivable*: a tick that throws is recorded and retried (FR-105,
 * FR-108), so one job stalls and nothing else is affected. A deployment that has wired no redactor
 * genuinely cannot meet FR-163, and a pass-through default would store unredacted customer ticket
 * content while looking configured. Contrast a gate sitting on the only path that lets an operator
 * enable anything at all — refuse by default there and the safe-looking default is the one that
 * takes the whole product down with it.
 *
 * ## Why the bound is applied *after* redaction
 *
 * The connector already drops comments oldest-first to fit its own budget (FR-163), and reports how
 * many it dropped. That budget was measured on the raw text. Redaction changes lengths — a
 * 40-character token becomes `[redacted:jira-token]` — so the bound that decides what is *stored*
 * has to be measured on what is actually stored. The two drop counts add up, which is why
 * {@link redactPromptParts} takes the connector's count in and gives a total out.
 *
 * The title, the URL and the description are never dropped. They are the task (FR-163).
 */

/**
 * One method. The executor's `Redactor` satisfies it structurally, which is the point: wiring is an
 * assignment, not an adapter.
 */
export interface PromptRedactor {
  readonly redact: (text: string) => string
}

export const PROMPT_REDACTOR_NOT_CONFIGURED =
  'This deployment has wired no prompt redactor, so an integration-assembled prompt cannot be stored to the standard FR-163 requires. Supply the executor output redactor.'

/**
 * The redactor used when a deployment has wired none: it refuses.
 *
 * Refusing fails the tick, which is recorded and retried (FR-105, FR-108). A pass-through would
 * instead write the ticket body — comments, descriptions, whatever a customer pasted into Jira —
 * into `workflows.assembled_prompt`, where it is readable by every admin and survives for the
 * retention period.
 */
export const createRefusingPromptRedactor = (): PromptRedactor => ({
  redact: () => {
    throw new Error(PROMPT_REDACTOR_NOT_CONFIGURED)
  },
})

/** One thing an acceptable redactor has to do, stated as an outcome rather than as a mechanism. */
export interface RedactionConformanceCase {
  /** Names the credential class, so a failure says which stage is missing. */
  readonly name: string
  readonly input: string
  /** Fragments that must not survive. */
  readonly forbidden: readonly string[]
  /** Fragments that must survive, so an over-eager redactor is caught too. */
  readonly retained?: readonly string[]
}

/**
 * Fabricated credentials, in the shapes the standard covers.
 *
 * Every value here is invented and matches no real system — a fixture is never a place for a real
 * Atlassian token, a real customer ticket or a real webhook secret.
 */
const FABRICATED_ACCESS_KEY_ID = 'AKIAFIXTUREONLY00000'
const FABRICATED_BEARER = 'fixture0token0value0not0real'
const FABRICATED_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'ZmFrZWtleW1hdGVyaWFsdGhhdGlzbm90YWtleWF0YWxs',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

/**
 * The pattern and key-block half of the standard, as cases.
 *
 * The known-value half cannot be stated as a constant, because a known value is whatever the
 * deployment's secret store handed the redactor — see {@link conformanceCasesFor}.
 */
export const REDACTION_CONFORMANCE_CASES: readonly RedactionConformanceCase[] = [
  {
    name: 'private-key-block',
    input: `The reporter pasted a key into the ticket:\n${FABRICATED_PEM}\nplease rotate it.`,
    forbidden: ['BEGIN RSA PRIVATE KEY', 'ZmFrZWtleW1hdGVyaWFs'],
    retained: ['please rotate it.'],
  },
  {
    name: 'access-key-id',
    input: `Deploy fails with ${FABRICATED_ACCESS_KEY_ID} in the logs.`,
    forbidden: [FABRICATED_ACCESS_KEY_ID],
    retained: ['Deploy fails with'],
  },
  {
    name: 'bearer-header',
    input: `curl -H "Authorization: Bearer ${FABRICATED_BEARER}" https://example.invalid/api`,
    forbidden: [FABRICATED_BEARER],
    retained: ['https://example.invalid/api'],
  },
  {
    name: 'assigned-secret',
    input: `The customer left api_token=${FABRICATED_BEARER} in the description.`,
    forbidden: [FABRICATED_BEARER],
    retained: ['in the description.'],
  },
]

/**
 * The corpus for one deployment, including the known-value stage when a value is available.
 *
 * The known-value stage is the half that earns its place — a client's credential is very often in a
 * format nobody described in advance — so a conformance check that could only see the pattern stage
 * would pass a redactor built with an empty secret index.
 *
 * @param knownValue - A value the redactor under test was built to remove. Omit where the caller
 *   has none, which weakens the check to the pattern and key-block stages and is stated as such.
 */
export const conformanceCasesFor = (knownValue?: string): readonly RedactionConformanceCase[] => {
  if (knownValue === undefined || knownValue.length === 0) {
    return REDACTION_CONFORMANCE_CASES
  }

  return [
    ...REDACTION_CONFORMANCE_CASES,
    {
      name: 'known-value-verbatim',
      input: `The board credential is ${knownValue} according to the comment.`,
      forbidden: [knownValue],
      retained: ['according to the comment.'],
    },
    {
      name: 'known-value-base64',
      input: `Encoded: ${Buffer.from(knownValue, 'utf8').toString('base64')}`,
      forbidden: [Buffer.from(knownValue, 'utf8').toString('base64')],
    },
  ]
}

/**
 * Run the corpus and report every case the redactor failed.
 *
 * @returns One sentence per failure, empty when the redactor meets the standard.
 */
export const checkRedactorConformance = (
  redactor: PromptRedactor,
  options: { readonly knownValue?: string } = {},
): readonly string[] => {
  const failures: string[] = []

  for (const testCase of conformanceCasesFor(options.knownValue)) {
    let output: string

    try {
      output = redactor.redact(testCase.input)
    } catch (thrown) {
      failures.push(
        `${testCase.name}: the redactor threw (${thrown instanceof Error ? thrown.message : String(thrown)})`,
      )
      continue
    }

    for (const fragment of testCase.forbidden) {
      if (output.includes(fragment)) {
        failures.push(`${testCase.name}: the credential survived redaction`)
      }
    }

    for (const fragment of testCase.retained ?? []) {
      if (!output.includes(fragment)) {
        failures.push(`${testCase.name}: surrounding content was destroyed along with the secret`)
      }
    }
  }

  return failures
}

/**
 * Refuse a redactor that does not meet the standard.
 *
 * Called at wiring time rather than per prompt: the answer cannot change between prompts, and a
 * deployment learning at three in the morning that its redactor is a pass-through has learned it
 * from a stored ticket.
 *
 * @throws If any case fails, naming every one of them.
 */
export const assertRedactorConformance = (
  redactor: PromptRedactor,
  options: { readonly knownValue?: string } = {},
): void => {
  const failures = checkRedactorConformance(redactor, options)

  if (failures.length > 0) {
    throw new Error(
      `The configured prompt redactor does not meet the run-output redaction standard FR-163 requires: ${failures.join('; ')}.`,
    )
  }
}

/** How much redacted comment text one prompt may carry. */
export const DEFAULT_STORED_COMMENT_CHARACTERS = 20_000

/** A hard stop on stored comment count, for a ticket with a long tail of very short comments. */
export const DEFAULT_STORED_COMMENTS = 50

export interface CommentBound {
  readonly maxCharacters?: number
  readonly maxComments?: number
}

/** What a bound kept, and what it cost. */
export interface BoundedComments {
  readonly kept: readonly string[]
  /** How many the bound dropped. Oldest first, so what is kept is the most recent context. */
  readonly dropped: number
}

/**
 * Keep the newest comments that fit; drop oldest-first (FR-163).
 *
 * A single comment larger than the whole budget is dropped too. Keeping it would mean the bound was
 * not a bound, and the newest comments — the ones most likely to describe what is actually wanted —
 * would be the ones sacrificed to make room for it.
 */
export const boundComments = (
  comments: readonly string[],
  bound: CommentBound = {},
): BoundedComments => {
  const maxCharacters = bound.maxCharacters ?? DEFAULT_STORED_COMMENT_CHARACTERS
  const maxComments = bound.maxComments ?? DEFAULT_STORED_COMMENTS
  const kept: string[] = []
  let used = 0

  for (const comment of [...comments].reverse()) {
    if (kept.length >= maxComments || used + comment.length > maxCharacters) {
      break
    }

    used += comment.length
    kept.push(comment)
  }

  kept.reverse()

  return { kept, dropped: comments.length - kept.length }
}

/** {@link PromptParts} after redaction, with the total drop count across both bounds. */
export interface RedactedPromptParts {
  readonly title: string
  readonly url: string
  readonly body: string | null
  readonly comments: readonly string[]
  /** The connector's oldest-first drops plus this module's, so the record says what was lost. */
  readonly truncatedComments: number
}

export interface RedactPromptPartsOptions extends CommentBound {
  readonly redactor: PromptRedactor
}

/**
 * Redact every ticket-derived layer, then bound what is stored.
 *
 * The **URL is redacted too**, and that is deliberate rather than incidental: a Jira link can carry
 * a query string, and `url-credentials` is one of the patterns the standard covers. A layer exempted
 * from redaction because it "is only an identifier" is the layer a credential eventually arrives in.
 *
 * @param parts - What the connector assembled, platform-authored comments already excluded (FR-161).
 * @param options - The redactor and the storage bound.
 */
export const redactPromptParts = (
  parts: PromptParts,
  options: RedactPromptPartsOptions,
): RedactedPromptParts => {
  const { redactor } = options
  const redactedComments = parts.comments.map((comment) => redactor.redact(comment))
  const bounded = boundComments(redactedComments, {
    ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
    ...(options.maxComments === undefined ? {} : { maxComments: options.maxComments }),
  })

  return {
    title: redactor.redact(parts.title),
    url: redactor.redact(parts.url),
    body: parts.body === null ? null : redactor.redact(parts.body),
    comments: bounded.kept,
    truncatedComments: parts.truncatedComments + bounded.dropped,
  }
}
