// cspell:ignore dryrun parnet — deliberate typos: these tests assert that a
// misspelt flag is rejected rather than silently ignored.
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
  it('renders a bold section label as a strong text run, not literal asterisks', async () => {
    const doc = await markdownToAdfDocument('**Problem:**\n\nThe play bar does not reset.')

    const [label] = doc.content
    expect(label.type).toBe('paragraph')
    expect(label.content?.[0].text).toBe('Problem:')
    expect(label.content?.[0].marks).toEqual([{ type: 'strong' }])
    // The regression this whole script exists to prevent.
    expect(JSON.stringify(doc)).not.toContain('**')
  })

  it('converts ordered lists into list nodes rather than numbered text', async () => {
    const doc = await markdownToAdfDocument('1. Open an article\n2. Start a second one\n')

    const ordered = nodesOfType(doc, 'orderedList')
    expect(ordered).toHaveLength(1)
    expect(nodesOfType(doc, 'listItem')).toHaveLength(2)
    expect(plainText(ordered[0])).toContain('Open an article')
    expect(JSON.stringify(doc)).not.toContain('1.')
  })

  it('converts bullets into a bulletList, as CoS sections need', async () => {
    const doc = await markdownToAdfDocument('**CoS**\n\n- Add the field\n- Default it to false\n')

    expect(nodesOfType(doc, 'bulletList')).toHaveLength(1)
    expect(nodesOfType(doc, 'listItem')).toHaveLength(2)
  })

  it('marks inline code with a code mark rather than backticks', async () => {
    const doc = await markdownToAdfDocument('It resets to `0:00` on load.')

    const coded = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'code'))
    expect(coded?.text).toBe('0:00')
    expect(JSON.stringify(doc)).not.toContain('`')
  })

  it('turns a bare URL into a link mark', async () => {
    const doc = await markdownToAdfDocument('Go to https://example.com and play audio')

    const linked = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'link'))
    expect(linked?.marks?.[0].attrs?.href).toBe('https://example.com')
  })

  it('keeps italic placeholders italic, so implementer sections stay marked as unfilled', async () => {
    const doc = await markdownToAdfDocument('_A summary of how the issue raised was addressed_')

    const italic = nodesOfType(doc, 'text').find((n) => n.marks?.some((m) => m.type === 'em'))
    expect(italic?.text).toBe('A summary of how the issue raised was addressed')
  })

  it('produces a doc node the REST API will accept', async () => {
    const doc = await markdownToAdfDocument('**CoS**\n\n- Add the field\n')

    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
    expect(Array.isArray(doc.content)).toBe(true)
  })

  it('rejects an empty description instead of creating a blank ticket', async () => {
    await expect(markdownToAdfDocument('   \n  ')).rejects.toThrow('empty')
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

  it('keeps the fences balanced through conversion for such a description', async () => {
    const body = ['```', 'ERROR: boom', '```', '', '**Problem:**', '', 'It broke.'].join('\n')
    const doc = await markdownToAdfDocument(body)

    // One codeBlock for the trace, and the Problem label survives as a bold run
    // rather than being swallowed into it as literal asterisks.
    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(1)
    expect(plainText(doc)).toContain('Problem:')
    expect(JSON.stringify(doc)).not.toContain('**')
  })

  it('survives the fenced round trip into ADF', async () => {
    const doc = await markdownToAdfDocument('```markdown\n**Problem:**\n\nBroken.\n```')

    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(0)
    expect(nodesOfType(doc, 'text')[0].marks).toEqual([{ type: 'strong' }])
  })

  it('still converts a real code block inside a description', async () => {
    const doc = await markdownToAdfDocument('**Problem:**\n\n```bash\nnpm run build\n```')

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
    async (type) => {
      for (const index of [0, 1]) {
        const doc = await markdownToAdfDocument(fence(type, index))

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

  it('the Bug example stays near the measured length for real tickets', () => {
    const words = fence('Bug', 1).split(/\s+/).filter(Boolean).length

    // Sampled bugs run ~124 words median, ~161 at p75. Keep the example in that band
    // so it calibrates length rather than licensing an essay.
    expect(words).toBeGreaterThan(60)
    expect(words).toBeLessThan(161)
  })

  it('the counter-example really does demonstrate the heading anti-pattern', async () => {
    const after = reference.split('\n## Counter-example')[1]
    expect(after, 'counter-example section not found').toBeDefined()
    const bad = /```markdown\n([\s\S]*?)\n```/.exec(after)
    expect(bad, 'no markdown fence in the counter-example').not.toBeNull()
    const doc = await markdownToAdfDocument(bad?.[1] ?? '')

    // If someone "tidies" this into bold labels, it stops illustrating anything.
    expect(nodesOfType(doc, 'heading').length).toBeGreaterThan(0)
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
