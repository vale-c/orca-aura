// Composes the directory cover (1600x1000 PNG) from the E2E's real Orca screenshots and the theme's own
// colors: the plugin name and a palette on a backdrop made from the first theme's colors, beside a framed
// editor screenshot. With several app themes, the window is cut into diagonal slices, one per theme, in
// orca-plugin.json order, so the same code runs through every style.
//
// Usage, from anywhere:
//   ORCA_DIR=/path/to/orca node cover.mjs <repo> <shots> [out]
// <repo>  the theme repo (default: $ORCA_THEME_PLUGIN_DIR, then the current directory)
// <shots> the E2E's ORCA_THEME_SHOTS_DIR, with <theme id>-editor.png per app theme
//         (default: $ORCA_THEME_SHOTS_DIR)
// [out]   default <repo>/images/cover.png
// It also writes <shots>/cover-card.png, the cover at the directory's 290px card size, to view.
// ORCA_DIR is an Orca checkout after pnpm install. Its Playwright Chromium renders the page.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WIDTH = 1600
const HEIGHT = 1000
// docs/reference/plugin-catalog.md: a cover is at most 1024 KB.
const MAX_BYTES = 1024 * 1024
const SYNTAX_SCOPES = ['keyword', 'entity.name.function', 'string', 'constant.numeric', 'entity.name.type', 'variable.parameter', 'storage.type', 'variable']

const fail = (message) => {
  console.error(`cover: ${message}`)
  process.exit(1)
}
const repo = resolve(process.argv[2] ?? process.env.ORCA_THEME_PLUGIN_DIR ?? '.')
const shots = process.argv[3] ?? process.env.ORCA_THEME_SHOTS_DIR
const out = resolve(process.argv[4] ?? join(repo, 'images', 'cover.png'))
if (!shots) fail('pass the shots directory or set ORCA_THEME_SHOTS_DIR. See the header.')
if (!process.env.ORCA_DIR) fail('set ORCA_DIR to an Orca checkout with node_modules. See the header.')
const { chromium } = createRequire(join(process.env.ORCA_DIR, 'package.json'))('playwright')

const readJson = (file) => JSON.parse(readFileSync(join(repo, file), 'utf8'))

/** #rrggbb from any hex form Orca accepts, alpha dropped; null for other color syntax. */
function hex6(value) {
  const digits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value ?? '')?.[1].toLowerCase()
  if (!digits) return null
  return `#${digits.length <= 4 ? [...digits.slice(0, 3)].map((d) => d + d).join('') : digits.slice(0, 6)}`
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]))
function hue(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueGap = (a, b) => Math.min(Math.abs(hue(a) - hue(b)), 360 - Math.abs(hue(a) - hue(b)))

/** The theme's foreground for a scope, matched the way theme.spec.ts matches it. */
function scopeForeground(theme, scope) {
  let best = null
  for (const rule of theme.tokenColors ?? []) {
    const selectors = [rule.scope].flat().flatMap((entry) => entry.split(',').map((selector) => selector.trim()))
    for (const selector of selectors) {
      const matches = scope === selector || scope.startsWith(`${selector}.`)
      const score = selector.split('.').length
      if (matches && rule.settings?.foreground && score >= (best?.[0] ?? 0)) best = [score, rule.settings.foreground]
    }
  }
  return hex6(best?.[1])
}

function loadStyle(contribution) {
  const theme = readJson(contribution.path)
  const t = theme.tokens
  const opaque = (name, fallback) =>
    hex6(t[name] ?? fallback) ?? fail(`${contribution.path} ${name} is ${t[name] ?? fallback}; cover.mjs reads hex colors only`)
  const background = opaque('--editor-surface', t['--background'])
  const foreground = opaque('--foreground')
  const syntax = []
  for (const scope of SYNTAX_SCOPES) {
    const color = scopeForeground(theme, scope)
    if (color && distance(color, background) > 60 && ![foreground, ...syntax].some((seen) => distance(seen, color) < 40)) syntax.push(color)
  }
  const accent = opaque('--ring', t['--primary'] ?? syntax[0] ?? foreground)
  const shot = resolve(shots, `${contribution.id}-editor.png`)
  if (!existsSync(shot)) fail(`missing ${shot}. Run the E2E first, with ORCA_THEME_SHOTS_DIR=${shots}.`)
  return {
    title: contribution.title,
    background,
    deep: opaque('--sidebar', background),
    foreground,
    accent,
    // Why the nearest hue: two glows of neighboring hues blend into one mood; distant hues turn muddy.
    glow: syntax.filter((c) => distance(c, accent) > 40).sort((a, b) => hueGap(a, accent) - hueGap(b, accent))[0] ?? foreground,
    swatches: [foreground, ...syntax].slice(0, 8),
    shot: pathToFileURL(shot).href
  }
}

const manifest = readJson('orca-plugin.json')
const styles = (manifest.contributes.themes ?? []).map(loadStyle)
if (!styles.length) fail('orca-plugin.json lists no app themes')
const lead = styles[0]
const name = manifest.name.replace(/\s+for\s+Orca$/i, '')
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
// "Shades of Purple (Super Dark)" becomes "Super Dark": the name, then the parentheses left around the rest.
const shortTitle = (title) =>
  title
    .replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '')
    .replace(/^\((.+)\)$/, '$1') || title

