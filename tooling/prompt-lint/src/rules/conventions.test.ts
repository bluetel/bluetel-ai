// cspell:ignore harrytwigg
import { describe, expect, it } from 'vitest'

import {
  artifactFixture,
  expectDoesNotFire,
  expectFires,
  skillsConfigFixture,
} from '../test-helpers'

import { configMismatch } from './conventions'

/**
 * The live defect's own words. `harrytwigg` is spelled in a template literal rather than
 * in prose so the spell checker sees a value, not a sentence.
 */
const WRONG_OWNER = 'harrytwigg'
const WRONG_SLUG = `${WRONG_OWNER}/universal-react-monorepo`
const WRONG_PREFIX = 'URM'

/**
 * Real paths in this tree, so the "a real directory is not a GitHub owner" guard is
 * actually exercised rather than trivially satisfied by an empty index.
 */
const PATHS = [
  '.agents/remote-workflow-instructions.md',
  '.agents/skills.config',
  'tooling/skills/catalog/review/SKILL.md',
  'tooling/prompt-lint/src/rules/conventions.ts',
  'references/notes.md',
]

const guidance = (content: string, path = '.agents/remote-workflow-instructions.md') =>
  artifactFixture({ path, kind: 'guidance', content, skillRoot: null })

const fires = (content: string) => expectFires(configMismatch, guidance(content), { paths: PATHS })

const quiet = (content: string) =>
  expectDoesNotFire(configMismatch, guidance(content), { paths: PATHS })

