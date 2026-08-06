'use client'

import { NotFoundCard } from '@sisyphus-admin/components/admin/not-found-card'
import { describeTrpcError, isNotFoundError } from '@sisyphus-admin/components/admin/trpc-error'
import { RoleChangeHistory } from '@sisyphus-admin/components/admin/users/role-change-history'
import { Button, Card, CardBody, CardHeader, Field } from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { AuditScope } from './audit-scope'
import {
  EMPTY_AUDIT_SCOPE,
  hasInvalidSubject,
  hasSubject,
  toAuditSearchParams,
  toRoleChangesInput,
} from './audit-scope'
import { ConfigurationFilters } from './configuration-filters'
import type { ConfigurationScope } from './configuration-scope'
import {
  hasInvalidConfigurationScope,
  toConfigurationAuditInput,
  toConfigurationSearchParams,
} from './configuration-scope'
import { toConfigurationTrailReadouts } from './configuration-trail'
import { ConfigurationTrailCard } from './configuration-trail-card'
import { toGrantTrailReadouts } from './grant-trail'
import { GrantTrailCard } from './grant-trail-card'

/**
 * The configuration audit view (T136, FR-177, FR-183, FR-184, SC-050, SC-053).
 *
 * ## What an audit view has to be, structurally
 *
 * Two things, and both are absences. There is **no control on this screen that writes anything** —
 * no edit, no delete, no "correct this entry". The trails it renders are append-only in the
 * database, and an affordance offered for something that cannot be done is a lie about the record.
 * And there is no local state holding entries: everything shown is read on demand, so nothing here
 * can present a stale history as the current one.
 *
 * ## The three trails it shows
 *
 * - **Role and activation changes** (FR-177), from `admin.users.roleChanges`. The whole platform's,
 *   newest first, or one account's when a subject is named.
 * - **Profile access** (FR-183, FR-184, SC-053), from `admin.grants.listForUser` with
 *   `includeRevoked`, so grants and revocations appear together with the admin who made each.
 * - **Configuration changes** (FR-178), from `admin.audit.list`. Bundles, workspaces, profiles,
 *   integrations, grants, roles and owner reassignments — everything `recordConfigurationChange`
 *   has been writing since the first bundle was registered. This screen was blind to all of it
 *   until the read procedure existed, which made an audit view that could not answer "who
 *   installed this client's credentials".
 *
 * ## Two filters, because there are two questions
 *
 * The **subject** narrows the two user-shaped trails: what happened to this account. The
 * configuration filters narrow the third by the kind of thing changed, by one thing's identifier,
 * and by the admin who changed it — see `./configuration-scope.ts` for why those are a separate
 * scope rather than three more fields on the first. Both live in the query string, so a narrowed
 * audit is a thing an admin can send to a colleague and come back to.
 *
 * ## The subject is narrowed here and refused here
 *
 * A subject that is not an identifier blocks the read and marks the field rather than being sent —
 * see `./audit-scope.ts`. And a subject the server answers `NOT_FOUND` for is rendered as **not
 * found**, never as "you do not have permission": a user id in a URL is the caller's guess, and the
 * refusal is deliberately the same one a nonexistent id gets (FR-190). `NotFoundCard` is the one
 * component that renders it, and it has no variant that mentions permission.
 */

/** How many entries one page of the role-change trail holds. */
export const AUDIT_PAGE_SIZE = 25

/** How many access-history rows are read at once. A user holds few profiles; one page is enough. */
const GRANT_PAGE_SIZE = 50

interface AuditPanelProps {
  /** Parsed from the page's search params, so the first render is already the narrowed trail. */
  readonly initialScope: AuditScope
  /** The configuration trail's own narrowing, parsed from the same search params. */
  readonly initialConfigurationScope: ConfigurationScope
}

