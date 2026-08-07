import { describe, expect, it } from 'vitest'

import { isFinalStatus, nextStatus, parseCloseEvent, parseSegmentEvent } from './log-stream-events'

describe('parseSegmentEvent', () => {
  it('reads a well-formed segment frame', () => {
    expect(
      parseSegmentEvent('{"workflowId":"w1","sequence":3,"s3Key":"logs/w1/3.log","byteSize":512}'),
    ).toStrictEqual({ workflowId: 'w1', sequence: 3, s3Key: 'logs/w1/3.log', byteSize: 512 })
  })

  it('answers undefined rather than throwing inside an event listener', () => {
    expect(parseSegmentEvent('not json')).toBeUndefined()
    expect(parseSegmentEvent('null')).toBeUndefined()
    expect(parseSegmentEvent('[]')).toBeUndefined()
  })

  it('rejects a frame missing a field the viewer keys on', () => {
    expect(parseSegmentEvent('{"sequence":3,"s3Key":"k","byteSize":1}')).toBeUndefined()
    expect(parseSegmentEvent('{"workflowId":"w1","s3Key":"k","byteSize":1}')).toBeUndefined()
    expect(
      parseSegmentEvent('{"workflowId":"","sequence":1,"s3Key":"k","byteSize":1}'),
    ).toBeUndefined()
  })

  it('rejects a sequence that is not a usable index', () => {
    expect(
      parseSegmentEvent('{"workflowId":"w1","sequence":-1,"s3Key":"k","byteSize":1}'),
    ).toBeUndefined()
    expect(
      parseSegmentEvent('{"workflowId":"w1","sequence":1.5,"s3Key":"k","byteSize":1}'),
    ).toBeUndefined()
    expect(
      parseSegmentEvent('{"workflowId":"w1","sequence":"3","s3Key":"k","byteSize":1}'),
    ).toBeUndefined()
  })
})

describe('parseCloseEvent', () => {
  it('reads a terminal close as the log being complete', () => {
    expect(parseCloseEvent('{"reason":"terminal"}')).toBe('complete')
  })

  it('reads a gone close as the run no longer being visible', () => {
    expect(parseCloseEvent('{"reason":"gone"}')).toBe('gone')
  })

  it('treats anything it does not understand as gone, never as complete', () => {
    // Claiming a log is whole on the strength of a frame this build cannot read is the failure
    // that looks like success.
    expect(parseCloseEvent('rubbish')).toBe('gone')
    expect(parseCloseEvent('{"reason":"something-new"}')).toBe('gone')
  })
})

describe('nextStatus', () => {
  it('goes live when the connection opens', () => {
    expect(nextStatus('connecting', 'open')).toBe('live')
  })

  it('reports an interruption rather than silence when the transport fails', () => {
    expect(nextStatus('live', 'error')).toBe('interrupted')
  })

  it('does not let the close that follows a completed run read as an interruption', () => {
    // EventSource fires `error` whenever it closes the connection, including immediately after the
    // server's own close frame.
    expect(nextStatus('complete', 'error')).toBe('complete')
    expect(nextStatus('gone', 'error')).toBe('gone')
  })

  it('accepts a close from any prior status', () => {
    expect(nextStatus('interrupted', 'complete')).toBe('complete')
    expect(nextStatus('connecting', 'gone')).toBe('gone')
  })
})

describe('isFinalStatus', () => {
  it('is true only where reconnecting would be pointless', () => {
    expect(isFinalStatus('complete')).toBe(true)
    expect(isFinalStatus('gone')).toBe(true)
    expect(isFinalStatus('live')).toBe(false)
    expect(isFinalStatus('interrupted')).toBe(false)
    expect(isFinalStatus('connecting')).toBe(false)
  })
})
