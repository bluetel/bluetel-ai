import path from 'node:path'

import { config } from 'dotenv'
import type { NextConfig } from 'next'

if (process.env.NODE_ENV !== 'production') {
  config({ path: path.resolve(__dirname, '../../.env.local') })
}

const isDev = process.env.NODE_ENV !== 'production'

const nextConfig: NextConfig = {
  // Only use static export for production builds (rewrites don't work with export)
  ...(isDev ? {} : { output: 'export' as const }),
  // In dev mode, proxy API requests to the worker process
  rewrites: async () => [
    {
      source: '/api/:path*',
      destination: 'http://localhost:3001/api/:path*',
    },
    {
      source: '/health',
      destination: 'http://localhost:3001/health',
    },
  ],
}

export default nextConfig
