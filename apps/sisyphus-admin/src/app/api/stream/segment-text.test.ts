/* cspell:ignore nosniff — the `X-Content-Type-Options` value, spelled exactly as the header requires. */
import type { ObjectStore } from '@sisyphus-admin/lib/bundles'
import { codedError, OBJECT_NOT_FOUND } from '@sisyphus-admin/lib/bundles'
import { describe, expect, it, vi } from 'vitest'

import { MAX_SEGMENT_BYTES, readSegmentText, segmentTextResponse } from './segment-text'

const storeReturning = (text: string): ObjectStore => ({
  put: () => Promise.reject(new Error('not used')),
  get: () => Promise.resolve(new TextEncoder().encode(text)),
})

const storeMissing = (): ObjectStore => ({
  put: () => Promise.reject(new Error('not used')),
  get: () => Promise.reject(codedError(OBJECT_NOT_FOUND, 'gone')),
})

describe('readSegmentText', () => {
  it('decodes the stored bytes as UTF-8', async () => {
    await expect(
      readSegmentText({
        store: storeReturning('run output — with an em dash'),
        bucket: 'logs',
        key: 'logs/w1/1.log',
        byteSize: 30,
      }),
    ).resolves.toStrictEqual({ outcome: 'read', text: 'run output — with an em dash' })
  })

  it('returns the content exactly as stored, because sanitisation happened on the instance', async () => {
    // Output containing angle brackets is *output*. Rewriting it here would disagree with the
    // bytes the run actually produced, which is the record FR-046 requires be readable afterwards.
    const raw = '<script>alert(1)</script> & "quotes"'

    await expect(
      readSegmentText({
        store: storeReturning(raw),
        bucket: 'logs',
        key: 'logs/w1/1.log',
        byteSize: raw.length,
      }),
    ).resolves.toStrictEqual({ outcome: 'read', text: raw })
  })

  it('answers not-found for an object that has aged out, rather than throwing', async () => {
    await expect(
      readSegmentText({
        store: storeMissing(),
        bucket: 'logs',
        key: 'logs/w1/1.log',
        byteSize: 10,
      }),
    ).resolves.toStrictEqual({ outcome: 'not-found' })
  })

  it('refuses an oversized segment from the row, without fetching the object', async () => {
    const get = vi.fn(() => Promise.resolve(new Uint8Array()))

    await expect(
      readSegmentText({
        store: { put: () => Promise.reject(new Error('not used')), get },
        bucket: 'logs',
        key: 'logs/w1/1.log',
        byteSize: MAX_SEGMENT_BYTES + 1,
      }),
    ).resolves.toStrictEqual({ outcome: 'too-large', byteSize: MAX_SEGMENT_BYTES + 1 })
    expect(get).not.toHaveBeenCalled()
  })

  it('propagates an unexpected store failure rather than reporting it as absence', async () => {
    const store: ObjectStore = {
      put: () => Promise.reject(new Error('not used')),
      get: () => Promise.reject(new Error('the bucket is on fire')),
    }

    await expect(
      readSegmentText({ store, bucket: 'logs', key: 'logs/w1/1.log', byteSize: 10 }),
    ).rejects.toThrow('the bucket is on fire')
  })
})

describe('segmentTextResponse', () => {
  it('serves run output as plain text that a browser may not sniff', async () => {
    const response = segmentTextResponse({ outcome: 'read', text: '<b>hello</b>' })

    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('<b>hello</b>')
  })

  it('never lets a scoped read be held in a shared cache', () => {
    for (const result of [
      { outcome: 'read', text: 'x' },
      { outcome: 'not-found' },
      { outcome: 'too-large', byteSize: 1 },
    ] as const) {
      expect(segmentTextResponse(result).headers.get('cache-control')).toBe('no-store')
    }
  })

  it('distinguishes an absent object from one too large to show', () => {
    expect(segmentTextResponse({ outcome: 'not-found' }).status).toBe(404)
    expect(segmentTextResponse({ outcome: 'too-large', byteSize: 2 }).status).toBe(413)
  })
})
