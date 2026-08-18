// cspell:ignore dryrun parnet — deliberate typos: these tests assert that a
// misspelt flag is rejected rather than silently ignored.
// cspell:ignore marklassian intraword — the package the vendored converter replaced, named
// only in the comment recording why, and the term for `_` inside a word.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  configValue,
  jiraSite,
  looksLikeMarkdown,
  markdownToAdfDocument,
  parseArgs,
  parseExtraFields,
  resolveIssueType,
  resolveProject,
  unwrapCodeFence,
  wantsSprint,
  type AdfNode,
} from './jira-scripts'

/** Collect every node of a given type, depth-first. */
const nodesOfType = (node: AdfNode, type: string): AdfNode[] => [
  ...(node.type === type ? [node] : []),
  ...(node.content ?? []).flatMap((child) => nodesOfType(child, type)),
]

const plainText = (node: AdfNode): string =>
  (node.text ?? '') + (node.content ?? []).map(plainText).join('')

describe('markdownToAdfDocument', () => {
  it('renders a bold section label as a strong text run, not literal asterisks', () => {
    const doc = markdownToAdfDocument('**Problem:**\n\nThe play bar does not reset.')

    const [label] = doc.content
    expect(label.type).toBe('paragraph')
    expect(label.content?.[0].text).toBe('Problem:')
    expect(label.content?.[0].marks).toEqual([{ type: 'strong' }])
    // The regression this whole script exists to prevent.
    expect(JSON.stringify(doc)).not.toContain('**')
  })

  it('converts ordered lists into list nodes rather than numbered text', () => {
    const doc = markdownToAdfDocument('1. Open an article\n2. Start a second one\n')

    const ordered = nodesOfType(doc, 'orderedList')
    expect(ordered).toHaveLength(1)
    expect(nodesOfType(doc, 'listItem')).toHaveLength(2)
    expect(plainText(ordered[0])).toContain('Open an article')
    expect(JSON.stringify(doc)).not.toContain('1.')
  })

  it('converts bullets into a bulletList, as CoS sections need', () => {
    const doc = markdownToAdfDocument('**CoS**\n\n- Add the field\n- Default it to false\n')

    expect(nodesOfType(doc, 'bulletList')).toHaveLength(1)
    expect(nodesOfType(doc, 'listItem')).toHaveLength(2)
  })

  it('marks inline code with a code mark rather than backticks', () => {
    const doc = markdownToAdfDocument('It resets to `0:00` on load.')

    const coded = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'code'))
    expect(coded?.text).toBe('0:00')
    expect(JSON.stringify(doc)).not.toContain('`')
  })

  it('turns a bare URL into a link mark', () => {
    const doc = markdownToAdfDocument('Go to https://example.com and play audio')

    const linked = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'link'))
    expect(linked?.marks?.[0].attrs?.href).toBe('https://example.com')
  })

  it('keeps italic placeholders italic, so implementer sections stay marked as unfilled', () => {
    const doc = markdownToAdfDocument('_A summary of how the issue raised was addressed_')

    const italic = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'em'))
    expect(italic?.text).toBe('A summary of how the issue raised was addressed')
  })

  it('produces a doc node the REST API will accept', () => {
    const doc = markdownToAdfDocument('**CoS**\n\n- Add the field\n')

    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
    expect(Array.isArray(doc.content)).toBe(true)
  })

  it('rejects an empty description instead of creating a blank ticket', () => {
    expect(() => markdownToAdfDocument('   \n  ')).toThrow('empty')
  })
})

