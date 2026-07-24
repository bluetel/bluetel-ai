import { rmSync } from 'node:fs'

import { buildSync } from 'esbuild'

rmSync('./dist', { recursive: true, force: true })

buildSync({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/main.js',
  banner: {
    js: [
      "import{createRequire as __cr}from'module';",
      'const require=__cr(import.meta.url);',
      "const __filename=require('url').fileURLToPath(import.meta.url);",
      "const __dirname=require('path').dirname(__filename);",
    ].join(''),
  },
})
