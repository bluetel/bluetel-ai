/**
 * The scan that keeps FR-057 true (T123).
 *
 * ## Why a source-level test rather than a behavioural one
 *
 * FR-057 says every client- and repository-specific delivery convention is read from the target
 * repository's skills and is **not hardcoded in any Sisyphus project**. That requirement has an
 * unusual property: breaking it does not break anything. A run against a repository whose skill is
 * complete behaves identically whether or not there is a fallback behind it, so every behavioural
 * test in this directory passes with `?? 'main'` sitting in the delivery path, and the defect only
 * surfaces against a client whose skill is incomplete — as a pull request proposed onto a branch
 * nobody chose, in somebody else's repository, which is the expensive place to find out.
 *
 * So the assertion has to be about the source. This module reads the production files of this
 * directory and fails on a literal that looks like a convention.
 *
 * ## What it forbids
 *
 * Four families, each one a thing an unhelpfully helpful default would reach for:
 *
 * - **Branch prefixes** — `feature/`, `bugfix/`, `hotfix/`, `chore/` and friends.
 * - **Target branches** — the handful of names repositories use for their integration line.
 * - **Pull request templates** — the headings and trailers a generated description would carry.
 * - **Board columns** — the ticket states a transition would move to.
 *
 * Plus a fifth check that catches the same mistake spelled as a name rather than a value:
 * identifiers like `DEFAULT_BASE_BRANCH` or `FALLBACK_BRANCH_PREFIX`.
 *
 * ## What it deliberately does not scan
 *
 * **Comments.** A convention named in prose is documentation — this file's own paragraphs above
 * name half the forbidden list — and a scanner that could not tell the two apart would either be
 * useless or would push the explanation out of the code. Comments are stripped, then only string
 * and template literals are examined, because a convention has to be a literal before it can be
 * acted on.
 *
 * **Test files.** A test must be able to name a base branch: `develop-step.test.ts` asserts that a
 * proposal missing one halts, and it cannot do that without writing one down. Excluding tests is
 * what keeps the scan sharp enough to be worth having.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One forbidden family, with the wording used when it is found. */
export interface ForbiddenConvention {
  readonly name: string
  readonly pattern: RegExp
  readonly why: string
}

/**
 * The literals no production module in this directory may contain.
 *
 * Patterns are matched against **whole literal values**, so a branch name embedded in a longer
 * sentence — an error message quoting what a skill said — does not trip them.
 */
