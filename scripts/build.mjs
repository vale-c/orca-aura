// Generates the Aura Dark app and terminal themes from the vendored palette.
// Usage: node scripts/build.mjs           write themes/, terminal/ and scripts/deviations.json
//        node scripts/build.mjs --check   exit 1 if a committed file differs from the output
// Every source is a VS Code workbench color or a tokenColors selector of the Aura Dark theme that
// upstream's generator makes (src/ports/vscode/templates/theme.json filled with the dark scheme).
// Each Orca token takes the source that paints the same part of VS Code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const PALETTE = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'aura-palette.json'), 'utf8'))
const STYLES = { 'aura-dark': PALETTE.vscode }

// A plain string is an opaque source. `over` paints a translucent source onto that token's color,
// because Orca needs these tokens opaque. `opaque` takes a translucent source's color without its
// alpha. `readable` steps OKLCH lightness until the token reads at `min` (default 4.5:1) on each
// listed token, a [translucent, beneath] pair as Orca paints it. `chatTint` also makes the token
// read as Orca's chat diff text on that tint. `outOfGamut` names the neighboring role to use when
// lightness alone would leave the sRGB gamut.
const APP_TOKENS = {
  '--background': 'editor.background',
  '--editor-surface': 'editor.background',
  '--foreground': 'editor.foreground',
  // Why dropdown: upstream sets no menu.* color, and VS Code paints menus with the dropdown colors.
  '--popover': 'dropdown.background',
  '--popover-foreground': 'dropdown.foreground',
  '--primary': 'button.background',
  '--primary-foreground': 'button.foreground',
  '--muted': 'input.background',
  '--accent': 'list.hoverBackground',
  '--accent-foreground': 'list.hoverForeground',
  '--border': 'panel.border', // also sideBar.border, editorGroup.border and tab.border
  '--input': 'input.border',
  // Why the cursor, not focusBorder: Orca paints the editor cursor and selection (30%) with the
  // ring, and upstream's focusBorder is a 20% tint under Orca's 2:1 ring floor.
  '--ring': 'editorCursor.foreground',
  '--sidebar': 'sideBar.background',
  '--sidebar-foreground': 'sideBar.foreground',
  '--sidebar-accent': 'list.hoverBackground',
  '--sidebar-border': 'sideBar.border',
  '--worktree-sidebar-active': 'list.activeSelectionBackground', // Orca paints it over the sidebar
  '--host-badge': 'badge.background',
  '--host-badge-foreground': 'badge.foreground',
  '--tab-bar': 'editorGroupHeader.tabsBackground',
  // Why over the tab bar: upstream's active tab is fully transparent, so VS Code shows the strip.
  '--tab-active': { from: 'tab.activeBackground', over: '--tab-bar' },
  '--tab-active-foreground': 'tab.activeForeground',
  '--tab-active-indicator': 'tab.activeBorderTop',
  '--tab-inactive': 'tab.inactiveBackground',
  '--tab-inactive-foreground': { from: 'tab.inactiveForeground', readable: ['--tab-inactive'] },
  '--split-divider': 'editorGroup.border',
  // Why focusBorder: upstream sets no sash.hoverBorder, and VS Code then uses focusBorder.
  '--split-divider-hover': 'focusBorder',
  // Why the editor's link color: upstream sets no textLink color, only editorLink.activeForeground.
  '--text-link': { from: 'editorLink.activeForeground', readable: ['--editor-surface'] },
  // Why the text tints' hue: upstream sets no diffEditorOverview color, and VS Code derives the
  // diff overview ruler from these tints.
  '--diff-added': {
    from: 'diffEditor.insertedTextBackground',
    opaque: true,
    chatTint: '--diff-added-background',
    outOfGamut: { syntax: 'markup.inserted' }
  },
  // Why the text tint for the line too: upstream sets no insertedLineBackground, and VS Code then
  // paints changed lines with the text tint.
  '--diff-added-background': 'diffEditor.insertedTextBackground',
  '--diff-added-emphasis': 'diffEditor.insertedTextBackground',
  '--diff-removed': {
    from: 'diffEditor.removedTextBackground',
    opaque: true,
    chatTint: '--diff-removed-background',
    outOfGamut: { syntax: 'markup.deleted' }
  },
  '--diff-removed-background': 'diffEditor.removedTextBackground',
  '--diff-removed-emphasis': 'diffEditor.removedTextBackground',
  // Upstream sets no added color, and VS Code paints renamed files like untracked ones.
  '--git-decoration-added': 'gitDecoration.untrackedResourceForeground',
  '--git-decoration-modified': 'gitDecoration.modifiedResourceForeground',
  '--git-decoration-deleted': 'gitDecoration.deletedResourceForeground',
  '--git-decoration-renamed': 'gitDecoration.untrackedResourceForeground',
  '--git-decoration-untracked': 'gitDecoration.untrackedResourceForeground',
  '--git-decoration-copied': 'gitDecoration.untrackedResourceForeground',
  '--git-decoration-ignored': { from: 'gitDecoration.ignoredResourceForeground', readable: ['--sidebar'], min: 3 }
}
// Left out on purpose: scripts/derived-tokens.json lists each token Orca derives, with the reason.

