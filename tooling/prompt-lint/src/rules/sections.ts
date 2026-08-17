/**
 * `skill/section-missing` — does the body state when it is finished.
 *
 * A procedure with no stated completion condition is a procedure an agent stops
 * executing at an arbitrary point. The `speckit-*` skills already model the answer with
 * a `## Done When` checklist, which is what makes "did the skill finish" answerable.
 */
import type { ArtifactKind } from '../scope'

import { defineRule, requireArtifact } from './define'

const APPLIES_TO: ArtifactKind[] = ['catalog-skill', 'installed-skill']

/**
 * Headings that state a completion condition. Matched on the heading text rather than on
 * an exact string, because "or equivalent" is in the contract and a skill that says
 * `## Acceptance Criteria` has met the requirement.
 */
const COMPLETION_HEADINGS = [
  /^done\s+when\b/i,
  /^completion\s+criteria\b/i,
  /^acceptance\s+criteria\b/i,
  /^definition\s+of\s+done\b/i,
  /^success\s+criteria\b/i,
]

const isCompletionHeading = (text: string): boolean =>
  COMPLETION_HEADINGS.some((pattern) => pattern.test(text.trim()))

export const sectionMissing = defineRule(
  {
    id: 'skill/section-missing',
    defaultSeverity: 'error',
    statement: 'A skill body carries a completion-criteria section (`## Done When` or equivalent).',
    rationale:
      'A procedure with no stated completion condition is a procedure an agent stops executing at an arbitrary point. The Done When checklist is what makes "did the skill finish" answerable.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['view'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const view = artifact.view
    if (view === null) return []

    // Only a skill *body* is a procedure. The `installed-skill` kind covers the whole
    // installed tree, which sweeps in the reference documents a skill reads — and a
    // reference is prose to be consulted, not a procedure with a completion condition.
    // Without this the rule fires on every installed reference file, which is how a rule
    // with a real point gets demoted to noise.
    if (!artifact.path.endsWith('/SKILL.md')) return []

    // A pointer-shaped installed file is a stub by design; only the shared body it names
    // owns the procedure. `install/pointer-mismatch` covers whether it names one.
    if (view.headings.some((heading) => isCompletionHeading(heading.text))) return []

    return [
      {
        line: 1,
        message:
          'No completion-criteria section. Nothing in this body says when the procedure is finished.',
        remediation:
          'Add a `## Done When` section. Each item should be checkable by reading the repository, not by remembering the run.',
      },
    ]
  },
)
