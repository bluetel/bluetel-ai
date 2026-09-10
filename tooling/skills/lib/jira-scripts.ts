// Typed boundary for the jira-ticket catalog scripts.
//
// Those scripts are plain `.mjs` with no build step and ship no declarations, because
// skills.sh copies them verbatim into target repos that may not be Node projects at
// all. Rather than scatter `any` through the tests, the untyped import is confined to
// this one module and re-exported with explicit signatures.

import * as adf from '../catalog/jira-ticket/scripts/adf.mjs'
import * as jiraApi from '../catalog/jira-ticket/scripts/jira-api.mjs'
import * as jiraIssue from '../catalog/jira-ticket/scripts/jira-issue.mjs'

interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface AdfNode {
  type: string
  text?: string
  marks?: AdfMark[]
  content?: AdfNode[]
  attrs?: Record<string, unknown>
}

interface AdfDocument {
  version: number
  type: string
  content: AdfNode[]
}

/** Convert a markdown description into an ADF document for `fields.description`. */
export const markdownToAdfDocument = adf.markdownToAdfDocument as (markdown: string) => AdfDocument

/** Strip a fence wrapping the whole document, which would otherwise render as code. */
export const unwrapCodeFence = adf.unwrapCodeFence as (markdown: string) => string

/** True when the text still contains markdown Jira would show verbatim. */
export const looksLikeMarkdown = adf.looksLikeMarkdown as (text: string) => boolean

/** Read a key from the nearest `.agents/skills.config`, walking up from `startDir`. */
export const configValue = jiraApi.configValue as (key: string, startDir?: string) => string

/** Reject anything that is not a bare hostname, since it is concatenated into a credentialed URL. */
// No assertion needed: this one takes no arguments, so the inferred signature is already exact.
export const jiraSite: () => string = jiraApi.jiraSite

export interface ParsedFlags {
  _: string[]
  field: string[]
  [flag: string]: string | string[] | boolean | undefined
}

/** Parse CLI argv, rejecting unknown flags, `--flag=value`, and stray positionals. */
export const parseArgs = jiraIssue.parseArgs as (argv: string[]) => ParsedFlags

/** Turn repeated `--field id=value` entries into a fields object. */
export const parseExtraFields = jiraIssue.parseExtraFields as (
  entries: string[],
) => Record<string, unknown>

/** Resolve the project key from flags, then config, rejecting the "no Jira" placeholder. */
export const resolveProject = jiraIssue.resolveProject as (flags: Partial<ParsedFlags>) => string

/** Normalise `--type` to the canonical name Jira expects. */
export const resolveIssueType = jiraIssue.resolveIssueType as (given?: string) => string

/** Whether a newly created issue should be moved into the board's active sprint. */
export const wantsSprint = jiraIssue.wantsSprint as (flags: Partial<ParsedFlags>) => boolean
