import { describe, expect, it } from 'vitest'

import {
  cursorPagination,
  dateRange,
  enabledFlag,
  moneyAmount,
  nonEmptyText,
  pageLimit,
  uuidInput,
} from './common'

describe('uuidInput', () => {
  it('accepts a v7 identifier', () => {
    expect(uuidInput.safeParse('01890a5d-ac96-774b-bcce-b302099a8057').success).toBe(true)
  })

  it('rejects anything that is not a uuid', () => {
    expect(uuidInput.safeParse('not-a-uuid').success).toBe(false)
  })
})

describe('nonEmptyText', () => {
  it('trims before measuring, so whitespace is not content', () => {
    expect(nonEmptyText.safeParse('   ').success).toBe(false)
    expect(nonEmptyText.parse('  hello  ')).toBe('hello')
  })
})

describe('moneyAmount', () => {
  it.each(['0', '12', '12.5', '12.0001'])('accepts %s', (value) => {
    expect(moneyAmount.safeParse(value).success).toBe(true)
  })

  it.each(['12.00001', '-1', '1e3', ''])('rejects %s', (value) => {
    expect(moneyAmount.safeParse(value).success).toBe(false)
  })

  it('is a string, because a cap compared against a float is a cap that sometimes fails', () => {
    expect(moneyAmount.safeParse(12).success).toBe(false)
  })
})

describe('pageLimit', () => {
  it('defaults rather than fetching everything when omitted', () => {
    expect(pageLimit.parse(undefined)).toBe(50)
  })

  it('refuses a page size a caller could use to read the whole table', () => {
    expect(pageLimit.safeParse(1000).success).toBe(false)
    expect(pageLimit.safeParse(0).success).toBe(false)
  })
})

describe('cursorPagination', () => {
  it('takes a keyset cursor rather than an offset', () => {
    const parsed = cursorPagination.parse({ cursor: '01890a5d-ac96-774b-bcce-b302099a8057' })

    expect(parsed).toStrictEqual({
      cursor: '01890a5d-ac96-774b-bcce-b302099a8057',
      limit: 50,
    })
  })

  it('rejects a cursor that is not an identifier', () => {
    expect(cursorPagination.safeParse({ cursor: '25' }).success).toBe(false)
  })
})

describe('dateRange', () => {
  it('accepts Dates, which survive the wire because the transformer is superjson', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')

    expect(dateRange.parse({ from })).toStrictEqual({ from })
  })

  it('allows both ends to be omitted', () => {
    expect(dateRange.parse({})).toStrictEqual({})
  })
})

describe('enabledFlag', () => {
  it('requires the flag rather than defaulting it', () => {
    expect(enabledFlag.safeParse({}).success).toBe(false)
    expect(enabledFlag.parse({ enabled: false })).toStrictEqual({ enabled: false })
  })
})
