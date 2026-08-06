import { createWorkspaceInput } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterInputs } from '@sisyphus-admin/trpc'

import type { WorkspaceEntryReadouts } from './workspace-listing'

/**
 * The workspace editor's values, and the one place they become a request (T082, FR-109..FR-111,
 * FR-125).
 *
 * ## An edit submits the whole entry list
 *
 * There is no patch API and there should not be one: an edit publishes a new immutable version, and
 * "what did version 3 contain" has to be answerable by reading version 3 rather than by replaying
 * a sequence of edits. So the editor loads the current version's entries, the admin changes them,
 * and the **whole list** goes back as the next version's contents.
 *
 * ## Why the form's state is all strings, and position is not in it
 *
 * Because that is what a control holds. `position` is the exception: it is not a control at all,
 * it is where the row sits in the list, so it is derived from the index at submission time. A
 * `position` field an admin could type into would be a second, contradictable source for the order
 * that is already on screen.
 *
 * ## Why it validates with the server's own schema
 *
 * `createWorkspaceInput` carries `workspaceEntryListInput`, which is where FR-110's exactly-one
 * primary and FR-111's distinct-subdirectory rules live. Parsing with it here makes the form and
 * the resolver *the same rule* rather than two rules that agree today — and it means a rule
 * tightened on the server tightens here with no second edit.
 */

/** What `admin.workspaces.create` accepts. Inferred, never mirrored. */
export type CreateWorkspaceValues = RouterInputs['admin']['workspaces']['create']

/** What `admin.workspaces.update` accepts. Inferred, never mirrored. */
export type UpdateWorkspaceValues = RouterInputs['admin']['workspaces']['update']

/** One repository, as the controls hold it. */
export interface WorkspaceEntryDraft {
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly subdirectory: string
  readonly isPrimary: boolean
}

/** Everything the workspace editor holds. */
export interface WorkspaceDraft {
  readonly name: string
  readonly description: string
  readonly entries: readonly WorkspaceEntryDraft[]
}

/** A blank repository row. The first one added is primary, because a version needs exactly one. */
export const EMPTY_ENTRY: WorkspaceEntryDraft = {
  repositoryUrl: '',
  baseBranch: '',
  subdirectory: '',
  isPrimary: false,
}

/** A blank workspace: one repository, already marked primary (FR-110). */
export const EMPTY_WORKSPACE: WorkspaceDraft = {
  name: '',
  description: '',
  entries: [{ ...EMPTY_ENTRY, isPrimary: true }],
}

/** Where an error belongs. Entry errors are keyed by row, so the offending row is the one marked. */
export interface WorkspaceDraftErrors {
  readonly name?: FieldErrorContent
  readonly description?: FieldErrorContent
  /** A refusal about the entry list as a whole — the primary rule, the subdirectory rule. */
  readonly entries?: FieldErrorContent
  /** Per-row refusals, keyed by row index. */
  readonly rows?: Readonly<Record<number, FieldErrorContent>>
}

/** What to do about each field when it is refused (FR-031). */
const FIELD_ACTIONS = {
  name: 'Name the workspace — it is how everyone else will find this repository set.',
  description: 'Say what this repository set is for, or leave it blank.',
  entries: 'Give the version at least one repository, exactly one of them primary.',
  row: 'Enter a git remote, a base branch and a checkout subdirectory for this repository.',
  primary: 'Mark exactly one repository primary — it is the one skills are resolved from (FR-058).',
  subdirectory: 'Give each repository its own subdirectory; two cannot check out over each other.',
} as const

