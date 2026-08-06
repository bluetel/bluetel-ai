import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CardBody } from './card-body'

describe('CardBody', () => {
  it('uses card padding and body type', () => {
    const markup = renderToStaticMarkup(<CardBody>Body</CardBody>)
    expect(markup).toContain('p-default')
    expect(markup).toContain('type-body')
  })

  it('composes a caller class through the shared cn', () => {
    const markup = renderToStaticMarkup(<CardBody className="flex">Body</CardBody>)
    expect(markup).toContain('flex')
    expect(markup).toContain('type-body')
  })
})