describe('markdownToAdfDocument, on the constructs the templates and real tickets use', () => {
  it('nests a sub-list inside its parent item rather than flattening it', () => {
    const doc = markdownToAdfDocument('- Outer\n  - Inner\n- Second')

    const [list] = nodesOfType(doc, 'bulletList')
    expect(list.content).toHaveLength(2)
    // The nested list is a child of the first item, not a third sibling item.
    expect(nodesOfType(list.content?.[0] as AdfNode, 'bulletList')).toHaveLength(1)
    expect(nodesOfType(doc, 'listItem')).toHaveLength(3)
  })

  it('joins a hand-wrapped line into one paragraph, and honours a deliberate break', () => {
    const wrapped = markdownToAdfDocument('The play bar does not reset\nwhen a new article starts.')
    expect(plainText(wrapped)).toBe('The play bar does not reset when a new article starts.')
    expect(nodesOfType(wrapped, 'paragraph')).toHaveLength(1)
    expect(nodesOfType(wrapped, 'hardBreak')).toHaveLength(0)

    // Two trailing spaces is markdown's explicit line break — the Story template's shape.
    const broken = markdownToAdfDocument('As a subscriber,  \nI want the price shown.')
    expect(nodesOfType(broken, 'hardBreak')).toHaveLength(1)
    expect(nodesOfType(broken, 'paragraph')).toHaveLength(1)
  })

  it('converts a test matrix table into table nodes', () => {
    const doc = markdownToAdfDocument('| Env | Result |\n| --- | ------ |\n| iOS | broken |')

    expect(nodesOfType(doc, 'table')).toHaveLength(1)
    expect(nodesOfType(doc, 'tableRow')).toHaveLength(2)
    expect(nodesOfType(doc, 'tableHeader')).toHaveLength(2)
    expect(nodesOfType(doc, 'tableCell')).toHaveLength(2)
    expect(JSON.stringify(doc)).not.toContain('|')
  })

  it('leaves a lone pipe in prose as text, since a table needs its divider row', () => {
    const doc = markdownToAdfDocument('The build prints a | between the columns.')

    expect(nodesOfType(doc, 'table')).toHaveLength(0)
    expect(plainText(doc)).toContain('|')
  })

  it('keeps an identifier with underscores intact instead of italicising the middle', () => {
    // The regression an emphasis parser without the intraword guard produces: field ids and
    // snake_case names are everywhere in these tickets.
    const doc = markdownToAdfDocument('Set customfield_12042 and has_author_page on create.')

    expect(plainText(doc)).toBe('Set customfield_12042 and has_author_page on create.')
    expect(nodesOfType(doc, 'text').some((n) => n.marks?.some((m) => m.type === 'em'))).toBe(false)
  })

  it('does not italicise arithmetic or a dash used as punctuation', () => {
    const doc = markdownToAdfDocument('Retries 3 * 4 * 5 times, and a - b - c stays a sum.')

    expect(nodesOfType(doc, 'text').some((n) => n.marks?.some((m) => m.type === 'em'))).toBe(false)
  })

  it('links a labelled markdown link, and leaves a bracketed placeholder alone', () => {
    const doc = markdownToAdfDocument('See [the spec](https://example.com/s) and [Step, from here]')

    const linked = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'link'))
    expect(linked?.text).toBe('the spec')
    expect(linked?.marks?.[0].attrs?.href).toBe('https://example.com/s')
    // Template placeholders are written `[like this]` and must survive as text.
    expect(plainText(doc)).toContain('[Step, from here]')
  })

  it('stops a bare URL at the sentence punctuation that follows it', () => {
    const doc = markdownToAdfDocument('Reproduced on https://staging.example.com/paywall.')

    const linked = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'link'))
    expect(linked?.marks?.[0].attrs?.href).toBe('https://staging.example.com/paywall')
    expect(plainText(doc)).toBe('Reproduced on https://staging.example.com/paywall.')
  })

  it('keeps a blockquote as a quote and a --- as a rule', () => {
    const doc = markdownToAdfDocument('> Quoted from the thread\n\n---\n\nAfter.')

    expect(nodesOfType(doc, 'blockquote')).toHaveLength(1)
    expect(nodesOfType(doc, 'rule')).toHaveLength(1)
    expect(plainText(doc)).toContain('Quoted from the thread')
  })

  it('preserves a code block verbatim, including the markup inside it', () => {
    const doc = markdownToAdfDocument(['```js', 'const a = `**not bold**`', '```'].join('\n'))

    const [code] = nodesOfType(doc, 'codeBlock')
    expect(code.attrs?.language).toBe('js')
    expect(code.content?.[0].text).toBe('const a = `**not bold**`')
  })

  it('closes an unclosed fence at the end of the description rather than dropping it', () => {
    // A truncated fence is a typo, not a reason to publish a ticket missing its evidence.
    const doc = markdownToAdfDocument('**Problem:**\n\n```\nERROR: boom')

    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(1)
    expect(plainText(doc)).toContain('ERROR: boom')
  })

  it('unescapes a backslash-escaped marker instead of emitting either form literally', () => {
    const doc = markdownToAdfDocument('Literal \\*asterisks\\* and a \\_underscore\\_.')

    expect(plainText(doc)).toBe('Literal *asterisks* and a _underscore_.')
    expect(JSON.stringify(doc)).not.toContain('\\\\')
  })
})

