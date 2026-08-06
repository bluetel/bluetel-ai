import { describe, expectTypeOf, it } from 'vitest'

import type { ExecutorProtocolVersion, ProtocolMessage } from './index'

describe('executor protocol contract', () => {
  it('pins the protocol version to a literal union, not a widened string', () => {
    expectTypeOf<ExecutorProtocolVersion>().toEqualTypeOf<'v1'>()
    expectTypeOf<ExecutorProtocolVersion>().not.toEqualTypeOf<string>()
  })

  it('requires every protocol message to declare its version', () => {
    expectTypeOf<ProtocolMessage>().toExtend<{ protocolVersion: ExecutorProtocolVersion }>()
    expectTypeOf<{ protocolVersion: 'v1' }>().toExtend<ProtocolMessage>()
  })
})
