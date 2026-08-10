/**
 * The vocabulary of a workflow-scoped executor credential (T053, FR-037).
 *
 * ## Why it lives in this package and not beside a mint or a mount
 *
 * Two hosts have to agree on this exactly: the control plane, which signs, and whichever
 * application mounts the machine surface, which verifies. Neither can import the other — the
 * control plane is a private workspace member with no `exports` map, and making the panel depend
 * on the thing that provisions instances would be worse than the duplication it avoided. So both
 * copies used to be written out by hand, pinned to their literals by test, with a note in each
 * saying the other existed.
 *
 * That is a security defect waiting for a divergent edit, not a documentation problem. A mismatch
 * is not subtle in production — every machine request fails closed — but it is silent until an
 * instance is running, which is the worst moment to discover it. `@bluetel-ai/sisyphus-api` is the
 * one package both hosts already depend on, so the vocabulary lives here and there is exactly one
 * definition of each constant.
 *
 * ## Why the claims make cross-workflow use impossible to construct rather than merely refused
 *
 * There is **no claim that can name two workflows**. The run is identified by `sub`, a single
 * string, and there is no scope list, no audience array of workflow ids and no `workflows` claim —
 * so a token authorising two runs is not something the format can express. Widening a credential
 * would take a second token, and a second token takes the signing secret.
 *
 * That is the difference between this and a refusal after the fact. A `scope: ['a','b']` design
 * would be *constructible* and would depend on every resolver remembering to intersect it with the
 * request; the failure mode of forgetting is a silent cross-workflow write. Here the request
 * carries one workflow because the credential carries one workflow, and
 * `assertMachineWorkflowMatches` in `../procedures.ts` is a backstop against a *payload* naming
 * another run, not the primary mechanism.
 *
 * `aud` closes the other direction: the credential is addressed to the machine surface and to
 * nothing else, so presenting it on the interactive surface fails on the audience before any
 * lookup happens (FR-005, FR-037).
 *
 * ## Two expiries, and the shorter one governs
 *
 * `exp` on the token is a **hard ceiling** on the signed material. It is not the short window
 * FR-037 asks for and is not meant to be: the short window is `scoped_credentials.expires_at`,
 * which `machineProcedure` checks on every request and which `machine.renewCredential` moves
 * forward {@link SCOPED_CREDENTIAL_WINDOW_MS} at a time. A credential is good only while **both**
 * hold, so the effective life of one is the row's window, and the ceiling is what stops a token
 * that escaped into a log outliving the run whatever happens to the row.
 *
 * The ceiling is why the token cannot carry the *short* expiry as its `exp`: renewal deliberately
 * puts nothing new on the wire — it extends the row the executor is already authenticated against
 * — so a token whose `exp` was the row's original expiry would go dead fifteen minutes into a run
 * that had renewed correctly.
 */

/** Who signed it. One issuer, so a token from anywhere else fails before the database is touched. */
export const SCOPED_CREDENTIAL_ISSUER = 'sisyphus-control-plane'

/**
 * Who it is addressed to. The machine surface and nothing else: an executor credential grants
 * nothing on the interactive surface (FR-005), and this is where that is enforced first.
 */
export const SCOPED_CREDENTIAL_AUDIENCE = 'sisyphus-machine-surface'

/**
 * The signature algorithm, pinned.
 *
 * Pinned rather than read from the token's header, because a verifier that trusts `alg` will
 * accept `none`, and will accept an asymmetric algorithm verified against a key it holds as a
 * symmetric secret. Symmetric, because both halves are ours and share one deployed secret.
 */
export const SCOPED_CREDENTIAL_ALGORITHM = 'HS256'

/**
 * `sub` for a real run. The prefix is not decoration: it makes the subject space typed, so
 * {@link workflowIdFromSubject} can refuse a subject of any other shape rather than treating an
 * arbitrary string as a workflow id.
 */
export const WORKFLOW_SUBJECT_PREFIX = 'workflow:'

/**
 * `sub` for a bundle validation run (T047, T200, FR-147), which has no workflow row.
 *
 * ## The refusal this replaces, and what changed under it
 *
 * This constant used to carry a note saying that
 * {@link import('./credential-verification').createScopedCredentialResolver} refuses this subject
 * form on purpose, because there was no row a validation credential could name —
 * `scoped_credentials.workflow_id` is `not null` — and no procedure on the machine surface it could
 * have authorised. Both halves are now closed: `validation_credentials` is the row (see
 * `db/schema/bundle.ts` for why a second table rather than a nullable column) and
 * `machine.reportValidation` is the procedure.
 *
 * **The refusal on the workflow path is unchanged, and must stay.** {@link workflowIdFromSubject}
 * still returns `undefined` for this prefix and `createScopedCredentialResolver` still refuses it
 * with `subject_names_no_workflow`. That is not a leftover: a validation credential must not resolve
 * to a `MachineCredential`, because every `machineProcedure` in the platform reads `ctx.workflowId`
 * and would be handed one that names a run that does not exist. The two subject spaces are resolved
 * by two functions against two tables, and neither can answer for the other.
 */