// The window is the screenshot at its native 1440x900, scaled down, so the traffic lights sit where
// macOS draws them in Orca's inset title bar and the slice geometry is in screenshot pixels.
const SHOT_W = 1440
const SHOT_H = 900
const WIN_LEFT = 640
const WIN_TOP = 150
const SCALE = 0.875
const VISIBLE_W = (WIDTH - WIN_LEFT) / SCALE
const SLANT = 240
// Orca's left sidebar in the E2E's 1440px viewport. The slices share out the code to its right.
const CODE_LEFT = 290

function slices() {
  if (styles.length === 1) return `<img src="${lead.shot}">`
  const n = styles.length
  const edge = (i) => (i === 0 ? -SHOT_W : i === n ? 2 * SHOT_W : CODE_LEFT + ((VISIBLE_W - CODE_LEFT) * i) / n)
  const band = (x0, x1) => `polygon(${x0 + SLANT / 2}px 0,${x1 + SLANT / 2}px 0,${x1 - SLANT / 2}px ${SHOT_H}px,${x0 - SLANT / 2}px ${SHOT_H}px)`
  return styles
    .map((style, i) => {
      const seam = i === 0 ? '' : `<i class="seam" style="background:${style.accent};clip-path:${band(edge(i) - 1.5, edge(i) + 1.5)}"></i>`
      return `<div class="slice" style="clip-path:${band(edge(i), edge(i + 1))}"><img src="${style.shot}"></div>${seam}`
    })
    .join('')
}

const legend =
  styles.length === 1
    ? `<div class="chips">${lead.swatches.map((c) => `<span class="chip" style="background:${c}"></span>`).join('')}</div>`
    : `<div class="styles">${styles
        .map((s) => `<span style="background:${s.background};color:${s.foreground};border-color:${s.accent}80"><b style="background:${s.accent}"></b>${escape(shortTitle(s.title))}</span>`)
        .join('')}</div>`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
body{position:relative;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI","Helvetica Neue",Arial,sans-serif;
  background:radial-gradient(70% 80% at 92% 0%,${lead.accent}50,transparent 70%),radial-gradient(60% 70% at 0% 100%,${lead.glow}38,transparent 72%),linear-gradient(160deg,${lead.deep},${lead.background})}
.text{position:absolute;left:96px;top:0;bottom:0;width:500px;display:flex;flex-direction:column;justify-content:center;gap:36px}
h1{font-weight:800;letter-spacing:-.035em;line-height:.98;color:${lead.foreground};text-wrap:balance}
.chips{display:flex;flex-wrap:wrap;gap:12px}
.chip{width:44px;height:44px;border-radius:12px;box-shadow:inset 0 0 0 1px #ffffff2e,0 6px 16px #0003}
.window{position:absolute;left:${WIN_LEFT}px;top:${WIN_TOP}px;width:${SHOT_W}px;height:${SHOT_H}px;transform:scale(${SCALE});transform-origin:0 0;
  border-radius:18px;overflow:hidden;background:${lead.background};box-shadow:0 50px 110px -20px #000b,0 16px 40px -12px #0009,0 0 0 1px #ffffff24}
.window img,.slice{position:absolute;inset:0;display:block;width:${SHOT_W}px;height:${SHOT_H}px}
.seam{position:absolute;inset:0;opacity:.75}
.styles{display:grid;grid-template-columns:repeat(2,max-content);gap:12px}
.styles span{display:flex;align-items:center;gap:10px;padding:9px 18px;border:1.5px solid;border-radius:999px;font-size:24px;font-weight:600;white-space:nowrap;box-shadow:0 6px 18px #0003}
.styles b{width:12px;height:12px;border-radius:50%}
.lights{position:absolute;left:20px;top:13px;display:flex;gap:8px}
.lights b{width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px #0003}
.lights b:nth-child(2){background:#febc2e}.lights b:nth-child(3){background:#28c840}
</style></head><body>
<div class="text"><h1>${escape(name)}</h1>${legend}</div>
<div class="window">${slices()}<span class="lights"><b></b><b></b><b></b></span></div>
<script>
// The largest title that fits: one line down to 96px, then up to two lines.
const h1 = document.querySelector('h1')
const box = h1.parentElement.clientWidth
outer: for (const [wrap, min, lines] of [['nowrap', 96, 1], ['normal', 56, 2]]) {
  h1.style.whiteSpace = wrap
  for (let size = 128; size >= min; size -= 4) {
    h1.style.fontSize = size + 'px'
    if (h1.scrollWidth <= box && h1.offsetHeight <= size * lines + 4) break outer
  }
}
</script>
</body></html>`

const page = join(dirname(out), `.cover-${process.pid}.html`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(page, html)
const browser = await chromium.launch()
try {
  const cover = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await cover.goto(pathToFileURL(page).href, { waitUntil: 'load' })
  await cover.screenshot({ path: out })
  const card = await browser.newPage({ viewport: { width: 330, height: 221 } })
  await card.setContent(
    `<body style="margin:0;padding:20px;background:#0b0b0e"><img src="data:image/png;base64,${readFileSync(out).toString('base64')}" style="display:block;width:290px;aspect-ratio:16/10;object-fit:cover;border-radius:16px;outline:1px solid #ffffff14"></body>`
  )
  await card.screenshot({ path: join(shots, 'cover-card.png') })
} finally {
  await browser.close()
  rmSync(page, { force: true })
}
const bytes = statSync(out).size
if (bytes > MAX_BYTES) fail(`${out} is ${Math.round(bytes / 1024)} KB, over the ${MAX_BYTES / 1024} KB cover limit`)
console.log(`Wrote ${out} (${Math.round(bytes / 1024)} KB, ${styles.length} theme${styles.length > 1 ? 's' : ''}) and ${join(shots, 'cover-card.png')}`)
