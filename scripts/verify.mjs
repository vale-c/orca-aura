// Runs every app theme and terminal theme listed in orca-plugin.json through Orca's own code:
// the strict theme parsers, the token contrast gate (safePluginThemeTokens) and the Monaco
// derivation (derivePluginMonacoTheme).
//
// Usage: ORCA_DIR=/path/to/orca node scripts/verify.mjs
// ORCA_DIR is an Orca checkout after `pnpm install` and `pnpm run build:packages`.
// Exit 0: every theme passes. Exit 1: Orca rejects a theme file, drops a token the theme sets or
// that Orca derives from it, or drops a syntax color, or a lightness table row fails.
// Exit 2: ORCA_DIR is unset or lacks a file or export this script needs.
//
// Lightness table: when scripts/deviations.json exists, verify prints it and checks each row.
// The build writes it, one row per color it moved away from upstream:
//   [{ "theme": "<app or terminal theme id from orca-plugin.json>",
//      "kind": "app" | "syntax" | "terminal",
//      "name": "<app token, tokenColors rule name, or terminal color key>",
//      "source": "<the upstream key or role the color comes from>",
//      "upstream": "#rrggbb", "shipped": "#rrggbb" }]
// A row fails when that theme file does not ship `shipped` at `name`, or when `upstream` and
// `shipped` differ in OKLCH chroma or hue rather than in lightness only.
// kit/examples/deviations.json is an example.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const orcaDir = process.env.ORCA_DIR && path.resolve(process.env.ORCA_DIR)
const setupError = (message) => {
  console.error(message)
  process.exit(2)
}
if (!orcaDir) {
  setupError('Set ORCA_DIR to an Orca checkout after pnpm install and pnpm run build:packages.')
}

/** The first of `candidates` (paths relative to ORCA_DIR), else the only file named like them under `searchRoot`. */
function locateInOrca(candidates, searchRoot) {
  const known = candidates.map((relative) => path.join(orcaDir, relative)).find(existsSync)
  if (known) {
    return known
  }
  const name = path.basename(candidates[0])
  const root = path.join(orcaDir, searchRoot)
  const found = existsSync(root)
    ? readdirSync(root, { recursive: true })
        .filter((entry) => path.basename(entry) === name && !entry.split(path.sep).includes('node_modules'))
        .map((entry) => path.join(root, entry))
    : []
  if (found.length !== 1) {
    setupError(
      `${orcaDir} has none of ${candidates.join(', ')}, and ${found.length ? `${found.length} files` : 'no file'} named ${name} under ${searchRoot}/${found.length ? `: ${found.join(', ')}` : ''}. Update this script's paths for this Orca.`
    )
  }
  return found[0]
}

// Why two paths: Orca moved its plugin scripts into config/scripts/plugin-authoring.
const loaderFile = locateInOrca(
  [
    'config/scripts/plugin-authoring/generated-contracts/plugin-schema-module-loader.mjs',
    'config/scripts/plugin-schema-module-loader.mjs'
  ],
  'config'
)
const { loadPluginSchemaModule, REPO_ROOT } = await import(pathToFileURL(loaderFile).href)
if (typeof loadPluginSchemaModule !== 'function') {
  setupError(`${loaderFile} no longer exports loadPluginSchemaModule.`)
}
// Why the loader's root: it resolves module names against its own src/shared/plugins.
const pluginsSrc = path.join(REPO_ROOT ?? orcaDir, 'src', 'shared', 'plugins')
function orcaModule(relative, names) {
  const file = locateInOrca([relative], 'src')
  const loaded = loadPluginSchemaModule(path.relative(pluginsSrc, file))
  const missing = names.filter((name) => loaded[name] === undefined)
  if (missing.length) {
    setupError(`${file} no longer exports ${missing.join(', ')}.`)
  }
  return loaded
}

const { safePluginThemeTokens } = orcaModule('src/renderer/src/lib/plugin-theme-tokens.ts', ['safePluginThemeTokens'])
const { derivePluginMonacoTheme } = orcaModule('src/renderer/src/lib/plugin-monaco-theme.ts', ['derivePluginMonacoTheme'])
const { parsePluginAppThemeArtifact, PLUGIN_APP_THEME_TOKENS } = orcaModule(
  'src/shared/plugins/artifacts/plugin-theme-artifact.ts',
  ['parsePluginAppThemeArtifact', 'PLUGIN_APP_THEME_TOKENS']
)
const { parsePluginTerminalThemeArtifact } = orcaModule(
  'src/shared/plugins/artifacts/plugin-terminal-theme-artifact.ts',
  ['parsePluginTerminalThemeArtifact']
)
if (safePluginThemeTokens.length !== 4) {
  setupError('safePluginThemeTokens no longer takes (tokens, base, builtIns, probe). Update ORCA_DIR to origin/main, or this script.')
}
const mainCss = readFileSync(locateInOrca(['src/renderer/src/assets/main.css'], 'src'), 'utf8')

