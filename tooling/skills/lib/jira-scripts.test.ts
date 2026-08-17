import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
