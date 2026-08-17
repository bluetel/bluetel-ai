// Typed boundary for the jira-ticket catalog scripts.
//
// Those scripts are plain `.mjs` with no build step and ship no declarations, because
// skills.sh copies them verbatim into target repos that may not be Node projects at
// all. Rather than scatter `any` through the tests, the untyped import is confined to
// this one module and re-exported with explicit signatures.

import * as adf from '../catalog/jira-ticket/scripts/adf.mjs'
import * as jiraApi from '../catalog/jira-ticket/scripts/jira-api.mjs'

export interface AdfMark {
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

export interface AdfDocument {
  version: number
  type: string
  content: AdfNode[]
}

/** Convert a markdown description into an ADF document for `fields.description`. */
export const markdownToAdfDocument = adf.markdownToAdfDocument as (
  markdown: string,
) => Promise<AdfDocument>

/** Strip a fence wrapping the whole document, which would otherwise render as code. */
export const unwrapCodeFence = adf.unwrapCodeFence as (markdown: string) => string

/** True when the text still contains markdown Jira would show verbatim. */
export const looksLikeMarkdown = adf.looksLikeMarkdown as (text: string) => boolean

/** Read a key from the nearest `.agents/skills.config`, walking up from `startDir`. */
export const configValue = jiraApi.configValue as (key: string, startDir?: string) => string
