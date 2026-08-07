import { createDatabaseClient } from '@bluetel-ai/sisyphus-api/db'
import type { Adapter, AdapterUser } from 'next-auth/adapters'
import { describe, expect, it, vi } from 'vitest'

import { createSisyphusAdapter } from './adapter'

/**
 * The adapter is not exercised against a live database here — that is what the migration run and
 * the schema tests in `sisyphus-api` cover. What matters at this seam is that the adapter is built
 * over the platform's own tables and that T037 can replace `createUser` without forking it.
 */

// A real Drizzle handle, because the adapter inspects the driver to pick its dialect. The pool is
// lazy — `db.invalid` is never resolved, since no method on the adapter is called here.
const db = createDatabaseClient({
  connectionString: 'postgres://sisyphus@db.invalid:5432/sisyphus',
}).db

describe('createSisyphusAdapter', () => {
  it('provides the session methods a database-backed strategy depends on (FR-175)', () => {
    const adapter = createSisyphusAdapter({ db })
    for (const method of [
      'createSession',
      'getSessionAndUser',
      'updateSession',
      'deleteSession',
    ] as const) {
      expect(typeof adapter[method]).toBe('function')
    }
  })

  it('provides account linking, which is how a Google identity reaches a users row', () => {
    const adapter = createSisyphusAdapter({ db })
    expect(typeof adapter.linkAccount).toBe('function')
    expect(typeof adapter.getUserByAccount).toBe('function')
  })

  it('resolves a user by email, the citext column the platform joins identity on', () => {
    expect(typeof createSisyphusAdapter({ db }).getUserByEmail).toBe('function')
  })

  it('leaves createUser to T037 when none is supplied', () => {
    // Present, but the stock implementation — it cannot populate `google_subject` or
    // `display_name`, which is precisely why T037 owns the replacement.
    expect(typeof createSisyphusAdapter({ db }).createUser).toBe('function')
  })

  it('takes the T037 createUser seam without the rest of the adapter changing', async () => {
    const createUser = vi.fn<NonNullable<Adapter['createUser']>>(async (user) =>
      Promise.resolve(user),
    )
    const adapter = createSisyphusAdapter({ db, createUser })

    const newUser: AdapterUser = {
      id: '019218a7-0000-7000-8000-000000000001',
      email: 'alice@bluetel.co.uk',
      emailVerified: null,
    }
    // The injected implementation is what runs — nothing touches the database, which is the point:
    // T037 replaces the insert rather than patching the adapter after the fact.
    await expect(adapter.createUser?.(newUser)).resolves.toStrictEqual(newUser)
    expect(createUser).toHaveBeenCalledOnce()

    // Only `createUser` is replaced; everything else is still the Drizzle adapter's.
    expect(typeof adapter.getSessionAndUser).toBe('function')
    expect(typeof adapter.linkAccount).toBe('function')
    expect(typeof adapter.getUserByAccount).toBe('function')
  })
})