export const AuditPanel = ({ initialScope, initialConfigurationScope }: AuditPanelProps) => {
  const router = useRouter()
  const [applied, setApplied] = useState<AuditScope>(initialScope)
  const [draft, setDraft] = useState<AuditScope>(initialScope)
  const [appliedConfiguration, setAppliedConfiguration] =
    useState<ConfigurationScope>(initialConfigurationScope)
  const [configurationDraft, setConfigurationDraft] =
    useState<ConfigurationScope>(initialConfigurationScope)

  const roleChanges = api.admin.users.roleChanges.useInfiniteQuery(
    toRoleChangesInput(applied, AUDIT_PAGE_SIZE),
    { getNextPageParam: (page) => page.nextCursor },
  )

  const grants = api.admin.grants.listForUser.useQuery(
    {
      userId: applied.subjectUserId.trim(),
      includeRevoked: true,
      limit: GRANT_PAGE_SIZE,
    },
    // Not merely hidden: with no subject the query is never issued, so the screen asks the server
    // nothing it has not been given an identifier for.
    { enabled: hasSubject(applied) },
  )

  // Unconditional, because the unfiltered configuration trail is the whole point of the screen —
  // there is no identifier to wait for, and "everything, newest first" is a useful first answer.
  const configuration = api.admin.audit.list.useInfiniteQuery(
    toConfigurationAuditInput(appliedConfiguration, AUDIT_PAGE_SIZE),
    { getNextPageParam: (page) => page.nextCursor },
  )

  /**
   * Put both filters back in the address bar together.
   *
   * One URL for one screen: applying either filter re-serialises the other, so the link an admin
   * copies carries everything they are looking at rather than whichever half they touched last.
   */
  const pushScopes = (subject: AuditScope, configurationScope: ConfigurationScope): void => {
    const query = [toAuditSearchParams(subject), toConfigurationSearchParams(configurationScope)]
      .filter((part) => part !== '')
      .join('&')

    router.replace(query === '' ? '/admin/audit' : `/admin/audit?${query}`, { scroll: false })
  }

  const apply = (next: AuditScope): void => {
    if (hasInvalidSubject(next)) return

    setDraft(next)
    setApplied(next)
    pushScopes(next, appliedConfiguration)
  }

  const applyConfiguration = (next: ConfigurationScope): void => {
    if (hasInvalidConfigurationScope(next)) return

    setConfigurationDraft(next)
    setAppliedConfiguration(next)
    pushScopes(applied, next)
  }

  const entries = (roleChanges.data?.pages ?? []).flatMap((page) => page.items)
  const configurationEntries = (configuration.data?.pages ?? []).flatMap((page) => page.items)
  const subjectMissing = hasSubject(applied) && isNotFoundError(grants.error)

  return (
    <div className="gap-section flex flex-col">
      <Card aria-label="Subject">
        <CardHeader>
          <span>subject</span>
        </CardHeader>

        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            Leave this empty to read every recorded change, newest first. Name a user to read what
            was changed about that account — their role and activation history, and every execution
            profile they were granted or had revoked.
          </p>

          <Field
            label="Subject user id"
            name="subjectUserId"
            value={draft.subjectUserId}
            autoComplete="off"
            error={
              hasInvalidSubject(draft)
                ? {
                    code: 'E_NOT_AN_IDENTIFIER',
                    action: 'Paste the identifier from the user record, or clear the field.',
                  }
                : undefined
            }
            onChange={(event) => {
              setDraft({ subjectUserId: event.target.value })
            }}
          />

          <div className="gap-close flex items-center">
            <Button
              variant="primary"
              disabled={hasInvalidSubject(draft)}
              onClick={() => {
                apply(draft)
              }}
            >
              Read history
            </Button>
            {hasSubject(applied) || draft.subjectUserId !== '' ? (
              <Button
                variant="quiet"
                onClick={() => {
                  apply(EMPTY_AUDIT_SCOPE)
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {subjectMissing ? (
        <NotFoundCard message="No such user." />
      ) : (
        <>
          <RoleChangeHistory entries={entries} loading={roleChanges.isPending} />

          {roleChanges.hasNextPage ? (
            <div className="gap-close flex items-center">
              {roleChanges.isFetchingNextPage ? (
                <Button variant="secondary" pending readout="Loading" />
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    void roleChanges.fetchNextPage()
                  }}
                >
                  Load more
                </Button>
              )}
              <span className="type-data-mono text-graphite">
                paged by cursor from the last entry shown
              </span>
            </div>
          ) : null}

          {hasSubject(applied) ? (
            <GrantTrailCard
              rows={(grants.data?.items ?? []).map((grant) => toGrantTrailReadouts(grant))}
              loading={grants.isPending}
              error={grants.error === null ? undefined : describeTrpcError(grants.error)}
            />
          ) : null}
        </>
      )}

      {/*
        Outside the `subjectMissing` branch, deliberately. A subject that does not exist says
        nothing about the configuration trail, and hiding the whole screen behind one bad id would
        make a mistyped user id look like an audit with nothing in it.
      */}
      <ConfigurationFilters
        draft={configurationDraft}
        onChange={setConfigurationDraft}
        onApply={applyConfiguration}
      />

      <ConfigurationTrailCard
        rows={configurationEntries.map((entry) => toConfigurationTrailReadouts(entry))}
        loading={configuration.isPending}
        error={configuration.error === null ? undefined : describeTrpcError(configuration.error)}
      />

      {configuration.hasNextPage ? (
        <div className="gap-close flex items-center">
          {configuration.isFetchingNextPage ? (
            <Button variant="secondary" pending readout="Loading" />
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                void configuration.fetchNextPage()
              }}
            >
              Load more
            </Button>
          )}
          <span className="type-data-mono text-graphite">
            paged by cursor from the last entry shown
          </span>
        </div>
      ) : null}
    </div>
  )
}
