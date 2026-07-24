import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3002
const API_TARGET = process.env.WORKER_URL ?? 'http://localhost:3001'
const OUT_DIR = join(import.meta.dirname, 'out')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const proxyToWorker = (req, res) => {
  const target = new URL(req.url, API_TARGET)
  const proxyReq = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad Gateway')
  })
  req.pipe(proxyReq)
}

const serveStatic = (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)

  if (pathname === '/') pathname = '/index.html'

  let filePath = normalize(join(OUT_DIR, pathname))
  if (!filePath.startsWith(OUT_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`
    } else {
      filePath = join(OUT_DIR, '404.html')
      res.writeHead(404)
      createReadStream(filePath).pipe(res)
      return
    }
  }

  const contentType = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType })
  createReadStream(filePath).pipe(res)
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/health') {
    proxyToWorker(req, res)
    return
  }
  serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log(`admin-dashboard listening on port ${PORT}, proxying API to ${API_TARGET}`)
})
