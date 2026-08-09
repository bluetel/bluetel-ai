import dns from 'node:dns'

import { describe, expect, it } from 'vitest'

import { installPublicDnsFallback } from './dns-fallback'

const notFound = (hostname: string): NodeJS.ErrnoException => {
  const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException
  error.code = 'ENOTFOUND'
  return error
}

describe('installPublicDnsFallback', () => {
  it('returns the system resolver result without consulting the fallback when it succeeds', async () => {
    const restore = installPublicDnsFallback({
      systemLookup: (_hostname, _options, callback) => {
        callback(null, '10.0.0.1', 4)
      },
      resolvePublicly: () => Promise.reject(new Error('should not be called')),
    })

    try {
      const result = await new Promise((resolve, reject) => {
        dns.lookup('example.internal', {}, (error, address, family) => {
          if (error) reject(error)
          else resolve({ address, family })
        })
      })

      expect(result).toEqual({ address: '10.0.0.1', family: 4 })
    } finally {
      restore()
    }
  })

  it('falls back to the public resolver when the system resolver cannot answer', async () => {
    const restore = installPublicDnsFallback({
      systemLookup: (hostname, _options, callback) => {
        callback(notFound(hostname))
      },
      resolvePublicly: () => Promise.resolve(['10.0.5.134']),
    })

    try {
      const result = await new Promise((resolve, reject) => {
        dns.lookup(
          'sisyphus-staging-database.example.rds.amazonaws.com',
          {},
          (error, address, family) => {
            if (error) reject(error)
            else resolve({ address, family })
          },
        )
      })

      expect(result).toEqual({ address: '10.0.5.134', family: 4 })
    } finally {
      restore()
    }
  })

  it('surfaces the original error when the public resolver also fails', async () => {
    const restore = installPublicDnsFallback({
      systemLookup: (hostname, _options, callback) => {
        callback(notFound(hostname))
      },
      resolvePublicly: () => Promise.reject(new Error('offline')),
    })

    try {
      await expect(
        new Promise((resolve, reject) => {
          dns.lookup('nowhere.example.com', {}, (error) => {
            if (error) reject(error)
            else resolve(undefined)
          })
        }),
      ).rejects.toThrow(/ENOTFOUND/)
    } finally {
      restore()
    }
  })

  it('requests every address when the caller asks for all of them', async () => {
    const restore = installPublicDnsFallback({
      systemLookup: (hostname, _options, callback) => {
        callback(notFound(hostname))
      },
      resolvePublicly: () => Promise.resolve(['10.0.5.134', '10.0.5.135']),
    })

    try {
      const result = await new Promise((resolve, reject) => {
        dns.lookup(
          'sisyphus-staging-database.example.rds.amazonaws.com',
          { all: true },
          (error, addresses) => {
            if (error) reject(error)
            else resolve(addresses)
          },
        )
      })

      expect(result).toEqual([
        { address: '10.0.5.134', family: 4 },
        { address: '10.0.5.135', family: 4 },
      ])
    } finally {
      restore()
    }
  })

  it('restores the original dns.lookup', () => {
    const original = dns.lookup
    const restore = installPublicDnsFallback({
      systemLookup: original,
      resolvePublicly: () => Promise.reject(new Error('unused')),
    })

    expect(dns.lookup).not.toBe(original)
    restore()
    expect(dns.lookup).toBe(original)
  })
})