describe('unwrapCodeFence', () => {
  it('strips a fence wrapping the whole document, which would render as code', () => {
    expect(unwrapCodeFence('```markdown\n**Problem:**\n\nBroken.\n```')).toBe(
      '**Problem:**\n\nBroken.',
    )
    expect(unwrapCodeFence('```\n**Problem:**\n```')).toBe('**Problem:**')
  })

  it('leaves a genuine inner code block alone', () => {
    const body = '**Problem:**\n\n```bash\nnpm run build\n```\n\n**Expected:**\n\nIt builds.'
    expect(unwrapCodeFence(body)).toBe(body)
  })

  it('leaves a description that opens AND closes with real code blocks alone', () => {
    // The regression: an anchored /^```…```$/ with no `m` flag matched from the first
    // fence to the LAST one, deleting both and unbalancing every fence between. A bug
    // report that leads with a stack trace and ends with a command is the normal shape
    // — SKILL.md tells the writer to include log excerpts — and it was being mangled
    // into one code block full of literal `**`, which is the bug #35 exists to fix.
    const body = [
      '```',
      'ERROR: boom',
      '```',
      '',
      '**Problem:**',
      '',
      'It broke.',
      '',
      '```bash',
      'npm run build',
      '```',
    ].join('\n')

    expect(unwrapCodeFence(body)).toBe(body)
  })

  it('keeps a description that is deliberately a single untagged code block', () => {
    // Indistinguishable from a lazy wrapper by shape, so it is told apart by content:
    // no prose markup inside means it was a real code block, not a wrapper.
    const body = '```\nERROR: boom\n  at thing (file.js:1)\n```'
    expect(unwrapCodeFence(body)).toBe(body)
  })

  it('keeps the fences balanced through conversion for such a description', () => {
    const body = ['```', 'ERROR: boom', '```', '', '**Problem:**', '', 'It broke.'].join('\n')
    const doc = markdownToAdfDocument(body)

    // One codeBlock for the trace, and the Problem label survives as a bold run
    // rather than being swallowed into it as literal asterisks.
    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(1)
    expect(plainText(doc)).toContain('Problem:')
    expect(JSON.stringify(doc)).not.toContain('**')
  })

  it('survives the fenced round trip into ADF', () => {
    const doc = markdownToAdfDocument('```markdown\n**Problem:**\n\nBroken.\n```')

    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(0)
    expect(nodesOfType(doc, 'text')[0].marks).toEqual([{ type: 'strong' }])
  })

  it('still converts a real code block inside a description', () => {
    const doc = markdownToAdfDocument('**Problem:**\n\n```bash\nnpm run build\n```')

    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(1)
  })
})

describe('looksLikeMarkdown', () => {
  it('detects the markup that Jira would otherwise show verbatim', () => {
    expect(looksLikeMarkdown('**Problem:**')).toBe(true)
    expect(looksLikeMarkdown('## Overview')).toBe(true)
    expect(looksLikeMarkdown('- a bullet')).toBe(true)
    expect(looksLikeMarkdown('use `npm ci`')).toBe(true)
  })

  it('does not flag ordinary prose', () => {
    expect(looksLikeMarkdown('The play bar does not reset when a new article starts.')).toBe(false)
  })
})

