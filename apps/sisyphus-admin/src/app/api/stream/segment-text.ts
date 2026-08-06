import type { ObjectStore } from '@sisyphus-admin/lib/bundles'
import { isCodedError, OBJECT_NOT_FOUND } from '@sisyphus-admin/lib/bundles'

/* cspell:ignore nosniff — the `X-Content-Type-Options` value, spelled exactly as the header requires. */
/**
 * Reading one stored segment back as text.
 *
 * `log_segments` holds a key, a size and a window — the bytes are in the logs bucket (FR-046), so
 * a viewer that renders output needs a read that turns a key into characters. This is that read,
 * kept apart from the route so the decisions in it are testable against
 * `lib/bundles`'s object-store interface rather than against a bucket.
 *
 * ## The content is not re-sanitised here, deliberately
 *
 * Segments are stripped and redacted **on the instance**, before they are ever persisted (FR-019,
 * FR-045, FR-072) — the whole point being that an unsanitised copy never exists at rest. Sanitising
 * again on read would be a second, weaker implementation of a rule that has already been applied,
 * and the first thing it would do is disagree with the stored bytes. What this module does instead
 * is guarantee the bytes are handled as **text**: decoded as UTF-8, served as `text/plain`, and
 * rendered by the viewer as a text node. Output that contains markup is output, not markup.
 */

/** The largest single segment that will be served inline. */
export const MAX_SEGMENT_BYTES = 1_048_576

/** What a read can answer with. `not-found` covers an expired object as well as a wrong key. */
export type SegmentTextResult =
  | { readonly outcome: 'read'; readonly text: string }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'too-large'; readonly byteSize: number }

export interface ReadSegmentTextOptions {
  readonly store: ObjectStore
  readonly bucket: string
  readonly key: string
  /** The size recorded on the row, so an oversized object is refused without fetching it. */
  readonly byteSize: number
  readonly maxBytes?: number
}

/**
 * Read one segment's stored bytes as UTF-8 text.
 *
 * @param options - The store, the bucket, the key and the recorded size.
 * @returns The text, or why it could not be served. Never throws for an absent object: a segment
 *   whose object has aged out of retention is a gap in the record rather than an error, and the
 *   viewer says so instead of failing the whole log.
 */
export const readSegmentText = async (
  options: ReadSegmentTextOptions,
): Promise<SegmentTextResult> => {
  const maxBytes = options.maxBytes ?? MAX_SEGMENT_BYTES

  if (options.byteSize > maxBytes) {
    // Refused from the row, before the object is fetched. A segment this large is a bug on the
    // instance rather than a legitimate chunk, and streaming it into a browser tab would hang the
    // viewer rather than show anything.
    return { outcome: 'too-large', byteSize: options.byteSize }
  }

  try {
    const bytes = await options.store.get({ bucket: options.bucket, key: options.key })
    return { outcome: 'read', text: new TextDecoder().decode(bytes) }
  } catch (error) {
    if (isCodedError(error, OBJECT_NOT_FOUND)) {
      return { outcome: 'not-found' }
    }
    throw error
  }
}

/**
 * The response for a read.
 *
 * `text/plain` with `nosniff`, so a browser cannot be talked into interpreting run output as
 * anything else, and `no-store` because a segment is only ever read by a caller whose scope was
 * checked on this request — a shared cache holding it would outlive that check.
 */
export const segmentTextResponse = (result: SegmentTextResult): Response => {
  switch (result.outcome) {
    case 'read':
      return new Response(result.text, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      })
    case 'not-found':
      return new Response(JSON.stringify({ error: { message: 'Segment not found.' } }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    case 'too-large':
      return new Response(JSON.stringify({ error: { message: 'Segment too large to display.' } }), {
        status: 413,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
  }
}