// Each row takes the color and font style VS Code resolves for the exact selector in `from` from
// upstream's rules: the last rule listing it wins, per setting.
const SYNTAX = [
  { name: 'Comments', from: 'comment', scope: ['comment', 'punctuation.definition.comment'] },
  { name: 'Python docstrings', from: 'string.quoted.docstring.multi.python', scope: ['string.quoted.docstring.multi.python'] },
  { name: 'Strings', from: 'string', scope: ['string'] },
  { name: 'Unquoted strings', from: 'string.unquoted', scope: ['string.unquoted'] },
  { name: 'Constants and numbers', from: 'constant', scope: ['constant'] },
  {
    name: 'CSS units',
    from: 'constant.length.units.css',
    scope: ['constant.length.units.css', 'constant.percentage.units.css']
  },
  { name: 'Keywords and operators', from: 'keyword', scope: ['keyword'] },
  { name: 'Storage', from: 'storage', scope: ['storage'] },
  { name: 'Support', from: 'support', scope: ['support'] },
  { name: 'Support functions', from: 'support.function', scope: ['support.function'] },
  { name: 'Entities', from: 'entity', scope: ['entity'] },
  { name: 'Functions', from: 'entity.name.function', scope: ['entity.name.function', 'meta.function-call.generic.python'] },
  {
    name: 'Types and classes',
    from: 'entity.name.type',
    scope: ['entity.name.type', 'entity.name.class', 'support.class.builtin', 'entity.other.inherited-class']
  },
  { name: 'Interfaces', from: 'entity.name.type.interface', scope: ['entity.name.type.interface'] },
  { name: 'Components', from: 'support.class.component.tsx', scope: ['support.class.component'] },
  { name: 'Tags', from: 'entity.name.tag', scope: ['entity.name.tag'] },
  { name: 'Tag delimiters', from: 'punctuation.definition.tag', scope: ['punctuation.definition.tag'] },
  { name: 'Attributes', from: 'entity.other.attribute-name', scope: ['entity.other.attribute-name'] },
  { name: 'CSS classes', from: 'entity.other.attribute-name.class.css', scope: ['entity.other.attribute-name.class'] },
  { name: 'CSS ids', from: 'entity.other.attribute-name.id.css', scope: ['entity.other.attribute-name.id'] },
  {
    name: 'CSS property names',
    from: 'support.type.property-name.css',
    scope: ['support.type.property-name.css', 'support.type.vendored']
  },
  {
    name: 'CSS values',
    from: 'support.constant.property-value.css',
    scope: ['support.constant.property-value', 'support.constant.font-name', 'support.constant.vendored.property-value']
  },
  { name: 'Variables', from: 'variable', scope: ['variable'] },
  { name: 'Parameters', from: 'variable.parameter', scope: ['variable.parameter'] },
  { name: 'Language variables', from: 'variable.language', scope: ['variable.language'] },
  {
    name: 'Properties and object keys',
    from: 'variable.other.property',
    scope: [
      'variable.other.property',
      'variable.other.object.property',
      'variable.object.property',
      'variable.other.constant.property',
      'meta.object-literal.key'
    ]
  },
  { name: 'Type annotations', from: 'meta.type.annotation', scope: ['meta.type.annotation'] },
  { name: 'Separators', from: 'punctuation.separator', scope: ['punctuation.separator'] },
  {
    name: 'Template expressions',
    from: 'punctuation.definition.template-expression.begin',
    scope: ['punctuation.definition.template-expression', 'punctuation.quasi.element']
  },
  {
    name: 'Embedded code',
    from: 'punctuation.section.embedded',
    scope: ['punctuation.section.embedded', 'meta.embedded.expression', 'meta.jsx.children']
  },
  { name: 'Invalid', from: 'invalid', scope: ['invalid'] },
  { name: 'Headings', from: 'markup.heading', scope: ['markup.heading'] },
  { name: 'Section names', from: 'entity.name.section.markdown', scope: ['entity.name.section'] },
  { name: 'Bold', from: 'markup.bold.markdown', scope: ['markup.bold'] },
  { name: 'Italic', from: 'markup.italic.markdown', scope: ['markup.italic'] },
  { name: 'Underline', from: 'markup.underline', scope: ['markup.underline'] },
  { name: 'Links', from: 'markup.underline.link', scope: ['markup.underline.link'] },
  { name: 'Inline code', from: 'markup.inline.raw.string.markdown', scope: ['markup.inline.raw', 'markup.raw'] },
  { name: 'Lists', from: 'markup.list', scope: ['markup.list'] },
  {
    name: 'Markdown punctuation',
    from: 'punctuation.definition.markdown',
    scope: [
      'punctuation.definition.markdown',
      'punctuation.definition.list.begin.markdown',
      'punctuation.definition.bold.markdown',
      'punctuation.definition.italic.markdown',
      'punctuation.definition.quote.begin.markdown',
      'punctuation.definition.raw.markdown'
    ]
  },
  { name: 'Inserted', from: 'markup.inserted', scope: ['markup.inserted'] },
  { name: 'Changed', from: 'markup.changed', scope: ['markup.changed'] },
  { name: 'Deleted', from: 'markup.deleted', scope: ['markup.deleted'] }
]