export const FORBIDDEN_LITERALS: readonly ForbiddenConvention[] = [
  {
    name: 'branch prefix',
    pattern: /^(?:feature|feat|bugfix|fix|hotfix|release|chore|task|story)[/-]/iu,
    why: 'a branch naming rule belongs to the repository’s sisyphus-dev skill (FR-057)',
  },
  {
    name: 'target branch',
    pattern: /^(?:main|master|develop|development|staging|trunk|production|prod|release)$/iu,
    why: 'the base branch a change is proposed onto is the repository’s to state (FR-057)',
  },
  {
    name: 'pull request template',
    pattern: /(?:^#{1,3}\s|^-\s*\[\s?\]|closes\s+#|fixes\s+#|co-authored-by|generated with|<!--)/iu,
    why: 'pull request content and readiness come from sisyphus-dev, not from a template here',
  },
  {
    name: 'board column',
    pattern:
      /^(?:to\s?do|backlog|in[\s_-]?progress|in[\s_-]?review|code[\s_-]?review|ready[\s_-]?for[\s_-]?review|peer[\s_-]?review|awaiting[\s_-]?review|qa|testing|done|closed|resolved)$/iu,
    why: 'a ticket state is the client’s board’s vocabulary, read from the skill (FR-057)',
  },
]

/**
 * The forge's own pull-request state vocabulary.
 *
 * Exempt because these are values of a type **this** codebase defines (`ReviewTargetState`) to
 * describe what a pull request is, not values read from a customer's system. `closed` collides
 * with the board-column family, and refusing it would mean either weakening that family — which
 * is where a hardcoded ticket transition would actually land — or spelling the forge's states
 * unnaturally to dodge the scan.
 *
 * Kept to exactly these three. It is an allowance, and an allowance that grows is an allowlist,
 * which is how a scan like this stops meaning anything.
 */
export const PROTOCOL_VOCABULARY = ['open', 'closed', 'merged'] as const

/** Identifier names that promise a default for something that must not have one. */
export const FORBIDDEN_IDENTIFIERS =
  /\b(?:DEFAULT|FALLBACK)_[A-Z0-9_]*(?:BRANCH|BASE|REMOTE|PREFIX|TEMPLATE|TITLE|STATE|TRANSITION|COLUMN)[A-Z0-9_]*\b|\b[A-Z0-9_]*(?:BRANCH|BASE|TICKET)[A-Z0-9_]*_(?:DEFAULT|FALLBACK)\b/u

/** One violation, located precisely enough to fix. */
export interface ConventionViolation {
  readonly file: string
  readonly line: number
  readonly kind: string
  readonly found: string
  readonly why: string
}

/**
 * Remove comments, preserving line numbering.
 *
 * Newlines inside a block comment are kept so a violation's reported line stays the real one; the
 * rest of the comment becomes blanks. Strings are tracked while scanning so a `//` inside a URL
 * literal does not swallow the rest of the line.
 */
export const stripComments = (source: string): string => {
  const out: string[] = []
  let index = 0
  let quote: string | undefined

  while (index < source.length) {
    const character = source[index] ?? ''
    const next = source[index + 1] ?? ''

    if (quote !== undefined) {
      out.push(character)

      if (character === '\\') {
        out.push(next)
        index += 2
        continue
      }

      if (character === quote) {
        quote = undefined
      }

      index += 1
      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character
      out.push(character)
      index += 1
      continue
    }

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') {
          out.push('\n')
        }
        index += 1
      }
      index += 2
      continue
    }

    out.push(character)
    index += 1
  }

  return out.join('')
}

/** Every string and template literal in already-comment-stripped code. */
const LITERAL =
  /'(?<single>(?:[^'\\\n]|\\.)*)'|"(?<double>(?:[^"\\\n]|\\.)*)"|`(?<backtick>(?:[^`\\]|\\.)*)`/gu

const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length

/**
 * Scan one module's source.
 *
 * @param file - Reported on each violation; not read.
 * @param source - The module's text, comments included.
 */
export const scanSource = (file: string, source: string): readonly ConventionViolation[] => {
  const code = stripComments(source)
  const violations: ConventionViolation[] = []

  for (const match of code.matchAll(LITERAL)) {
    const value = match.groups?.single ?? match.groups?.double ?? match.groups?.backtick ?? ''

    if ((PROTOCOL_VOCABULARY as readonly string[]).includes(value)) {
      continue
    }

    for (const forbidden of FORBIDDEN_LITERALS) {
      if (forbidden.pattern.test(value)) {
        violations.push({
          file,
          line: lineOf(code, match.index),
          kind: forbidden.name,
          found: value,
          why: forbidden.why,
        })
      }
    }
  }

  for (const [index, text] of code.split('\n').entries()) {
    const named = FORBIDDEN_IDENTIFIERS.exec(text)

    if (named !== null) {
      violations.push({
        file,
        line: index + 1,
        kind: 'defaulted convention',
        found: named[0],
        why: 'a name promising a default for a convention is a default (FR-057)',
      })
    }
  }

  return violations
}

/** This module names every forbidden pattern by necessity, so it excludes itself. */
export const SCAN_EXCLUDED = ['hardcoded-convention-scan.ts']

/**
 * Scan every production module of a directory.
 *
 * @param directory - Absolute path. Test files and this scanner are skipped.
 */
export const scanDirectory = (directory: string): readonly ConventionViolation[] =>
  readdirSync(directory)
    .filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !SCAN_EXCLUDED.includes(name),
    )
    .flatMap((name) => scanSource(name, readFileSync(join(directory, name), 'utf8')))