export const VALIDATION_SUBJECT_PREFIX = 'validation:'

/**
 * The short window, in milliseconds, that a credential is good for before it must be renewed.
 *
 * This is the *same* constant `machine.renewCredential` reopens — `CREDENTIAL_RENEWAL_WINDOW_MS`
 * in `./credential.ts` is an alias of this value rather than a second literal — so the window a
 * mint opens and the window a renewal reopens cannot come apart.
 */
export const SCOPED_CREDENTIAL_WINDOW_MS = 15 * 60 * 1000

/**
 * The hard ceiling on the signed token, in milliseconds. See the note at the top of this file.
 *
 * Twelve hours: long enough that no plausible single run outlives its own credential material,
 * short enough that a token recovered from an instance image months later is inert. A run that
 * genuinely needs longer is a resume, and a resume provisions a fresh instance with a fresh mint.
 */
export const SCOPED_CREDENTIAL_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000

/** The subject naming one run. */
export const workflowSubject = (workflowId: string): string =>
  `${WORKFLOW_SUBJECT_PREFIX}${workflowId}`

/** The subject naming one bundle validation run. */
export const validationSubject = (validationRunId: string): string =>
  `${VALIDATION_SUBJECT_PREFIX}${validationRunId}`

/**
 * The workflow a subject names, or `undefined` when it names something that is not a workflow.
 *
 * Deliberately total and deliberately strict: a subject that is absent, empty, of another kind, or
 * a bare id with no prefix yields `undefined`, and the caller has one thing to check rather than
 * four.
 *
 * @param subject - The `sub` claim as verified, which may be missing entirely.
 */
export const workflowIdFromSubject = (subject: string | undefined): string | undefined => {
  if (subject === undefined) {
    return undefined
  }

  if (!subject.startsWith(WORKFLOW_SUBJECT_PREFIX)) {
    return undefined
  }

  const workflowId = subject.slice(WORKFLOW_SUBJECT_PREFIX.length)
  return workflowId === '' ? undefined : workflowId
}

/**
 * The validation run a subject names, or `undefined` when it names something else (T200, FR-147).
 *
 * The exact mirror of {@link workflowIdFromSubject}, and a separate function rather than a
 * parameterised one for the same reason the two subject prefixes exist at all: **the caller must
 * choose which subject space it is willing to accept, and must not be able to accept whichever one
 * arrived.** A single `idFromSubject` returning `{ kind, id }` would put that choice inside a
 * `switch` at every call site, and the failure mode of forgetting a case is a validation credential
 * authorising a workflow write. Here `createScopedCredentialResolver` can only reach the workflow
 * table and `createValidationCredentialResolver` can only reach the validation table, because
 * neither has a function that will hand it the other kind of id.
 *
 * Deliberately total and deliberately strict, on the same terms: absent, empty, another kind, or a
 * bare id with no prefix all yield `undefined`.
 *
 * @param subject - The `sub` claim as verified, which may be missing entirely.
 */
export const validationRunIdFromSubject = (subject: string | undefined): string | undefined => {
  if (subject === undefined) {
    return undefined
  }

  if (!subject.startsWith(VALIDATION_SUBJECT_PREFIX)) {
    return undefined
  }

  const validationRunId = subject.slice(VALIDATION_SUBJECT_PREFIX.length)
  return validationRunId === '' ? undefined : validationRunId
}

/**
 * The signing key, as the byte string every JOSE implementation wants for an HMAC.
 *
 * @param secret - `SISYPHUS_MACHINE_CREDENTIAL_SECRET`, passed in rather than read here so no
 *   module in this package imports the environment and every test signs with its own value.
 * @throws If the secret is empty — signing with an empty key produces a token anybody can forge,
 *   verifying with one accepts tokens anybody can forge, and doing either silently is worse than
 *   failing loudly.
 */
export const credentialSigningKey = (secret: string): Uint8Array => {
  if (secret === '') {
    throw new Error(
      'The machine credential secret is empty. An empty key would sign executor credentials anybody could forge, and would accept them, so the credential path stops here rather than issuing or admitting one.',
    )
  }

  return new TextEncoder().encode(secret)
}