// Orca terminal keys and the VS Code colors upstream sets for them. Translucent colors are painted
// onto terminal.background, as VS Code paints them.
const TERMINAL = {
  background: 'terminal.background',
  foreground: 'terminal.foreground',
  cursor: 'terminalCursor.foreground',
  cursorAccent: 'terminalCursor.background',
  selectionBackground: 'terminal.selectionBackground'
}
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const capitalized = (name) => `${name[0].toUpperCase()}${name.slice(1)}`

// Mirrors the opaque text pairs, rings and git decoration checks in Orca's
// renderer/src/lib/plugin-theme-tokens.ts, for the tokens this theme sets.
const CONTRAST_PAIRS = [
  ['--background', '--foreground'],
  ['--background', '--muted-foreground'],
  ['--editor-surface', '--foreground'],
  ['--editor-surface', '--muted-foreground'],
  ['--card', '--card-foreground'],
  ['--popover', '--popover-foreground'],
  ['--primary', '--primary-foreground'],
  ['--secondary', '--secondary-foreground'],
  ['--muted', '--muted-foreground'],
  ['--accent', '--accent-foreground'],
  ['--sidebar', '--sidebar-foreground'],
  ['--sidebar-accent', '--accent-foreground'],
  ['--host-badge', '--host-badge-foreground'],
  ['--tab-active', '--tab-active-foreground'],
  ['--tab-inactive', '--tab-inactive-foreground'],
  ['--tab-inactive', '--tab-active-foreground'],
  ['--editor-surface', '--text-link']
]
// Translucent surfaces, checked as Orca paints them: over the opaque token named.
const PAINTED_PAIRS = [
  ['--worktree-sidebar-active', '--sidebar', '--sidebar-foreground'],
  ['--diff-added-background', '--editor-surface', '--foreground'],
  ['--diff-added-emphasis', '--editor-surface', '--foreground'],
  ['--diff-removed-background', '--editor-surface', '--foreground'],
  ['--diff-removed-emphasis', '--editor-surface', '--foreground']
]
const RINGS = [
  ['--ring', '--background'],
  ['--ring', '--sidebar'],
  ['--tab-active-indicator', '--tab-active']
]
const GIT_DECORATIONS = ['added', 'modified', 'deleted', 'renamed', 'untracked', 'copied', 'ignored']
const MIN_TEXT_CONTRAST = 4.5
const MIN_STATUS_CONTRAST = 3
const MIN_RING_CONTRAST = 2
const MIN_SYNTAX_CONTRAST = 3
// Why above Orca's floors: margin so rounding in another color pipeline cannot tip a shade under.
const MARGIN = 0.05

