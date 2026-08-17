import { describe, it, expect } from 'vitest'

import {
  isEnabled,
  isFixable,
  optionsOf,
  pluginOf,
  requiresTypeChecking,
  severityOf,
  shortNameOf,
} from './classify'

describe('severityOf', () => {
  it('normalises every shape ESLint hands back', () => {
    expect(severityOf(2)).toBe('error')
    expect(severityOf(1)).toBe('warn')
    expect(severityOf(0)).toBe('off')
    expect(severityOf('error')).toBe('error')
    expect(severityOf(['error', { prefer: 'type-imports' }])).toBe('error')
    expect(severityOf([2, {}])).toBe('error')
    expect(severityOf(['off'])).toBe('off')
  })

  it('treats an unrecognised severity as off rather than guessing', () => {
    expect(severityOf(['nonsense'])).toBe('off')
    expect(severityOf(7)).toBe('off')
  })
})

describe('isEnabled', () => {
  it('counts warn and error, not off', () => {
    expect(isEnabled(2)).toBe(true)
    expect(isEnabled(1)).toBe(true)
    expect(isEnabled(0)).toBe(false)
    expect(isEnabled(['off', {}])).toBe(false)
  })
})

describe('optionsOf', () => {
  it('returns the tail of a tuple entry', () => {
    expect(optionsOf(['error', { prefer: 'type-imports' }])).toEqual([{ prefer: 'type-imports' }])
    expect(optionsOf(['error', 'as-needed'])).toEqual(['as-needed'])
  })

  it('returns an empty list for a bare severity', () => {
    expect(optionsOf('error')).toEqual([])
    expect(optionsOf(2)).toEqual([])
  })
})

describe('pluginOf', () => {
  it('reports core rules as eslint', () => {
    expect(pluginOf('no-useless-return')).toBe('eslint')
    expect(pluginOf('arrow-body-style')).toBe('eslint')
  })

  it('splits on the last slash so scoped plugin names survive', () => {
    expect(pluginOf('@typescript-eslint/no-floating-promises')).toBe('@typescript-eslint')
    expect(pluginOf('import-x/order')).toBe('import-x')
    expect(pluginOf('@cspell/spellchecker')).toBe('@cspell')
    expect(pluginOf('prefer-arrow-functions/prefer-arrow-functions')).toBe('prefer-arrow-functions')
  })
})

describe('shortNameOf', () => {
  it('strips the plugin prefix', () => {
    expect(shortNameOf('@typescript-eslint/no-floating-promises')).toBe('no-floating-promises')
    expect(shortNameOf('no-useless-return')).toBe('no-useless-return')
  })
})

describe('requiresTypeChecking', () => {
  it('reads the flag from the rule meta', () => {
    expect(requiresTypeChecking({ docs: { requiresTypeChecking: true } })).toBe(true)
    expect(requiresTypeChecking({ docs: { requiresTypeChecking: false } })).toBe(false)
  })

  it('defaults to false when the rule says nothing', () => {
    expect(requiresTypeChecking({ docs: {} })).toBe(false)
    expect(requiresTypeChecking({})).toBe(false)
    expect(requiresTypeChecking(undefined)).toBe(false)
  })
})

describe('isFixable', () => {
  it('is true only when meta.fixable names a fix kind', () => {
    expect(isFixable({ fixable: 'code' })).toBe(true)
    expect(isFixable({ fixable: 'whitespace' })).toBe(true)
    expect(isFixable({ fixable: null })).toBe(false)
    expect(isFixable({})).toBe(false)
    expect(isFixable(undefined)).toBe(false)
  })

  it('does not count suggestion-only rules as fixable', () => {
    expect(isFixable({ hasSuggestions: true })).toBe(false)
  })
})