/** `E_WORKSPACE_ENTRIES` — searchable, stable, and quotable in a ticket. */
export const workspaceFieldCode = (field: string): string =>
  `E_WORKSPACE_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/** Load a published version's entries back into the editor, so an edit starts from what exists. */
export const draftFromVersion = (workspace: {
  readonly name: string
  readonly description: string | null
  readonly entries: readonly WorkspaceEntryReadouts[]
}): WorkspaceDraft => ({
  name: workspace.name,
  description: workspace.description ?? '',
  entries: workspace.entries.map((entry) => ({
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
    subdirectory: entry.subdirectory,
    isPrimary: entry.role === 'primary',
  })),
})

/**
 * Mark one row primary and every other row not (FR-110).
 *
 * Expressed as a whole-list operation rather than as a per-row toggle, because "exactly one" is a
 * property of the list. A checkbox per row that only set its own value would let an admin build a
 * version with two primaries or none, and the refusal would arrive from the database.
 */
export const withPrimaryAt = (
  entries: readonly WorkspaceEntryDraft[],
  index: number,
): readonly WorkspaceEntryDraft[] =>
  entries.map((entry, position) => ({ ...entry, isPrimary: position === index }))

/**
 * Remove one row, keeping the exactly-one-primary invariant true (FR-110).
 *
 * Removing the primary promotes the first remaining row. The alternative — leaving the list with no
 * primary and refusing at submit — makes the admin repair a state the deletion created.
 */
export const withoutEntryAt = (
  entries: readonly WorkspaceEntryDraft[],
  index: number,
): readonly WorkspaceEntryDraft[] => {
  const remaining = entries.filter((_, position) => position !== index)
  if (remaining.length === 0 || remaining.some((entry) => entry.isPrimary)) {
    return remaining
  }
  return withPrimaryAt(remaining, 0)
}

/** A blank optional field is absent, not empty — the two mean different things to the schema. */
const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim()

/** The candidate entry list, before validation. Shapes only; every rule is the schema's. */
const toEntryCandidates = (entries: readonly WorkspaceEntryDraft[]): unknown[] =>
  entries.map((entry, position) => ({
    repositoryUrl: entry.repositoryUrl.trim(),
    baseBranch: entry.baseBranch.trim(),
    subdirectory: entry.subdirectory.trim(),
    isPrimary: entry.isPrimary,
    position,
  }))

/** Either the request to send, or where the editor went wrong. */
export type WorkspaceSubmission =
  | { readonly ok: true; readonly input: CreateWorkspaceValues }
  | { readonly ok: false; readonly errors: WorkspaceDraftErrors }

/**
 * Which refusal a list-level issue is. The schema's `superRefine` messages are the two rules
 * FR-110 and FR-111 state, and each needs its own next action.
 */
const listAction = (message: string): string => {
  if (message.includes('primary')) return FIELD_ACTIONS.primary
  if (message.includes('subdirectory')) return FIELD_ACTIONS.subdirectory
  return FIELD_ACTIONS.entries
}

/**
 * Turn the editor's values into an `admin.workspaces.create` request, or into field errors.
 *
 * @param draft - Everything the controls hold.
 * @returns The parsed input, or a refusal per offending control. Never both, and never neither.
 */
export const toCreateWorkspaceInput = (draft: WorkspaceDraft): WorkspaceSubmission => {
  const parsed = createWorkspaceInput.safeParse({
    name: draft.name.trim(),
    description: optionalText(draft.description),
    entries: toEntryCandidates(draft.entries),
  })

  if (parsed.success) {
    return { ok: true, input: parsed.data }
  }

  const rows: Record<number, FieldErrorContent> = {}
  let errors: WorkspaceDraftErrors = {}

  for (const issue of parsed.error.issues) {
    const [head, index] = issue.path

    if (head === 'name') {
      errors = { ...errors, name: { code: workspaceFieldCode('name'), action: FIELD_ACTIONS.name } }
      continue
    }

    if (head === 'description') {
      errors = {
        ...errors,
        description: {
          code: workspaceFieldCode('description'),
          action: FIELD_ACTIONS.description,
        },
      }
      continue
    }

    if (head === 'entries' && typeof index === 'number') {
      rows[index] ??= { code: workspaceFieldCode('entry'), action: FIELD_ACTIONS.row }
      continue
    }

    errors = {
      ...errors,
      entries: { code: workspaceFieldCode('entries'), action: listAction(issue.message) },
    }
  }

  return {
    ok: false,
    errors: Object.keys(rows).length === 0 ? errors : { ...errors, rows },
  }
}

/** Either the update to send, or where the editor went wrong. */
export type WorkspaceUpdateSubmission =
  | { readonly ok: true; readonly input: UpdateWorkspaceValues }
  | { readonly ok: false; readonly errors: WorkspaceDraftErrors }

/**
 * The same submission, addressed to an existing workspace (FR-125).
 *
 * Built from {@link toCreateWorkspaceInput} rather than beside it, so the two cannot disagree about
 * what a valid entry list is — the difference between publishing version 1 and publishing version
 * n+1 is which id it is addressed to, and nothing else.
 */
export const toUpdateWorkspaceInput = (
  workspaceId: string,
  draft: WorkspaceDraft,
): WorkspaceUpdateSubmission => {
  const submission = toCreateWorkspaceInput(draft)
  if (!submission.ok) return submission

  return {
    ok: true,
    input: {
      workspaceId,
      name: submission.input.name,
      description: submission.input.description ?? null,
      entries: submission.input.entries,
    },
  }
}