const parseHex = (hex) => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
  if (!match) {
    throw new Error(`not a hex color: ${hex}`)
  }
  const rgb = [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16))
  return [...rgb, match[2] ? parseInt(match[2], 16) / 255 : 1]
}
const toHex = (rgb) =>
  `#${rgb
    .slice(0, 3)
    .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0'))
    .join('')}`

/** The opaque color a translucent `top` paints over an opaque `bottom`. */
function over(top, bottom) {
  const [r, g, b, a] = parseHex(top)
  const [br, bg, bb] = parseHex(bottom)
  return toHex([r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)])
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex).slice(0, 3).map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToOklab(hex) {
  const [r, g, b] = parseHex(hex).slice(0, 3).map((c) => toLinear(c / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function oklabToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return toHex(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ].map((c) => fromLinear(Math.min(1, Math.max(0, c))) * 255)
  )
}

/** Raises OKLCH lightness (a, b kept: chroma and hue) until `ratioOf` the color reaches `target`. */
function readable(hex, ratioOf, target) {
  const [L, a, b] = hexToOklab(hex)
  let shipped = hex
  for (let next = L; ratioOf(shipped) < target; next += 0.001) {
    if (next > 1) {
      throw new Error(`cannot reach ${target}:1 for ${hex}`)
    }
    shipped = oklabToHex([next, a, b])
  }
  return shipped
}

/** Whether two colors differ in OKLCH lightness only, within the tolerances verify.mjs allows. */
function lightnessOnly(before, after) {
  const lch = (hex) => {
    const [L, a, b] = hexToOklab(hex)
    return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }
  }
  const [x, y] = [lch(before), lch(after)]
  const hueShift = Math.abs(((y.h - x.h + 540) % 360) - 180)
  return Math.abs(y.C - x.C) <= 0.01 && (Math.min(x.C, y.C) <= 0.02 || hueShift <= 3)
}

// Orca's chat (plugin-theme-css-fallbacks.ts, dark base) paints diff text as --foreground mixed
// 30% into the diff hue, on the line tint over the chat canvas, --foreground mixed 5% into
// --background.
const mix = (a, b, percent) => {
  const [x, y] = [parseHex(a), parseHex(b)]
  return toHex(x.map((channel, index) => channel * (percent / 100) + y[index] * (1 - percent / 100)))
}
const chatDiffRatio = (hue, foreground, background, tint) =>
  contrast(mix(foreground, hue, 30), over(tint, mix(foreground, background, 5)))

/** A VS Code workbench color from upstream's theme file for this style, as #rrggbb or #rrggbbaa. */
function source(style, name) {
  const value = style.colors[name]
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    throw new Error(`${style.name} sets no color "${name}"`)
  }
  return value.toLowerCase()
}

/** A workbench color, or `{ syntax: selector }` for the foreground upstream gives that selector. */
const neighbor = (style, ref) =>
  typeof ref === 'string' ? source(style, ref) : upstreamStyle(style, ref.syntax).foreground.toLowerCase()