const pluginDir = path.resolve(import.meta.dirname, '..')
const read = (relative) => readFileSync(path.join(pluginDir, relative), 'utf8')
const manifest = JSON.parse(read('orca-plugin.json'))
const appThemes = manifest.contributes?.themes ?? []
const terminalThemes = manifest.contributes?.terminalThemes ?? []

/** [r, g, b, a] for hex and for the `color-mix(in srgb, A p%, B)` Orca writes for derived tokens. */
function probe(value) {
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex
    const [r, g, b, a = 255] = full.match(/../g).map((pair) => parseInt(pair, 16))
    return [r, g, b, a / 255]
  }
  const mix = /^color-mix\(in srgb, (#[0-9a-f]+) ([\d.]+)%, (#[0-9a-f]+)\)$/.exec(text)
  const [first, second] = mix ? [probe(mix[1]), probe(mix[3])] : []
  if (!first || !second) {
    return null
  }
  const p = Number(mix[2]) / 100
  return first.map((channel, index) => channel * p + second[index] * (1 - p))
}
const toHex = (rgba) =>
  `#${rgba
    .slice(0, 3)
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0'))
    .join('')}`
const paintedOn = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]

/** What main.css paints per base before a theme does; the app hands these to the contrast gate. */
function builtIns(base) {
  const block = (selector) => {
    const start = mainCss.indexOf(`\n${selector} {\n`)
    const body = start === -1 ? '' : mainCss.slice(start, mainCss.indexOf('\n}', start))
    return Object.fromEntries(
      [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
        .filter(([, token, value]) => PLUGIN_APP_THEME_TOKENS.includes(token) && probe(value))
        .map(([, token, value]) => [token, value.trim()])
    )
  }
  return base === 'dark' ? { ...block(':root'), ...block('.dark') } : block(':root')
}

const failures = []
const fail = (message) => failures.push(message)
const selectorsOf = (rule) =>
  [rule.scope]
    .flat()
    .flatMap((scope) => scope.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean)
const shippedFiles = new Map()

for (const { id, path: file } of appThemes) {
  const text = read(file)
  let theme
  try {
    theme = parsePluginAppThemeArtifact(text, 'strict')
  } catch (error) {
    fail(`${id}: Orca rejects ${file}: ${error.message}`)
    continue
  }
  const raw = JSON.parse(text)
  shippedFiles.set(`app ${id}`, raw)
  for (const [token, value] of Object.entries(raw.tokens)) {
    if (!probe(value)) {
      fail(`${id}: ${token} is "${value}", which verify cannot read. Write it as hex`)
    }
  }
  const defaults = builtIns(theme.base)
  const safe = safePluginThemeTokens(theme.tokens, theme.base, defaults, probe)
  for (const token of Object.keys(theme.tokens).filter((token) => !(token in safe))) {
    const origin = token in raw.tokens ? 'set by the theme' : 'derived by Orca'
    fail(`${id}: ${token} (${theme.tokens[token]}, ${origin}) dropped by safePluginThemeTokens`)
  }

  const monaco = derivePluginMonacoTheme({
    base: theme.base,
    read: (token) => safe[token] ?? defaults[token] ?? '',
    painted: safe,
    probe,
    tokenColors: theme.tokenColors
  })
  if (!monaco) {
    fail(`${id}: derivePluginMonacoTheme returned null, so the editor keeps Orca's built-in colors`)
  }
  const rules = new Map((monaco?.data.rules ?? []).map((rule) => [rule.token, rule]))
  const editor = probe(monaco?.data.colors['editor.background'] ?? '#000000')
  let dropped = 0
  for (const rule of (raw.tokenColors ?? []).filter((rule) => rule.settings.foreground)) {
    const color = probe(rule.settings.foreground)
    const expected = toHex(color[3] < 1 ? paintedOn(color, editor) : color)
    for (const selector of selectorsOf(rule)) {
      const shipped = rules.get(selector)?.foreground?.toLowerCase()
      if (shipped !== expected) {
        dropped += 1
        fail(`${id}: "${rule.name ?? selector}" ${selector} ${rule.settings.foreground} became ${shipped ?? 'nothing'}`)
      }
    }
  }
  const builtInLanguage = ['keyword', 'comment', 'string', 'number', 'type', 'identifier', 'delimiter', 'function']
    .map((token) => `${token} ${rules.get(token)?.foreground ?? '-'}`)
    .join(', ')
  console.log(
    `${id}: tokens kept ${Object.keys(safe).length}/${Object.keys(theme.tokens).length} (${Object.keys(raw.tokens).length} set, the rest derived by Orca), Monaco rules ${rules.size}, dropped syntax colors ${dropped}`
  )
  console.log(`${id}: built-in language tokens: ${builtInLanguage}`)
}

for (const { id, path: file } of terminalThemes) {
  try {
    const text = read(file)
    const { mode, terminal } = parsePluginTerminalThemeArtifact(text, 'strict')
    shippedFiles.set(`terminal ${id}`, JSON.parse(text))
    console.log(`${id} terminal: mode ${mode}, ${Object.keys(terminal).length} colors`)
  } catch (error) {
    fail(`${id} terminal: Orca rejects ${file}: ${error.message}`)
  }
}

function oklch(hex) {
  const linear = probe(hex)
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const [r, g, b] = linear
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI }
}
// Why these tolerances: rounding to 8-bit sRGB moves chroma and hue a little at any lightness,
// and hue is noise on near-grey colors.
const MAX_CHROMA_SHIFT = 0.01
const MAX_HUE_SHIFT_DEGREES = 3
const GREY_CHROMA = 0.02

