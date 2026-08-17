import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadArtifact } from './load'

/** A throwaway repo root. The loader touches the filesystem, so its suite must too. */
const makeRepo = (files: Record<string, string> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-lint-load-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

describe('loadArtifact', () => {
  it('reads content, builds a markdown view, and parses suppressions', () => {
    const root = makeRepo({
      'a/SKILL.md':
        '# Title\n<!-- prompt-lint-disable-next-line refs/dangling-path — runtime -->\nSee `x/y.md`.\n',
    })
    const artifact = loadArtifact(root, 'a/SKILL.md', 'catalog-skill', 'a')

    expect(artifact.readError).toBeNull()
    expect(artifact.path).toBe('a/SKILL.md')
    expect(artifact.skillRoot).toBe('a')
    expect(artifact.view?.headings).toHaveLength(1)
    expect(artifact.suppressions).toHaveLength(1)
    expect(artifact.tokens).toBeNull()
  })

  it('parses skill.meta metadata and builds no markdown view for it', () => {
    const root = makeRepo({ 'a/skill.meta': 'name=a\nversion=1.0.0\ndescription=d\n' })
    const artifact = loadArtifact(root, 'a/skill.meta', 'catalog-meta', 'a')

    expect(artifact.meta?.format).toBe('skill-meta')
    expect(artifact.view).toBeNull()
  })

  it('parses pointer frontmatter and its body view together', () => {
    const root = makeRepo({
      'p/SKILL.md': "---\nname: p\ndescription: 'd'\n---\n\nSee `.agents/skills/p/SKILL.md`.\n",
    })
    const artifact = loadArtifact(root, 'p/SKILL.md', 'agent-pointer', 'p')

    expect(artifact.meta?.format).toBe('frontmatter')
    expect(artifact.view).not.toBeNull()
  })

  describe('read errors', () => {
    it('reports a missing file as unreadable and keeps it in the model', () => {
      const artifact = loadArtifact(makeRepo(), 'gone.md', 'guidance', null)
      // Never dropped: the rules that needed its content must be recorded as not
      // evaluated, and a dropped artifact is indistinguishable from a clean one.
      expect(artifact).toMatchObject({ path: 'gone.md', readError: 'unreadable', content: null })
    })

    it('reports a symlink rather than following it', () => {
      const root = makeRepo({ 'real.md': '# real\n' })
      symlinkSync(join(root, 'real.md'), join(root, 'link.md'))
      expect(loadArtifact(root, 'link.md', 'guidance', null).readError).toBe('symlink')
    })

    it('reports a directory as unreadable', () => {
      const root = makeRepo({ 'dir/x.md': 'x' })
      expect(loadArtifact(root, 'dir', 'guidance', null).readError).toBe('unreadable')
    })

    it('reports an empty file, and a whitespace-only one, as empty', () => {
      const root = makeRepo({ 'empty.md': '', 'blank.md': '\n\n   \n' })
      expect(loadArtifact(root, 'empty.md', 'guidance', null).readError).toBe('empty')
      expect(loadArtifact(root, 'blank.md', 'guidance', null).readError).toBe('empty')
    })

    it('reports invalid UTF-8 rather than decoding it to replacement characters', () => {
      const root = makeRepo()
      writeFileSync(join(root, 'bad.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
      expect(loadArtifact(root, 'bad.md', 'guidance', null).readError).toBe('not-utf8')
    })

    it('accepts a genuine U+FFFD in the source, which the round-trip test must survive', () => {
      const root = makeRepo({ 'ok.md': '# � replacement char is real content\n' })
      expect(loadArtifact(root, 'ok.md', 'guidance', null).readError).toBeNull()
    })

    it('accepts multi-byte UTF-8', () => {
      const root = makeRepo({ 'ok.md': '# accents (café) — and 日本語\n' })
      expect(loadArtifact(root, 'ok.md', 'guidance', null).readError).toBeNull()
    })

    it('leaves every parsed view null on a read error, with no suppressions', () => {
      const artifact = loadArtifact(makeRepo(), 'gone.md', 'catalog-meta', null)
      expect(artifact.view).toBeNull()
      expect(artifact.meta).toBeNull()
      expect(artifact.suppressions).toEqual([])
    })
  })
})
