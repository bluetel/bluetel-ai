'use client'

import { api } from '@sisyphus-admin/trpc'

import { useIntegrationsApiClient } from './api-integrations-client'
import { toOwnerOptions, toProfileOptions } from './integration-options'
import { IntegrationsPanel } from './integrations-panel'

/**
 * `/admin/integrations`, connected (T199).
 *
 * The page is a server component and the panel needs three things a server component cannot hold —
 * a tRPC client, and two live pickers — so this is the boundary between them. It carries no state
 * and no logic of its own: the client is `api-integrations-client.ts`, the two option lists are
 * `integration-options.ts`, and everything the admin actually interacts with is the panel.
 *
 * ## Why the pickers are read here rather than in the panel
 *
 * Keeping them out of `IntegrationsPanel` is what preserves its port: the panel takes its data as
 * arguments and can be rendered without a provider, which is the only reason its parts are testable
 * in an app with no testing library. Two `useQuery` calls inside it would have ended that.
 *
 * ## Both lists are read once, for the whole screen
 *
 * The editor is open for at most one integration at a time, so a per-card query would be the same
 * two reads issued repeatedly. `limit: 50` matches every other admin listing.
 */
export const IntegrationsScreen = () => {
  const client = useIntegrationsApiClient()

  // Archived and disabled profiles are filtered in `toProfileOptions`, not here: a mapping may only
  // name a profile a run could start from (FR-130), and that rule belongs somewhere a test can
  // reach it.
  const profiles = api.admin.profiles.list.useQuery({ includeArchived: false, limit: 50 })
  const users = api.admin.users.list.useQuery({ activeOnly: true, limit: 50 })

  return (
    <IntegrationsPanel
      client={client}
      profiles={toProfileOptions(profiles.data?.items ?? [])}
      owners={toOwnerOptions(users.data?.items ?? [])}
    />
  )
}
