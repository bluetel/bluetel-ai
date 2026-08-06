import type { Metadata } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import type { ReactNode } from 'react'

import '../styles/globals.css'

/**
 * The two families, split by authorship (FR-026). Archivo is anything a person wrote; IBM Plex Mono
 * is anything a machine produced. Both load as CSS variables rather than as classes, because the
 * token layer in `globals.css` is what pairs a family with a scale — a primitive reaches for
 * `.type-label-mono`, never for a font name.
 *
 * Only the weights the type scale actually uses are requested: 400 and 600 for Archivo (body, and
 * heading/display/label-button), 400 and 500 for the mono (code, and label-mono/data-mono).
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-archivo',
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Sisyphus',
  description: 'Sisyphus workflow platform admin panel',
}

/**
 * No `data-theme` is set here. Light (`sheet`) and dark (`ink`) are peer themes, so the console
 * follows the operator's system preference until something explicitly chooses; `globals.css` reads
 * the attribute when it is present.
 */
const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
    <body>{children}</body>
  </html>
)

export default RootLayout