describe('documented ticket templates and examples', () => {
  const reference = readFileSync(
    join(import.meta.dirname, '../catalog/jira-ticket/references/ticket-types.md'),
    'utf8',
  )

  const STANDARD_CRITERIA = [
    'Unit tests with at least 80% coverage',
    'Feature changes are sufficiently documented',
  ]

  /** The body of a `## <name>` section, up to the next h2. */
  const section = (name: string): string => {
    const after = reference.split(`\n## ${name}\n`)[1]
    expect(after, `section not found: ## ${name}`).toBeDefined()
    return after.split('\n## ')[0]
  }

  /** The nth ```markdown fence within a section (0 = Template, 1 = Example). */
  const fence = (sectionName: string, index: number): string => {
    const fences = [...section(sectionName).matchAll(/```markdown\n([\s\S]*?)\n```/g)]
    expect(fences.length, `expected >${index} fences in ## ${sectionName}`).toBeGreaterThan(index)
    return fences[index][1]
  }

  it.each(['Story', 'Task', 'Bug'])(
    'the %s template and example both convert without literal markdown surviving',
    (type) => {
      for (const index of [0, 1]) {
        const doc = markdownToAdfDocument(fence(type, index))

        // Section labels are bold paragraphs on these boards, never headings.
        expect(nodesOfType(doc, 'heading'), `${type} fence ${index}`).toHaveLength(0)
        expect(JSON.stringify(doc), `${type} fence ${index}`).not.toContain('**')
      }
    },
  )

  it.each(['Story', 'Task'])('the %s example carries the standard acceptance criteria', (type) => {
    const example = fence(type, 1)
    for (const criterion of STANDARD_CRITERIA) expect(example).toContain(criterion)
  })

  it('the Bug example does not carry the standard criteria, which apply to Story and Task', () => {
    const example = fence('Bug', 1)
    for (const criterion of STANDARD_CRITERIA) expect(example).not.toContain(criterion)
  })

  it.each(['Task', 'Bug'])(
    'the %s example leaves the closing-time sections as unfilled placeholders',
    (type) => {
      const example = fence(type, 1)

      // Resolution and Pull Requests belong to the engineer at Peer Review time.
      expect(example).toContain('_A summary of how the issue raised was addressed_')
      expect(example).toMatch(/-\s*_[\w-]+: <link>_/)
    },
  )

  it.each([0, 1])(
    'the Task fence %i leaves UAT Steps as a placeholder, not a written-out sequence',
    (index) => {
      const body = fence('Task', index)
      const steps = body.split('**UAT Steps:**')[1]?.split('**Pull Requests')[0] ?? ''

      expect(steps.trim(), 'Task fence has no UAT Steps section').not.toBe('')
      // Every numbered step is italic — i.e. still boilerplate. A step written as plain text
      // would mean the example shows verification being invented at creation time, which is
      // the engineer's job once there is a deployed change to verify.
      for (const line of steps.split('\n').filter((l) => /^\s*\d+\./.test(l))) {
        expect(line, `UAT step is not a placeholder: ${line}`).toMatch(/^\s*\d+\.\s+_.*_$/)
      }
    },
  )

  it('the Bug example stays near the measured length for real tickets', () => {
    const words = fence('Bug', 1).split(/\s+/).filter(Boolean).length

    // Sampled bugs run ~124 words median, ~161 at p75. Keep the example in that band
    // so it calibrates length rather than licensing an essay.
    expect(words).toBeGreaterThan(60)
    expect(words).toBeLessThan(161)
  })

  it('the counter-example really does demonstrate the heading anti-pattern', () => {
    const after = reference.split('\n## Counter-example')[1]
    expect(after, 'counter-example section not found').toBeDefined()
    const bad = /```markdown\n([\s\S]*?)\n```/.exec(after)
    expect(bad, 'no markdown fence in the counter-example').not.toBeNull()
    const doc = markdownToAdfDocument(bad?.[1] ?? '')

    // If someone "tidies" this into bold labels, it stops illustrating anything.
    expect(nodesOfType(doc, 'heading').length).toBeGreaterThan(0)
  })
})

