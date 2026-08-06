import { describe, expect, it } from 'vitest'

import { createFakeObjectStore } from './object-store-fake'

describe('the fake object store', () => {
  it('answers head from what was put, and undefined for what was not', async () => {
    const store = createFakeObjectStore()
    store.put({ bucket: 'logs', key: 'workflow-1/segment-1', sizeBytes: 128 })

    await expect(
      store.head({ bucket: 'logs', key: 'workflow-1/segment-1' }),
    ).resolves.toMatchObject({ key: 'workflow-1/segment-1', sizeBytes: 128 })
    await expect(
      store.head({ bucket: 'logs', key: 'workflow-1/segment-2' }),
    ).resolves.toBeUndefined()
  })

  it('keeps buckets apart, so one class of object cannot satisfy another', async () => {
    const store = createFakeObjectStore()
    store.put({ bucket: 'logs', key: 'workflow-1/output' })

    await expect(
      store.head({ bucket: 'artifacts', key: 'workflow-1/output' }),
    ).resolves.toBeUndefined()
  })

  it('lists a prefix in key order and honours a limit', async () => {
    const store = createFakeObjectStore()
    store.put({ bucket: 'logs', key: 'workflow-1/b' })
    store.put({ bucket: 'logs', key: 'workflow-1/a' })
    store.put({ bucket: 'logs', key: 'workflow-2/a' })

    await expect(store.list({ bucket: 'logs', prefix: 'workflow-1/' })).resolves.toMatchObject([
      { key: 'workflow-1/a' },
      { key: 'workflow-1/b' },
    ])
    await expect(
      store.list({ bucket: 'logs', prefix: 'workflow-1/', limit: 1 }),
    ).resolves.toHaveLength(1)
  })

  it('records removals and forgets the object', async () => {
    const store = createFakeObjectStore()
    store.put({ bucket: 'snapshots', key: 'workflow-1.tar.zst' })

    await store.remove({ bucket: 'snapshots', key: 'workflow-1.tar.zst' })

    expect(store.removals).toEqual(['workflow-1.tar.zst'])
    expect(store.keys()).toEqual([])
  })
})