describe('conventions/config-mismatch', () => {
  describe('fires on', () => {
    it('the live defect, naming both the asserted slug and the configured one', () => {
      // Verbatim from `.agents/remote-workflow-instructions.md`, the sentence under
      // "Never invent them" — which is what makes it the strongest fires-case there is.
      const [finding] = fires(
        `  **Never invent them.** For this repo: ticket prefix \`${WRONG_PREFIX}\`, repo \`${WRONG_SLUG}\`,\n  PRs target \`main\`.\n`,
      )

      expect(finding.line).toBe(1)
      expect(finding.message).toContain(WRONG_PREFIX)
      expect(finding.message).toContain('ticket_prefix')
      expect(finding.remediation).toContain('.agents/skills.config')
    })

    it('the live defect once per convention, and not on its correct base branch', () => {
      const findings = fires(
        `  **Never invent them.** For this repo: ticket prefix \`${WRONG_PREFIX}\`, repo \`${WRONG_SLUG}\`,\n  PRs target \`main\`.\n`,
      )

      // Exactly two: the prefix and the slug. `PRs target \`main\`` agrees with
      // `base_branch=main`, and a rule that also reported that is a rule nobody will run.
      expect(findings).toHaveLength(2)
      expect(findings.map((finding) => finding.message).join(' ')).toContain(WRONG_SLUG)
    })

    it('a slug in a `gh -R` flag, which carries its own repository context', () => {
      const [finding] = fires(`Run \`gh pr list -R ${WRONG_SLUG}\` to see the queue.\n`)

      expect(finding.message).toContain('bluetel/bluetel-ai')
    })

    it('a slug in a github.com URL, with no anchoring word needed', () => {
      const [finding] = fires(`See \`github.com/${WRONG_SLUG}\` for the issue tracker.\n`)

      expect(finding.message).toContain(WRONG_SLUG)
    })

    it('a `PREFIX-<digits>` ticket token on a line about commits', () => {
      const [finding] = fires('Commit subject: `ABC-123: <description>`.\n')

      expect(finding.message).toContain('ABC')
      expect(finding.message).toContain('no ticket key to use')
    })

    it('a `PREFIX-<placeholder>` ticket token, which asserts the prefix just as firmly', () => {
      // Line 84 of the live defect: the number is a placeholder, the prefix is not.
      const [finding] = fires(
        `Commit subject. Conventional format: \`${WRONG_PREFIX}-<n>: <description>\`.\n`,
      )

      expect(finding.message).toContain(WRONG_PREFIX)
    })

    it('a wrong base branch named by role', () => {
      const [finding] = fires('The base branch is `develop`; never push to it directly.\n')

      expect(finding.message).toBe(
        'Names `develop` as the base branch, but `.agents/skills.config` says `base_branch=main`.',
      )
    })

    it('a wrong base branch named as the PR target', () => {
      const [finding] = fires('Open the draft PR targeting `trunk` first.\n')

      expect(finding.message).toContain('base_branch=main')
    })

    it('a wrong staging branch named by role', () => {
      const [finding] = fires('The staging branch is `develop`, and only merges land there.\n')

      expect(finding.message).toBe(
        'Names `develop` as the staging branch, but `.agents/skills.config` says `staging_branch=staging`.',
      )
    })

    it('a mismatched prefix when the config does name a real prefix', () => {
      const findings = expectFires(configMismatch, guidance('Ticket prefix: `ABC`.\n'), {
        paths: PATHS,
        skillsConfig: skillsConfigFixture({ ticket_prefix: 'XYZ' }),
      })

      expect(findings[0].message).toContain('ticket_prefix=XYZ')
    })
  })

  /**
   * The half that matters. `owner/repo` is shaped exactly like a relative path and a branch
   * name is an English word, so every case below is a shape the discriminators deliberately
   * exclude. Deleting one of these tests is how the gate starts flooding.
   */
  describe('does not fire on', () => {
    it('the configured slug, prefix, and branches', () => {
      quiet(
        'The repo is `bluetel/bluetel-ai`. PRs target `main`. The staging branch is `staging`.\n',
      )
    })

    it('a relative path that merely looks like a slug', () => {
      quiet('See `references/notes.md` and `tooling/skills/catalog/review` for the procedure.\n')
    })

    it('a two-segment path next to the word repo but not in a code span', () => {
      // Line 50 of the live defect: "Conventions (ticket prefix, repo owner/name, branch
      // and commit shape) come from …". `owner/name` is anchored by `repo` and is two
      // segments; the code-span requirement is the only thing that saves it.
      quiet('Conventions (ticket prefix, repo owner/name, branch and commit shape) come from\n')
    })

    it('a two-segment path whose first segment is a real directory here', () => {
      quiet('The repo `tooling/skills` holds the catalog.\n')
    })

    it('a git ref that happens to be two segments next to `remote`', () => {
      quiet('Fetch the remote `origin/main` before you branch.\n')
    })

    it('a template slug carrying variable syntax', () => {
      quiet('Push to the repo `{owner}/{repo}` named in the config.\n')
    })

    it('a slug inside a fenced code block', () => {
      quiet(`Example invocation:\n\n\`\`\`sh\ngh pr list -R ${WRONG_SLUG}\n\`\`\`\n`)
    })

    it('a slug inside an HTML comment', () => {
      quiet(`<!-- historical: this used to say repo \`${WRONG_SLUG}\` -->\n\nNothing to see.\n`)
    })

    it('a ticket token inside a fenced code block', () => {
      quiet('Commit shape:\n\n```sh\ngit commit -m "ABC-123: thing"\n```\n')
    })

    it('a ticket token inside an HTML comment', () => {
      quiet('<!-- the old commit convention was `ABC-123: thing` -->\n\nNothing to see.\n')
    })

    it('a ticket-shaped token on a line with no ticket-convention word', () => {
      // `ABC-123` alone is not a claim about the ticket convention; it could be anything.
      quiet('The fixture is named `ABC-123` in the snapshot directory.\n')
    })

    it('a standards or requirement id shaped exactly like a ticket token', () => {
      // Every one of these is `PREFIX-<digits>` on a line carrying a ticket word, and
      // none of them is a ticket. This test is why the exclusion list exists.
      quiet(
        'Commit the `UTF-8` fixture. The branch verifies FR-007, SC-004, RFC-2119 and SHA-256.\n',
      )
    })

    it('a branch name used as an ordinary English word', () => {
      quiet('The main procedure is in the skill; staging a change is step two.\n')
    })

    it('a merge target that is not claimed to be the base or staging branch', () => {
      // "merge into `x`" carries no role word, so it is not read as a base-branch claim.
      // A deliberate miss: the alternative fires on every code-span word near "merge".
      quiet('Merge into `release-2024` only after the freeze.\n')
    })

    it('a non-branch value in a code span after a PR verb', () => {
      quiet('Convert the PR into `draft` before you push again.\n')
    })

    it('a placeholder branch name', () => {
      quiet('The base branch is `{base_branch}` from the config.\n')
    })

    it('an artifact evaluated with no skills.config at all', () => {
      expectDoesNotFire(
        configMismatch,
        guidance(
          `Ticket prefix \`${WRONG_PREFIX}\`, repo \`${WRONG_SLUG}\`, PRs target \`dev\`.\n`,
        ),
        { paths: PATHS, skillsConfig: null },
      )
    })

    it('a convention whose key is absent from the config', () => {
      // `repo_owner` is set and `repo_name` is not, so there is no configured slug to
      // contradict. A partially configured convention is not a violated one.
      expectDoesNotFire(configMismatch, guidance(`The repo is \`${WRONG_SLUG}\`.\n`), {
        paths: PATHS,
        skillsConfig: skillsConfigFixture({ repo_name: '' }),
      })
    })

    it('a table row illustrating a config key, verbatim from the catalog', () => {
      // `tooling/skills/catalog/jira-ticket/SKILL.md:20`. Four of the six false positives
      // the first real run produced were this shape: an Example column of a table whose
      // rows are config keys. The row names the key, so it points at the config.
      quiet(
        '| `jira_epic_key`    | Parent epic every new ticket is linked to            | `ACME-100`           |\n',
      )
    })

    it('a value flagged as an example, verbatim from the catalog', () => {
      // `tooling/skills/catalog/pr-creation/SKILL.md:30`, minus the config key, so this
      // exercises the `e.g.` marker on its own rather than the key mention.
      quiet('Substitute the actual ticket id (e.g. the one the user gives, `BTAI-1234`).\n')
    })

    it('a line that hands the reader to the config file by name', () => {
      quiet('Ticket prefix `ABC` — superseded; read `.agents/skills.config` instead.\n')
    })

    it('a kind the rule does not apply to, as declared', () => {
      expect(configMismatch.appliesTo).toEqual(['catalog-skill', 'installed-skill', 'guidance'])
      expect(configMismatch.appliesTo).not.toContain('speckit-template')
    })
  })

  it('declares the contract’s severity, dimension, scope and needs', () => {
    expect(configMismatch.id).toBe('conventions/config-mismatch')
    expect(configMismatch.defaultSeverity).toBe('warn')
    expect(configMismatch.dimension).toBe('correctness')
    expect(configMismatch.scope).toBe('artifact')
    expect(configMismatch.needs).toEqual(['view'])
  })
})