describe('the scripts stay dependency-free', () => {
  const scripts = join(import.meta.dirname, '../catalog/jira-ticket/scripts')

  it.each(['adf.mjs', 'adf-blocks.mjs', 'adf-inline.mjs', 'jira-api.mjs', 'jira-issue.mjs'])(
    '%s imports nothing but node: builtins and its siblings',
    (file) => {
      const source = readFileSync(join(scripts, file), 'utf8')
      const specifiers = [
        ...source.matchAll(/^\s*(?:import\b[^'\n]*from\s+|import\s+)'([^']+)'/gm),
      ].map((match) => match[1])

      // skills.sh copies this directory verbatim into repos that may not be Node projects at
      // all, so a bare specifier here is a dependency the target cannot be assumed to resolve.
      // The version this replaced fell back to `npm install`-ing marklassian into a user-level
      // cache on first use — network access and unpinned code, triggered by creating a ticket.
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('node:') || specifier.startsWith('./'),
          `${file} imports '${specifier}'`,
        ).toBe(true)
      }
    },
  )

  it('spawns no package manager', () => {
    for (const file of ['adf.mjs', 'adf-blocks.mjs', 'adf-inline.mjs']) {
      const source = readFileSync(join(scripts, file), 'utf8')
      expect(source, `${file} shells out`).not.toMatch(/execFileSync|execSync|spawn/)
    }
  })
})

describe('configValue', () => {
  it('reads a key from the nearest .agents/skills.config, walking up', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-cfg-'))
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(
      join(root, '.agents', 'skills.config'),
      '# comment\njira_site=example.atlassian.net\njira_epic_key=ABC-1\n',
    )
    const nested = join(root, 'apps', 'web')
    mkdirSync(nested, { recursive: true })

    expect(configValue('jira_site', nested)).toBe('example.atlassian.net')
    expect(configValue('jira_epic_key', root)).toBe('ABC-1')
  })

  it('returns an empty string for an absent key or missing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-cfg-'))
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills.config'), 'jira_site=example.atlassian.net\n')

    expect(configValue('jira_board_id', root)).toBe('')
    expect(configValue('jira_site', mkdtempSync(join(tmpdir(), 'skills-empty-')))).toBe('')
  })
})

describe('parseArgs', () => {
  it('reads valued flags and switches', () => {
    const flags = parseArgs(['--type', 'Bug', '--summary', 'a title', '--dry-run'])

    expect(flags.type).toBe('Bug')
    expect(flags.summary).toBe('a title')
    expect(flags['dry-run']).toBe(true)
  })

  it('collects repeated --field', () => {
    const flags = parseArgs(['--field', 'a=1', '--field', 'b=2'])
    expect(flags.field).toEqual(['a=1', 'b=2'])
  })

  it('rejects --flag=value, which would register --dry-run=true as an unknown switch', () => {
    // The failure this prevents: --dry-run=true left dry-run unset and created a real ticket.
    expect(() => parseArgs(['--dry-run=true'])).toThrow('takes no value')
    expect(() => parseArgs(['--summary=x'])).toThrow('`--summary <value>`')
  })

  it('rejects an unknown flag rather than storing it as an ignored switch', () => {
    expect(() => parseArgs(['--dryrun'])).toThrow('unknown flag --dryrun')
    expect(() => parseArgs(['--parnet', 'X-1'])).toThrow('unknown flag --parnet')
  })

  it('rejects a valued flag whose value is missing or is the next flag', () => {
    expect(() => parseArgs(['--summary', '--dry-run'])).toThrow('--summary needs a value')
    expect(() => parseArgs(['--summary'])).toThrow('--summary needs a value')
  })

  it('rejects a stray positional, so `--sprint 42` cannot silently drop the id', () => {
    // jira-sprint.sh takes `--sprint <id>`; here --sprint is a switch. Silently
    // dropping the id would send the ticket to the active sprint instead.
    expect(() => parseArgs(['--sprint', '42'])).toThrow("unexpected argument '42'")
  })
})

describe('parseExtraFields', () => {
  it('sends JSON-looking values as JSON and everything else as a string', () => {
    expect(parseExtraFields(['customfield_11718=2'])).toEqual({ customfield_11718: 2 })
    expect(parseExtraFields(['customfield_12042=Client'])).toEqual({ customfield_12042: 'Client' })
    expect(parseExtraFields(['f={"value":"Client"}'])).toEqual({ f: { value: 'Client' } })
    expect(parseExtraFields(['f=true'])).toEqual({ f: true })
  })

  it('leaves a version-like value as the string it was written as', () => {
    // JSON.parse('1.10') is 1.1, which is not what anyone typed.
    expect(parseExtraFields(['f=1.10'])).toEqual({ f: '1.10' })
  })

  it('refuses to set a field the script derives itself', () => {
    // --field description=… would replace the converted ADF with a raw string,
    // reintroducing the literal-markdown bug this script exists to fix.
    expect(() => parseExtraFields(['description=**raw**'])).toThrow("cannot set 'description'")
    for (const id of ['summary', 'project', 'issuetype', 'parent', 'labels', 'assignee']) {
      expect(() => parseExtraFields([`${id}=x`])).toThrow(`cannot set '${id}'`)
    }
  })

  it('requires the id=value form', () => {
    expect(() => parseExtraFields(['nonsense'])).toThrow('<id>=<value>')
    expect(() => parseExtraFields(['=x'])).toThrow('<id>=<value>')
  })
})

