import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKILLS_SH = join(HERE, 'skills.sh')

/** A single skill's catalog metadata + content files. */
export interface FixtureSkill {
  name: string
  version: string
  description: string
  argumentHint?: string
  requires?: string[]
  /** Relative-path → contents. `SKILL.md` is defaulted when omitted. */
  files?: Record<string, string>
  /** Shared asset bundles seeded into the target root (see `writeAssetBundle`). */
  assets?: string[]
  /** Post-install recommendations, each `action|why[|when]`. */
  nextSteps?: string[]
}

/** Result of shelling out to skills.sh. */
export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** Create a throwaway dir under the OS temp dir. */
export const makeTempDir = (prefix = 'skills-'): string => mkdtempSync(join(tmpdir(), prefix))

/** Serialize a FixtureSkill's skill.meta body. */
const metaBody = (skill: FixtureSkill): string => {
  const lines = [
    `name=${skill.name}`,
    `version=${skill.version}`,
    `description=${skill.description}`,
  ]
  if (skill.argumentHint !== undefined) lines.push(`argument_hint=${skill.argumentHint}`)
  lines.push(`requires=${(skill.requires ?? []).join(' ')}`)
  if (skill.assets?.length) lines.push(`assets=${skill.assets.join(' ')}`)
  for (const step of skill.nextSteps ?? []) lines.push(`next_step=${step}`)
  return lines.join('\n') + '\n'
}

/**
 * Build a catalog dir populated with the given skills; returns its path.
 *
 * Mirrors the published snapshot layout — `<root>/catalog` beside `<root>/assets`
 * — so `assets=` bundles resolve the same way they do for a real install.
 */
export const makeCatalog = (skills: FixtureSkill[]): string => {
  const catalog = join(makeTempDir('skills-snapshot-'), 'catalog')
  mkdirSync(catalog, { recursive: true })
  for (const skill of skills) writeSkill(catalog, skill)
  return catalog
}

/** Write a shared asset bundle (target-root-relative paths) beside a catalog. */
export const writeAssetBundle = (
  catalog: string,
  bundle: string,
  files: Record<string, string>,
): void => {
  for (const [rel, contents] of Object.entries(files)) {
    const dest = join(catalog, '..', 'assets', bundle, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, contents)
  }
}

/** Write (or overwrite) one skill into an existing catalog dir. */
export const writeSkill = (catalog: string, skill: FixtureSkill): void => {
  const dir = join(catalog, skill.name)
  mkdirSync(dir, { recursive: true })
  const files = skill.files ?? { 'SKILL.md': `# ${skill.name}\n\nProcedure for ${skill.name}.\n` }
  if (!files['SKILL.md']) files['SKILL.md'] = `# ${skill.name}\n`
  for (const [rel, contents] of Object.entries(files)) {
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, contents)
  }
  writeFileSync(join(dir, 'skill.meta'), metaBody(skill))
}

/** Snapshot a skill's content (minus skill.meta) into a base dir for merge tests. */
export const snapshotBase = (catalog: string, name: string): string => {
  const baseRoot = makeTempDir('skills-base-')
  const dest = join(baseRoot, name)
  cpSync(join(catalog, name), dest, {
    recursive: true,
    filter: (src) => !src.endsWith('/skill.meta') && !src.endsWith('skill.meta'),
  })
  return baseRoot
}

/** An empty throwaway target project root. */
export const makeTarget = (): string => makeTempDir('skills-target-')

/** Run `sh skills.sh <args…>` against a catalog + target; capture output + code. */
export const runSkills = (
  args: string[],
  opts: { catalog: string; target: string; env?: Record<string, string> },
): RunResult => {
  try {
    const stdout = execFileSync(
      'sh',
      [SKILLS_SH, ...args, '--catalog', opts.catalog, '--target', opts.target],
      { encoding: 'utf8', env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    }
  }
}

/** Read a file as utf8, or return undefined if it does not exist. */
export const readIfExists = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Parse skills.sh action lines (`NAME<TAB>ACTION<TAB>VERSION`), ignoring indents/comments. */
export const parseActions = (stdout: string): { name: string; action: string; version: string }[] =>
  stdout
    .split('\n')
    .filter((l) => l.length > 0 && !l.startsWith(' ') && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 3)
    .map(([name, action, version]) => ({ name, action, version }))

/** Parse `next-steps` TSV lines (`NAME<TAB>ACTION<TAB>WHY<TAB>WHEN`). */
export const parseNextSteps = (
  stdout: string,
): { name: string; action: string; why: string; when: string }[] =>
  stdout
    .split('\n')
    .map((l) => l.replace(/^# next: /, ''))
    .filter((l) => l.length > 0 && !l.startsWith(' ') && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length === 4)
    .map(([name, action, why, when]) => ({ name, action, why, when }))

/** Parse list/status TSV lines into structured rows. */
export const parseList = (
  stdout: string,
): {
  name: string
  state: string
  catalogVersion: string
  installedVersion: string
  description: string
}[] =>
  stdout
    .split('\n')
    .filter((l) => l.length > 0 && !l.startsWith(' ') && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 5)
    .map(([name, state, catalogVersion, installedVersion, description]) => ({
      name,
      state,
      catalogVersion,
      installedVersion,
      description,
    }))
