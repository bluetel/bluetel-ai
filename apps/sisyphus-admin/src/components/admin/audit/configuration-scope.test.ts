import { describe, expect, it } from 'vitest'

import {
  ACTION_LABELS,
  ACTION_OPTIONS,
  ACTOR_PARAM,
  EMPTY_CONFIGURATION_SCOPE,
  ENTITY_ID_PARAM,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_OPTIONS,
  ENTITY_TYPE_PARAM,
  hasConfigurationNarrowing,
  hasInvalidActor,
  hasInvalidConfigurationScope,
  hasInvalidEntityId,
  isEntityType,
  parseConfigurationScope,
  toConfigurationAuditInput,
  toConfigurationSearchParams,
} from './configuration-scope'

/**
 * The configuration trail's narrowing, across the three representations it lives in: the URL, the
 * controls' draft values, and the procedure's input. Keeping the conversions pure and in one module
 * is what makes them testable — a filter that serialises to a key the parser does not read is a
 * filter that silently resets on reload, and no component test catches that.
 */

const ID = '0199a1f4-0000-7000-8000-0000000000ab'

const scoped = (over: Partial<typeof EMPTY_CONFIGURATION_SCOPE> = {}) => ({
  ...EMPTY_CONFIGURATION_SCOPE,
  ...over,
})

describe('the vocabularies', () => {
  it('labels every entity class and every action', () => {
    // Both are `Record`s over the procedure's own unions, so a class added to the API and not
    // labelled here is a compile error rather than a filter that quietly stops offering it.
    expect(ENTITY_TYPE_OPTIONS.length).toBe(Object.keys(ENTITY_TYPE_LABELS).length)
    expect(ACTION_OPTIONS.length).toBe(Object.keys(ACTION_LABELS).length)
    expect(ENTITY_TYPE_OPTIONS.every((option) => option.label !== '')).toBe(true)
    expect(ACTION_OPTIONS.every((option) => option.label !== '')).toBe(true)
  })

  it('covers the classes the trail is actually written with', () => {
    for (const entityType of [
      'setup_bundle',
      'workspace',
      'execution_profile',
      'integration',
      'profile_access_grant',
      'user',
      'workflow',
    ]) {
      expect(isEntityType(entityType)).toBe(true)
    }
  })

  it('rejects a class the procedure does not know', () => {
    expect(isEntityType('credential')).toBe(false)
    expect(isEntityType('')).toBe(false)
  })

  it('reads an entity class in the operator’s words, not the column’s', () => {
    expect(ENTITY_TYPE_LABELS.setup_bundle).toBe('setup bundle')
    expect(ACTION_LABELS.role_changed).toBe('role changed')
  })
})

describe('the draft’s state', () => {
  it('treats an empty narrowing as neither invalid nor narrowed', () => {
    expect(hasInvalidConfigurationScope(EMPTY_CONFIGURATION_SCOPE)).toBe(false)
    expect(hasConfigurationNarrowing(EMPTY_CONFIGURATION_SCOPE)).toBe(false)
  })

  it('marks an entity id that is not an identifier, and blocks the read', () => {
    expect(hasInvalidEntityId(scoped({ entityId: 'bundle-1' }))).toBe(true)
    expect(hasInvalidConfigurationScope(scoped({ entityId: 'bundle-1' }))).toBe(true)
  })

  it('marks an actor that is not an identifier, and blocks the read', () => {
    expect(hasInvalidActor(scoped({ actorUserId: 'ada' }))).toBe(true)
    expect(hasInvalidConfigurationScope(scoped({ actorUserId: 'ada' }))).toBe(true)
  })

  it('accepts well-formed ids, whitespace included, because a paste carries it', () => {
    expect(hasInvalidEntityId(scoped({ entityId: ` ${ID} ` }))).toBe(false)
    expect(hasInvalidActor(scoped({ actorUserId: ` ${ID} ` }))).toBe(false)
  })

  it('counts a chosen entity class as a narrowing on its own', () => {
    expect(hasConfigurationNarrowing(scoped({ entityType: 'workspace' }))).toBe(true)
  })
})

describe('reading the narrowing out of a URL', () => {
  it('reads all three keys', () => {
    expect(
      parseConfigurationScope({
        [ENTITY_TYPE_PARAM]: 'integration',
        [ENTITY_ID_PARAM]: ID,
        [ACTOR_PARAM]: ID,
      }),
    ).toStrictEqual({ entityType: 'integration', entityId: ID, actorUserId: ID })
  })

  it('drops an entity class a hand-edited URL invented', () => {
    expect(parseConfigurationScope({ [ENTITY_TYPE_PARAM]: 'credential' }).entityType).toBe('')
  })

  it('drops an id that is not an identifier, so a stale link reads rather than errors', () => {
    expect(parseConfigurationScope({ [ENTITY_ID_PARAM]: 'ada' })).toStrictEqual(
      EMPTY_CONFIGURATION_SCOPE,
    )
  })

  it('takes the first value when a key repeats', () => {
    expect(parseConfigurationScope({ [ENTITY_ID_PARAM]: [ID, 'other'] }).entityId).toBe(ID)
  })

  it('reads absent keys as nothing narrowed', () => {
    expect(parseConfigurationScope({})).toStrictEqual(EMPTY_CONFIGURATION_SCOPE)
  })
})

describe('writing the narrowing back into a URL', () => {
  it('round-trips everything it accepts', () => {
    const scope = { entityType: 'execution_profile', entityId: ID, actorUserId: ID }
    const query = toConfigurationSearchParams(scope)

    expect(parseConfigurationScope(Object.fromEntries(new URLSearchParams(query)))).toStrictEqual(
      scope,
    )
  })

  it('contributes no key for a value it would not send', () => {
    expect(toConfigurationSearchParams(EMPTY_CONFIGURATION_SCOPE)).toBe('')
    expect(toConfigurationSearchParams(scoped({ entityId: 'ada', entityType: 'nope' }))).toBe('')
  })

  it('trims a pasted id before it reaches the address bar', () => {
    expect(toConfigurationSearchParams(scoped({ actorUserId: ` ${ID} ` }))).toBe(
      `${ACTOR_PARAM}=${ID}`,
    )
  })
})

describe('the procedure input', () => {
  it('sends only the page size when nothing is narrowed', () => {
    // Not `entityType: undefined`: the unfiltered read and a narrowed one are two shapes rather
    // than one shape with holes in it.
    expect(toConfigurationAuditInput(EMPTY_CONFIGURATION_SCOPE, 25)).toStrictEqual({ limit: 25 })
  })

  it('carries each filter that is usable, trimmed', () => {
    expect(
      toConfigurationAuditInput(
        { entityType: 'setup_bundle', entityId: ` ${ID} `, actorUserId: ` ${ID} ` },
        25,
      ),
    ).toStrictEqual({ limit: 25, entityType: 'setup_bundle', entityId: ID, actorUserId: ID })
  })

  it('never sends a value the field is refusing', () => {
    expect(
      toConfigurationAuditInput(scoped({ entityId: 'ada', actorUserId: 'grace' }), 25),
    ).toStrictEqual({ limit: 25 })
  })

  it('sends an entity id without an entity class, because an id identifies its own thing', () => {
    expect(toConfigurationAuditInput(scoped({ entityId: ID }), 25)).toStrictEqual({
      limit: 25,
      entityId: ID,
    })
  })
})