/** The color a row names in the shipped theme file, or undefined. */
function shippedAt({ theme, kind, name }) {
  if (kind === 'app') {
    return shippedFiles.get(`app ${theme}`)?.tokens?.[name]
  }
  if (kind === 'syntax') {
    return shippedFiles.get(`app ${theme}`)?.tokenColors?.find((rule) => rule.name === name)?.settings.foreground
  }
  return kind === 'terminal' ? shippedFiles.get(`terminal ${theme}`)?.terminal?.[name] : undefined
}

const deviationsFile = path.join(import.meta.dirname, 'deviations.json')
if (existsSync(deviationsFile)) {
  const rows = JSON.parse(readFileSync(deviationsFile, 'utf8'))
  const table = rows.map((row) => {
    const label = `deviations.json ${row.theme} ${row.kind} ${row.name}`
    const actual = shippedAt(row)
    if (!probe(row.upstream ?? '') || !probe(row.shipped ?? '')) {
      fail(`${label}: upstream and shipped must be hex colors`)
      return [row.theme, row.kind, row.name, row.source, row.upstream, row.shipped, '-']
    }
    if (actual?.toLowerCase() !== row.shipped.toLowerCase()) {
      fail(`${label}: the theme ships ${actual ?? 'nothing'} there, not ${row.shipped}`)
    }
    const [before, after] = [oklch(row.upstream), oklch(row.shipped)]
    const hueShift = Math.abs(((after.h - before.h + 540) % 360) - 180)
    if (
      Math.abs(after.C - before.C) > MAX_CHROMA_SHIFT ||
      (Math.min(before.C, after.C) > GREY_CHROMA && hueShift > MAX_HUE_SHIFT_DEGREES)
    ) {
      fail(
        `${label}: ${row.upstream} to ${row.shipped} changes chroma by ${(after.C - before.C).toFixed(3)} and hue by ${hueShift.toFixed(1)} degrees, not lightness only`
      )
    }
    const delta = after.L - before.L
    return [row.theme, row.kind, row.name, row.source, row.upstream, row.shipped, `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`]
  })
  const header = ['theme', 'kind', 'name', 'source', 'upstream', 'shipped', 'OKLCH L']
  const widths = header.map((title, column) => Math.max(title.length, ...table.map((row) => String(row[column]).length)))
  console.log(`\nColors changed in OKLCH lightness only (scripts/deviations.json, ${table.length} rows):`)
  for (const row of [header, ...table]) {
    console.log(row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd())
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`\nAll ${appThemes.length} app and ${terminalThemes.length} terminal themes pass Orca runtime checks.`)
