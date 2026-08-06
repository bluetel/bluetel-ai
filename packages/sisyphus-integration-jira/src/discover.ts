import type { CandidateItem, DiscoverContext } from '@bluetel-ai/sisyphus-api/contracts'

import { toCandidateItem } from './candidate'
import type { JiraRestClient } from './client'
import type { ResolvedJiraConfig } from './config'
import { buildDiscoveryJql } from './jql'
import { resolvePlatformIdentity } from './platform-identity'

/**
 * Discovery (T110, FR-101): every ticket the board currently says is in scope.
 *
 * ## Candidates only
 *
 * This starts nothing. The control plane claims (FR-102), applies ceilings (FR-107) and creates
 * workflows; keeping that out of here is what lets the claim and the workflow row be written in
 * one transaction, which is the only reason exactly-once holds across overlapping ticks.
 *
 * ## Paging, and why the loop is written the way it is
 *
 * Jira answers a search a page at a time and will not be talked out of it — asking for a thousand
 * results returns the deployment's cap with no indication that anything was left behind. So the
 * loop asks until the board says there is no more, advancing `startAt` by what it actually
 * received rather than by what it asked for, which is what keeps it correct when the deployment
 * quietly reduces the page size. Three separate signals end it, because different Jira versions
 * offer different ones: an explicit `isLast`, a `total` that has been reached, and a page shorter
 * than the one requested.
 *
 * The query is ordered (`./jql`). Offset paging over an unordered result set can return the same
 * ticket twice and skip another entirely — a matching ticket lost from the tick, which FR-108
 * forbids. The keys already seen are tracked as well, so a ticket that moves between pages while
 * the tick is running is carried once rather than twice.
 *
 * ## The cap, and why stopping early loses nothing
 *
 * A label applied across a whole board matches thousands of tickets. The ceiling on how many
 * *runs* that turns into is the control plane's (FR-107), but an unbounded paging loop is its own
 * problem — so discovery stops after `maxItemsPerTick` and records that it did. Nothing is lost:
 * the tickets it did not read are unclaimed, so they match again on the next tick (FR-108).
 *
 * ## A ticket it cannot use
 *
 * An issue Jira returns without a key cannot be claimed or commented on, so it is not a candidate
 * — but it is not silently dropped either. It goes to {@link DiscoverContext.recordSkip} to be
 * counted on the integration run (FR-105). An *empty* ticket is not this case: it is a candidate,
 * and FR-164 has the control plane skip it and say so on the ticket.
 *
 * ## `since` is deliberately not a filter
 *
 * {@link DiscoverContext.since} is offered by the contract and this connector does not narrow the
 * query with it. A ticket deferred by a ceiling is never modified, so `updated >= since` would
 * drop it from every subsequent tick and it would never be started — silently, and for good.
 * Not starting the same ticket twice is the claim's job (FR-102), not the query's.
 */

/** Recorded when the cap ends paging early. */
export const DISCOVERY_TRUNCATED = 'discovery_truncated'

export const discover = async (
  client: JiraRestClient,
  config: ResolvedJiraConfig,
  ctx: DiscoverContext,
): Promise<readonly CandidateItem[]> => {
  const platform = await resolvePlatformIdentity(config, client)
  const jql = buildDiscoveryJql(config)
  const items: CandidateItem[] = []
  const seen = new Set<string>()

  let startAt = 0
  let examined = 0

  while (examined < config.maxItemsPerTick) {
    const maxResults = Math.min(config.pageSize, config.maxItemsPerTick - examined)
    const page = await client.searchIssues({ jql, startAt, maxResults })

    if (page.issues.length === 0) {
      return items
    }

    for (const issue of page.issues) {
      const result = toCandidateItem(issue, { baseUrl: config.baseUrl, platform })

      if (!result.ok) {
        ctx.recordSkip?.(result.skip)
        continue
      }

      // A ticket can move between pages while the tick is running; carrying it twice would have
      // the control plane resolve and claim it twice for no gain.
      if (seen.has(result.item.externalId)) {
        continue
      }

      seen.add(result.item.externalId)
      items.push(result.item)
    }

    examined += page.issues.length
    startAt += page.issues.length

    const reachedTotal = page.total !== undefined && startAt >= page.total

    if (page.isLast === true || reachedTotal || page.issues.length < maxResults) {
      return items
    }
  }

  ctx.recordSkip?.({
    reason: DISCOVERY_TRUNCATED,
    detail:
      `Stopped after examining ${String(examined)} issues, the configured per-tick maximum. ` +
      'Unclaimed tickets still match and will be read on the next tick.',
  })

  return items
}
