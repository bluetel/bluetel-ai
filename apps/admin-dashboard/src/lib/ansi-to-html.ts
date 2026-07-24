/**
 * Converts ANSI escape codes in text to HTML spans with inline styles.
 * Supports basic 8-color, bright, and 256-color foreground/background codes.
 */

const ANSI_COLORS: Record<number, string> = {
  30: '#000',
  31: '#c00',
  32: '#0a0',
  33: '#aa0',
  34: '#00a',
  35: '#a0a',
  36: '#0aa',
  37: '#aaa',
  90: '#555',
  91: '#f55',
  92: '#5f5',
  93: '#ff5',
  94: '#55f',
  95: '#f5f',
  96: '#5ff',
  97: '#fff',
}

const ANSI_BG_COLORS: Record<number, string> = {
  40: '#000',
  41: '#c00',
  42: '#0a0',
  43: '#aa0',
  44: '#00a',
  45: '#a0a',
  46: '#0aa',
  47: '#aaa',
  100: '#555',
  101: '#f55',
  102: '#5f5',
  103: '#ff5',
  104: '#55f',
  105: '#f5f',
  106: '#5ff',
  107: '#fff',
}

// 256-color palette (first 16 match the basic colors above)
const get256Color = (n: number): string => {
  if (n < 8) return ANSI_COLORS[30 + n] ?? '#aaa'
  if (n < 16) return ANSI_COLORS[90 + (n - 8)] ?? '#aaa'
  if (n < 232) {
    // 216 color cube: 6x6x6
    const idx = n - 16
    const r = Math.floor(idx / 36)
    const g = Math.floor((idx % 36) / 6)
    const b = idx % 6
    const toHex = (v: number) =>
      v === 0
        ? '00'
        : Math.round((v * 255) / 5)
            .toString(16)
            .padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }
  // Grayscale: 232-255
  const level = 8 + (n - 232) * 10
  const hex = level.toString(16).padStart(2, '0')
  return `#${hex}${hex}${hex}`
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const ansiToHtml = (input: string): string => {
  // Strip some non-printable control sequences (cursor hide/show, erase, etc.)
  const ESC = String.fromCharCode(0x1b)
  const cleaned = input
    .replace(new RegExp(`${ESC}\\[\\?25[hl]`, 'g'), '') // cursor show/hide
    .replace(new RegExp(`${ESC}\\[\\d*[ABCDJK]`, 'g'), '') // cursor movement, erase
    .replace(new RegExp(`${ESC}\\[\\d*G`, 'g'), '') // cursor horizontal absolute
    .replace(new RegExp(`${ESC}\\[\\d*;\\d*[Hf]`, 'g'), '') // cursor position

  const parts: string[] = []
  // Match ANSI SGR sequences: ESC[ ... m
  const regex = new RegExp(`${ESC}\\[([\\d;]*)m`, 'g')
  let lastIndex = 0
  let fg: string | null = null
  let bg: string | null = null
  let bold = false

  let match: RegExpExecArray | null
  while ((match = regex.exec(cleaned)) !== null) {
    // Emit text before this escape
    if (match.index > lastIndex) {
      const text = escapeHtml(cleaned.slice(lastIndex, match.index))
      if (fg != null || bg != null || bold) {
        const styles: string[] = []
        if (fg) styles.push(`color:${fg}`)
        if (bg) styles.push(`background-color:${bg}`)
        if (bold) styles.push('font-weight:bold')
        parts.push(`<span style="${styles.join(';')}">${text}</span>`)
      } else {
        parts.push(text)
      }
    }
    lastIndex = match.index + match[0].length

    // Parse SGR codes
    const codes = match[1].split(';').map(Number)
    let i = 0
    while (i < codes.length) {
      const code = codes[i]
      if (code === 0) {
        fg = null
        bg = null
        bold = false
      } else if (code === 1) {
        bold = true
      } else if (code === 22) {
        bold = false
      } else if (code === 39) {
        fg = null
      } else if (code === 49) {
        bg = null
      } else if (code >= 30 && code <= 37) {
        fg = ANSI_COLORS[code] ?? null
      } else if (code >= 90 && code <= 97) {
        fg = ANSI_COLORS[code] ?? null
      } else if (code >= 40 && code <= 47) {
        bg = ANSI_BG_COLORS[code] ?? null
      } else if (code >= 100 && code <= 107) {
        bg = ANSI_BG_COLORS[code] ?? null
      } else if (code === 38 && codes[i + 1] === 5) {
        // 256-color foreground: ESC[38;5;{n}m
        fg = get256Color(codes[i + 2] ?? 0)
        i += 2
      } else if (code === 48 && codes[i + 1] === 5) {
        // 256-color background: ESC[48;5;{n}m
        bg = get256Color(codes[i + 2] ?? 0)
        i += 2
      }
      i++
    }
  }

  // Emit remaining text
  if (lastIndex < cleaned.length) {
    const text = escapeHtml(cleaned.slice(lastIndex))
    if (fg != null || bg != null || bold) {
      const styles: string[] = []
      if (fg) styles.push(`color:${fg}`)
      if (bg) styles.push(`background-color:${bg}`)
      if (bold) styles.push('font-weight:bold')
      parts.push(`<span style="${styles.join(';')}">${text}</span>`)
    } else {
      parts.push(text)
    }
  }

  return parts.join('')
}

// Log prefix pattern: [STDOUT 2026-05-13T11:48:24.620Z] or [STDERR 2026-05-13T11:48:24.620Z]
const LOG_PREFIX_REGEX = /\[(STDOUT|STDERR)\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s?/g

/**
 * Lightweight markdown-to-HTML for inline content within log lines.
 * Handles: headings, bold, inline code, links, and list items.
 * Applied AFTER ANSI conversion (operates on already-escaped HTML).
 */
const renderMarkdownLine = (html: string): string => {
  // Headings: ## Heading → <strong style="font-size:1.1em">Heading</strong>
  const headingMatch = html.match(/^(#{1,4})\s+(.+)$/)
  if (headingMatch) {
    const level = headingMatch[1].length
    const sizes: Record<number, string> = { 1: '1.4em', 2: '1.2em', 3: '1.1em', 4: '1em' }
    const size = sizes[level] ?? '1em'
    return `<strong style="font-size:${size};display:block;margin:0.5em 0 0.25em">${headingMatch[2]}</strong>`
  }

  // List items: - item or * item → bullet
  const listMatch = html.match(/^(\s*)[-*]\s+(.+)$/)
  if (listMatch) {
    const indent = listMatch[1].length
    const padding = indent > 0 ? `padding-left:${indent + 1}em` : 'padding-left:1em'
    const content = applyInlineFormatting(listMatch[2])
    return `<span style="${padding};display:block">• ${content}</span>`
  }

  // Inline formatting (applied to any line)
  return applyInlineFormatting(html)
}

/**
 * Applies inline markdown formatting: bold, inline code, links, bare URLs.
 */
const applyInlineFormatting = (html: string): string => {
  let result = html

  // Bold: **text** → <strong>text</strong>
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Inline code: `code` → <code style="...">code</code>
  result = result.replace(
    /`([^`]+)`/g,
    '<code style="background:#333;padding:0.1em 0.3em;border-radius:3px;font-size:0.9em">$1</code>',
  )

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" style="color:#58a6ff;text-decoration:underline" target="_blank" rel="noopener">$1</a>',
  )

  // Bare URLs: https://... → clickable link (only if not already inside an href)
  result = result.replace(
    /(?<!href="|">)(https?:\/\/[^\s<"]+)/g,
    '<a href="$1" style="color:#58a6ff;text-decoration:underline" target="_blank" rel="noopener">$1</a>',
  )

  return result
}

/**
 * Preprocesses log content to strip [STDOUT/STDERR timestamp] prefixes,
 * converts ANSI to HTML, renders inline markdown, and wraps STDERR in red.
 */
export const formatLogContent = (input: string): string => {
  const lines = input.split('\n')
  const outputLines: string[] = []

  for (const line of lines) {
    // Detect if this line has a STDERR prefix
    const isStderr = /\[STDERR\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/.test(line)

    // Strip all log-level prefixes
    const stripped = line.replace(LOG_PREFIX_REGEX, '')

    // Skip empty lines that were just prefixes with no content
    if (
      stripped.trim() === '' &&
      line.includes('[STDERR') &&
      !line.replace(LOG_PREFIX_REGEX, '').trim()
    ) {
      continue
    }

    // Convert ANSI codes to HTML, then apply markdown rendering
    const html = renderMarkdownLine(ansiToHtml(stripped))

    if (isStderr && stripped.trim()) {
      outputLines.push(`<span style="color:#f55">${html}</span>`)
    } else {
      outputLines.push(html)
    }
  }

  return outputLines.join('\n')
}
