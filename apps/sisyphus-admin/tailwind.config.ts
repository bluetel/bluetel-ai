import type { Config } from 'tailwindcss'

import { SISYPHUS_CONTENT_GLOBS, sisyphusTheme } from './src/styles/theme'

/**
 * Tailwind is pinned to v3 workspace-wide, so the token layer is this config extending `theme` with
 * `var(--…)` references rather than a v4 `@theme` block. The values themselves live in
 * `src/styles/globals.css`; the shape of the theme lives in `src/styles/theme.ts`, where it can be
 * tested.
 */
const config: Config = {
  content: [...SISYPHUS_CONTENT_GLOBS],
  theme: sisyphusTheme,
  plugins: [],
}

export default config