/** The settings VS Code resolves for exactly this selector: per setting, the last rule listing it. */
function upstreamStyle(style, selector) {
  const settings = {}
  for (const rule of style.tokenColors) {
    const selectors = [rule.scope].flat().flatMap((scope) => scope.split(','))
    if (selectors.some((scope) => scope.trim() === selector)) {
      Object.assign(settings, rule.settings)
    }
  }
  if (!Object.keys(settings).length) {
    throw new Error(`${style.name} has no token rule for "${selector}"`)
  }
  return settings
}

function build(id, style, deviations, roleChanges) {
  const deviate = (kind, name, from, upstream, shipped) =>
    deviations.push({ theme: id, kind, name, source: from, upstream, shipped })
  const tokens = {}
  const resolve = (token) => {
    if (token in tokens) {
      return tokens[token]
    }
    const mapping = APP_TOKENS[token]
    if (!mapping) {
      throw new Error(`${token} is not set by this theme`)
    }
    const spec = typeof mapping === 'string' ? { from: mapping } : mapping
    const upstream = source(style, spec.from)
    let value = spec.over ? over(upstream, resolve(spec.over)) : spec.opaque ? upstream.slice(0, 7) : upstream
    if (spec.readable || spec.chatTint) {
      const min = spec.min ?? MIN_TEXT_CONTRAST
      const surfaces = (spec.readable ?? []).map((surface) =>
        Array.isArray(surface) ? over(resolve(surface[0]), resolve(surface[1])) : resolve(surface)
      )
      const chat = spec.chatTint && [resolve('--foreground'), resolve('--background'), resolve(spec.chatTint)]
      const ratioOf = (color) =>
        Math.min(...surfaces.map((surface) => contrast(color, surface)), ...(chat ? [chatDiffRatio(color, ...chat)] : []))
      const shipped = readable(value, ratioOf, min + MARGIN)
      if (lightnessOnly(value, shipped)) {
        if (shipped !== value) {
          deviate('app', token, spec.from, value, shipped)
        }
        value = shipped
      } else if (spec.outOfGamut && ratioOf(neighbor(style, spec.outOfGamut)) >= min + MARGIN) {
        // Why: lightness alone leaves the sRGB gamut and shifts the hue, so take the neighbor role.
        const to = spec.outOfGamut.syntax ?? spec.outOfGamut
        roleChanges.push({ theme: id, token, from: spec.from, upstream: value, to, shipped: neighbor(style, spec.outOfGamut) })
        value = neighbor(style, spec.outOfGamut)
      } else {
        throw new Error(`${id}: ${token} reaches ${min}:1 only by leaving the sRGB gamut (${value} to ${shipped})`)
      }
    }
    tokens[token] = value
    return value
  }
  for (const token of Object.keys(APP_TOKENS)) {
    resolve(token)
  }

  const fail = (message) => {
    throw new Error(`${id}: ${message}`)
  }
  // Why skip a half-set pair: Orca derives the other half, and verify.mjs checks it with Orca's code.
  for (const [surface, text] of CONTRAST_PAIRS.filter((pair) => pair.every((token) => token in tokens))) {
    const ratio = contrast(tokens[surface], tokens[text])
    if (ratio < MIN_TEXT_CONTRAST) {
      fail(`${surface}/${text} is ${ratio.toFixed(2)}:1, under ${MIN_TEXT_CONTRAST}:1`)
    }
  }
  for (const [surface, beneath, text] of PAINTED_PAIRS) {
    const ratio = contrast(over(tokens[surface], tokens[beneath]), tokens[text])
    if (ratio < MIN_TEXT_CONTRAST) {
      fail(`${surface} over ${beneath} with ${text} is ${ratio.toFixed(2)}:1, under ${MIN_TEXT_CONTRAST}:1`)
    }
  }
  for (const [ring, surface] of RINGS) {
    const ratio = contrast(tokens[ring], tokens[surface])
    if (ratio < MIN_RING_CONTRAST) {
      fail(`${ring}/${surface} is ${ratio.toFixed(2)}:1, under ${MIN_RING_CONTRAST}:1`)
    }
  }
  for (const status of GIT_DECORATIONS) {
    const ratio = contrast(tokens[`--git-decoration-${status}`], tokens['--sidebar'])
    if (ratio < MIN_STATUS_CONTRAST) {
      fail(`--git-decoration-${status} is ${ratio.toFixed(2)}:1 on --sidebar, under ${MIN_STATUS_CONTRAST}:1`)
    }
  }

  const editor = tokens['--editor-surface']
  const tokenColors = SYNTAX.map(({ name, from, scope }) => {
    const { foreground, fontStyle } = upstreamStyle(style, from)
    const settings = {}
    if (foreground) {
      const upstream = foreground.toLowerCase()
      const painted = upstream.length > 7 ? over(upstream, editor) : upstream
      const shipped = readable(painted, (color) => contrast(color, editor), MIN_SYNTAX_CONTRAST + MARGIN)
      if (!lightnessOnly(painted, shipped)) {
        throw new Error(`${id}: ${name} reaches ${MIN_SYNTAX_CONTRAST}:1 only by leaving the sRGB gamut`)
      }
      if (shipped !== painted) {
        deviate('syntax', name, from, painted, shipped)
      }
      settings.foreground = shipped
    }
    if (fontStyle !== undefined) {
      settings.fontStyle = fontStyle
    }
    return { name, scope, settings }
  })

  const terminalBackground = source(style, 'terminal.background')
  const terminalColor = (name) => {
    const value = source(style, name)
    return value.length > 7 ? over(value, terminalBackground) : value
  }
  const terminal = {
    ...Object.fromEntries(Object.entries(TERMINAL).map(([key, name]) => [key, terminalColor(name)])),
    ...Object.fromEntries(ANSI.map((name) => [name, terminalColor(`terminal.ansi${capitalized(name)}`)])),
    ...Object.fromEntries(
      ANSI.map((name) => [`bright${capitalized(name)}`, terminalColor(`terminal.ansiBright${capitalized(name)}`)])
    )
  }

  return {
    [`themes/${id}.json`]: { base: 'dark', tokens, tokenColors },
    [`terminal/${id}.json`]: { schemaVersion: 1, mode: 'dark', terminal }
  }
}

