/**
 * PostCSS for the panel. Tailwind v3 runs as a PostCSS plugin (there is no v4 `@tailwindcss/postcss`
 * here), and autoprefixer follows it.
 *
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}

export default config
