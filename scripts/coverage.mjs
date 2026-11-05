// Checks that every app theme in orca-plugin.json covers Orca's public theme tokens: each token is
// set by every app theme, or listed in scripts/derived-tokens.json with the reason Orca's own
// derivation or built-in value is right for this theme:
//   { "--sidebar-ring": "Follows --ring, which is upstream's focus color, as in upstream's sidebar." }
// kit/examples/derived-tokens.json is an example.
//
// Usage: ORCA_DIR=/path/to/orca node scripts/coverage.mjs
// ORCA_DIR is an Orca checkout after `pnpm install` and `pnpm run build:packages`. The token list
// is read from Orca's code, so a token Orca adds fails this check until the theme handles it.
// Exit 0: covered. Exit 1: a token is neither set nor listed, or a listed entry is not a public
// token, has an empty reason, or is set by every app theme. Exit 2: setup error.
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
const artifactFile = locateInOrca(['src/shared/plugins/artifacts/plugin-theme-artifact.ts'], 'src')
// Why the loader's root: it resolves module names against its own src/shared/plugins.
const { PLUGIN_APP_THEME_TOKENS: publicTokens } = loadPluginSchemaModule(
  path.relative(path.join(REPO_ROOT ?? orcaDir, 'src', 'shared', 'plugins'), artifactFile)
)
if (!Array.isArray(publicTokens)) {
  setupError(`${artifactFile} no longer exports PLUGIN_APP_THEME_TOKENS.`)
}

const pluginDir = path.resolve(import.meta.dirname, '..')
const read = (relative) => readFileSync(path.join(pluginDir, relative), 'utf8')
const appThemes = (JSON.parse(read('orca-plugin.json')).contributes?.themes ?? []).map(({ id, path: file }) => ({
  id,
  tokens: JSON.parse(read(file)).tokens ?? {}
}))
if (!appThemes.length) {
  setupError('orca-plugin.json lists no app themes under contributes.themes.')
}
const derivedFile = path.join(import.meta.dirname, 'derived-tokens.json')
const derived = existsSync(derivedFile) ? JSON.parse(readFileSync(derivedFile, 'utf8')) : {}
if (typeof derived !== 'object' || derived === null || Array.isArray(derived)) {
  setupError('scripts/derived-tokens.json must be an object of { "<token>": "<reason>" }.')
}

const failures = []
const unsetIn = (token) => appThemes.filter((theme) => !(token in theme.tokens)).map((theme) => theme.id)
for (const token of publicTokens) {
  const missing = unsetIn(token)
  if (missing.length && !(token in derived)) {
    const where = missing.length === appThemes.length ? 'any app theme' : missing.join(', ')
    failures.push(`${token}: not set in ${where}, and not in scripts/derived-tokens.json`)
  }
}
for (const [token, reason] of Object.entries(derived)) {
  if (!publicTokens.includes(token)) {
    failures.push(`${token}: in scripts/derived-tokens.json but not a public theme token in this Orca. Remove it`)
  } else if (!unsetIn(token).length) {
    failures.push(`${token}: in scripts/derived-tokens.json but set by every app theme. Remove it`)
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    failures.push(`${token}: scripts/derived-tokens.json gives no reason`)
  }
}

if (failures.length) {
  console.error(
    `${failures.length} coverage failure(s) against ${publicTokens.length} public tokens${existsSync(derivedFile) ? '' : ' (no scripts/derived-tokens.json)'}:\n${failures.join('\n')}`
  )
  process.exit(1)
}
const setByAll = publicTokens.filter((token) => !unsetIn(token).length)
console.log(
  `All ${publicTokens.length} public tokens covered in ${appThemes.length} app theme(s): ${setByAll.length} set by every theme, ${Object.keys(derived).length} left to Orca (${Object.keys(derived).join(', ') || 'none'}).`
)