function assertUniqueScopes() {
  const seen = new Set()
  for (const scope of SYNTAX.flatMap((rule) => rule.scope)) {
    if (seen.has(scope)) {
      throw new Error(`scope "${scope}" is listed twice; the later rule would silently win`)
    }
    seen.add(scope)
  }
}

assertUniqueScopes()
const deviations = []
const roleChanges = []
const files = {}
for (const [id, style] of Object.entries(STYLES)) {
  Object.assign(files, build(id, style, deviations, roleChanges))
}
files['scripts/deviations.json'] = deviations

// Upstream colors with alpha are first painted onto the surface beneath, as Orca and VS Code do;
// `upstream` below is that painted color.
console.log('Colors changed in OKLCH lightness only (app text to 4.5:1, git status to 3:1, syntax to 3:1 on the editor):')
for (const { theme, kind, name, source: from, upstream, shipped } of deviations) {
  console.log(`${theme.padEnd(28)} ${kind.padEnd(7)} ${name.padEnd(28)} ${from.padEnd(40)} ${upstream}  ${shipped}`)
}
console.log('Tokens that take a neighboring role, because lightness alone would leave the sRGB gamut:')
for (const { theme, token, from, upstream, to, shipped } of roleChanges) {
  console.log(`${theme.padEnd(28)} ${token.padEnd(28)} ${from} ${upstream} -> ${to} ${shipped}`)
}

const check = process.argv.includes('--check')
const stale = []
for (const [relative, data] of Object.entries(files)) {
  const file = path.join(ROOT, relative)
  const text = `${JSON.stringify(data, null, 2)}\n`
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      stale.push(relative)
    }
  } else {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}
if (stale.length) {
  console.error(`Out of date (run node scripts/build.mjs): ${stale.join(', ')}`)
  process.exit(1)
}
console.log(check ? `All ${Object.keys(files).length} generated files are up to date.` : `Wrote ${Object.keys(files).length} files.`)
