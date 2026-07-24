import type { Metadata } from 'next'

import { ClientProviders } from './client-providers'

export const metadata: Metadata = {
  title: 'Admin Dashboard',
  description: 'Rocky worker administration dashboard',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  )
}
