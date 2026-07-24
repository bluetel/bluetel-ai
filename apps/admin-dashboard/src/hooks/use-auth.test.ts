import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// We test the cookie utility functions and auth logic by importing the module
// and testing the exported helpers. Since the React hook requires a DOM environment,
// we focus on the pure logic aspects.

describe('auth cookie utilities', () => {
  let originalDocument: PropertyDescriptor | undefined

  beforeEach(() => {
    // Mock document.cookie
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    let cookieStore = ''
    Object.defineProperty(globalThis, 'document', {
      value: {
        get cookie() {
          return cookieStore
        },
        set cookie(val: string) {
          // Simple cookie store simulation
          const [nameValue] = val.split(';')
          const [name, value] = nameValue.split('=')
          if (val.includes('max-age=0')) {
            // Delete cookie
            const cookies = cookieStore.split('; ').filter((c) => !c.startsWith(`${name}=`))
            cookieStore = cookies.join('; ')
          } else {
            const cookies = cookieStore.split('; ').filter((c) => c && !c.startsWith(`${name}=`))
            cookies.push(`${name}=${value}`)
            cookieStore = cookies.join('; ')
          }
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument)
    } else {
      // @ts-expect-error - cleaning up mock
      delete globalThis.document
    }
  })

  it('getCookie returns null when cookie does not exist', async () => {
    const { getCookie } = await import('./use-auth')
    expect(getCookie('admin_token')).toBeNull()
  })

  it('setCookie stores a cookie and getCookie retrieves it', async () => {
    const { getCookie, setCookie } = await import('./use-auth')
    setCookie('admin_token', 'my-secret-token', 86400)
    expect(getCookie('admin_token')).toBe('my-secret-token')
  })

  it('deleteCookie removes a stored cookie', async () => {
    const { getCookie, setCookie, deleteCookie } = await import('./use-auth')
    setCookie('admin_token', 'my-secret-token', 86400)
    expect(getCookie('admin_token')).toBe('my-secret-token')
    deleteCookie('admin_token')
    expect(getCookie('admin_token')).toBeNull()
  })

  it('getCookie handles encoded values', async () => {
    const { getCookie, setCookie } = await import('./use-auth')
    setCookie('admin_token', 'token with spaces', 86400)
    expect(getCookie('admin_token')).toBe('token with spaces')
  })
})
