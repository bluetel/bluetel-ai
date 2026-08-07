'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { NotificationPreferenceRow } from './notification-preference-row'
import { describeDefaults, toPreferenceReadouts } from './preference-readouts'

/**
 * The per-event notification preferences (T158, FR-138, FR-201).
 *
 * ## One control per event, and the list comes from the server
 *
 * `workflow.notificationPreferences` returns the **whole event vocabulary**, not the rows that
 * happen to exist, so the list this renders is the platform's set rather than the caller's history.
 * That is what makes a screen with no stored preferences at all still a complete screen: eight
 * events, every one of them manageable, each marked as carrying the default rather than a decision
 * (see `preference-readouts.ts` for why that marking is the load-bearing part).
 *
 * ## Why the mutation writes a row even when the value already matches
 *
 * `setNotificationPreference` stores a row for `true` as well as for `false`, because a row records
 * a *decision*. Pressing `Notify me about this` on an event that was already notifying by default
 * is therefore not a no-op: it converts a default into a choice, and the row's marker changes to
 * say so. The panel does not filter that press out.
 *
 * ## States (FR-201)
 *
 * **Loading** is a card that says it is reading rather than an empty list — an empty list here
 * would read as "you have no notification events", which is never true. **Error** renders through
 * `FieldError`, with a code and a next action. **Empty** is impossible by construction and is still
 * handled: if the vocabulary ever came back empty the screen says the platform published no events,
 * rather than presenting a settled, silent configuration.
 *
 * In-flight state is tracked per event, so pressing one row does not blank the other seven, and a
 * refusal is attached to the row that was refused.
 */
export const NotificationPreferencesPanel = () => {
  const [pending, setPending] = useState<{ event: string; startedAt: number } | undefined>(
    undefined,
  )
  const [refusal, setRefusal] = useState<{ event: string; error: FieldErrorContent } | undefined>(
    undefined,
  )

  const utils = api.useUtils()
  const preferences = api.workflow.notificationPreferences.useQuery()
  const setPreference = api.workflow.setNotificationPreference.useMutation()

  const items = preferences.data ?? []
  const summary = describeDefaults(items)

  return (
    <Card aria-label="Notification preferences">
      <CardHeader>
        <span>what you are told about</span>
        <StateChip>{preferences.isPending ? 'reading' : summary.readout}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          Every event the platform can notify you about, for the runs you own and the runs you
          watch. Delivery is by Slack direct message and nothing else.
        </p>

        {preferences.error === null ? null : (
          <FieldError
            {...describeTrpcError(preferences.error, {
              NOT_FOUND: {
                code: 'E_PREFERENCES_UNAVAILABLE',
                action: 'Reload the page — your preferences could not be read.',
              },
            })}
          />
        )}

        {preferences.isPending ? <LoadingState>reading your preferences</LoadingState> : null}

        {!preferences.isPending && preferences.error === null && items.length === 0 ? (
          <EmptyState>
            the platform published no notification events, so there is nothing to set here
          </EmptyState>
        ) : null}

        {preferences.isPending || items.length === 0 ? null : (
          <p className="type-body text-graphite measure-prose">{summary.detail}</p>
        )}

        <ol className="gap-close flex flex-col">
          {items.map((preference) => (
            <NotificationPreferenceRow
              key={preference.event}
              readouts={toPreferenceReadouts(preference)}
              startedAt={pending?.event === preference.event ? pending.startedAt : undefined}
              error={refusal?.event === preference.event ? refusal.error : undefined}
              onChange={(enabled) => {
                setPending({ event: preference.event, startedAt: Date.now() })
                setRefusal(undefined)
                setPreference.mutate(
                  { event: preference.event, enabled },
                  {
                    onSuccess: () => {
                      setPending(undefined)
                      void utils.workflow.notificationPreferences.invalidate()
                    },
                    onError: (failure) => {
                      setPending(undefined)
                      setRefusal({
                        event: preference.event,
                        error: describeTrpcError(failure, {
                          NOT_FOUND: {
                            code: 'E_PREFERENCES_UNAVAILABLE',
                            action: 'Reload the page — your preferences could not be written.',
                          },
                        }),
                      })
                    },
                  },
                )
              }}
            />
          ))}
        </ol>
      </CardBody>
    </Card>
  )
}
