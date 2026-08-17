import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  configValue,
  looksLikeMarkdown,
  markdownToAdfDocument,
  unwrapCodeFence,
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
    join(import.meta.dirname, '../catalog/jira-ticket/reference/ticket-types.md'),
    'utf8',
  )

  const STANDARD_CRITERIA = [
    'Unit tests with at least 80% coverage',
    'SonarQube Quality Gates are passing',
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

  it.each(['Story', 'Task'])(
    'the %s example carries the three standard acceptance criteria',
    (type) => {
      const example = fence(type, 1)
      for (const criterion of STANDARD_CRITERIA) expect(example).toContain(criterion)
    },
  )

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