describe('resolveIssueType', () => {
  it('normalises case to the name Jira expects', () => {
    expect(resolveIssueType('bug')).toBe('Bug')
    expect(resolveIssueType('STORY')).toBe('Story')
    expect(resolveIssueType('Task')).toBe('Task')
  })

  it('rejects a type outside the documented three, pointing at the escape hatch', () => {
    expect(() => resolveIssueType('Epic')).toThrow('Story, Task, Bug')
    expect(() => resolveIssueType('Epic')).toThrow('--field issuetype=')
    expect(() => resolveIssueType()).toThrow('--type is required')
  })
})

describe('resolveProject', () => {
  it('prefers an explicit --project', () => {
    expect(resolveProject({ project: 'ABC' })).toBe('ABC')
  })

  it('rejects the placeholder some repos park in ticket_prefix', () => {
    // e.g. ticket_prefix={no jira board/no jira tickets use names instead}
    const root = mkdtempSync(join(tmpdir(), 'skills-noj-'))
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills.config'), 'ticket_prefix={no jira board}\n')

    const cwd = process.cwd()
    try {
      process.chdir(root)
      expect(() => resolveProject({})).toThrow('no Jira project key configured')
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('wantsSprint', () => {
  const originalEnv = process.env.JIRA_CREATE_INTO

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.JIRA_CREATE_INTO
    else process.env.JIRA_CREATE_INTO = originalEnv
  })

  it('defaults to the backlog, which is what the documented process expects', () => {
    delete process.env.JIRA_CREATE_INTO
    expect(wantsSprint({ field: [], _: [] })).toBe(false)
  })

  it('honours the config value', () => {
    process.env.JIRA_CREATE_INTO = 'sprint'
    expect(wantsSprint({ field: [], _: [] })).toBe(true)
    process.env.JIRA_CREATE_INTO = 'backlog'
    expect(wantsSprint({ field: [], _: [] })).toBe(false)
  })

  it('lets explicit flags override the config either way', () => {
    process.env.JIRA_CREATE_INTO = 'backlog'
    expect(wantsSprint({ sprint: true, field: [], _: [] })).toBe(true)
    process.env.JIRA_CREATE_INTO = 'sprint'
    expect(wantsSprint({ 'no-sprint': true, field: [], _: [] })).toBe(false)
  })

  it('rejects contradictory flags and an unrecognised config value', () => {
    delete process.env.JIRA_CREATE_INTO
    expect(() => wantsSprint({ sprint: true, 'no-sprint': true, field: [], _: [] })).toThrow(
      'mutually exclusive',
    )
    process.env.JIRA_CREATE_INTO = 'sprints'
    expect(() => wantsSprint({ field: [], _: [] })).toThrow("'backlog' or 'sprint'")
  })
})

describe('jiraSite', () => {
  const originalEnv = process.env.JIRA_SITE

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.JIRA_SITE
    else process.env.JIRA_SITE = originalEnv
  })

  it('accepts a bare hostname', () => {
    process.env.JIRA_SITE = 'example.atlassian.net'
    expect(jiraSite()).toBe('example.atlassian.net')
  })

  it.each([
    'evil.example/',
    'https://example.atlassian.net',
    'example.atlassian.net/x',
    'host',
    'a b.com',
  ])('rejects %s, which would redirect the credentialed request', (value) => {
    // jiraSite() is concatenated into a URL carrying the API token, so a value
    // containing '/' or '@' can point those credentials at another host.
    process.env.JIRA_SITE = value
    expect(() => jiraSite()).toThrow('bare hostname')
  })
})
