// Copies the Aura Dark palette and the VS Code theme Aura's own generator makes from it.
// Usage: node scripts/vendor-palette.mjs /path/to/aura-theme
// The checkout must be at COMMIT with its dependencies installed (yarn install). Upstream's own
// VS Code port (src/ports/vscode) renders every color through upstream's ts-node, so nothing here
// re-implements its template. The port rewrites packages/vscode in the checkout, and this script
// fails unless the rewritten Aura Dark file equals the one committed at COMMIT.
// Writes scripts/aura-palette.json. Run it only to move to a newer upstream commit.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY = 'https://github.com/daltonmenezes/aura-theme'
const COMMIT = '20924aa0a43975420edd0e0b2f919e07a3eff9c9'
const THEME_FILE = 'packages/vscode/themes/aura-dark-color-theme.json'

const upstream = process.argv[2] && path.resolve(process.argv[2])
if (!upstream) {
  console.error('Pass the path of an aura-theme checkout with its dependencies installed.')
  process.exit(2)
}
const git = (...args) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim()
if (git('rev-parse', 'HEAD') !== COMMIT) {
  throw new Error(`${upstream} is not at ${COMMIT}. Check it out first.`)
}

const source = (relative) => JSON.stringify(path.join(upstream, 'src', relative))
const entry = `
import { Aura } from ${source('core')}
import { VscodePort } from ${source('ports/vscode')}
const { loader, ...api } = Aura
VscodePort(api as any).then(() => console.log(JSON.stringify(api.colorSchemes.dark)))
`
// Why delete it first: a port that silently wrote nothing would leave the committed file in place.
rmSync(path.join(upstream, THEME_FILE))
const dir = mkdtempSync(path.join(tmpdir(), 'aura-vendor-'))
let scheme
try {
  const file = path.join(dir, 'entry.ts')
  writeFileSync(file, entry)
  const tsNode = path.join(upstream, 'node_modules', '.bin', 'ts-node')
  const output = execFileSync(tsNode, ['-r', 'tsconfig-paths/register', '--transpile-only', file], {
    cwd: upstream,
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_PROJECT: path.join(upstream, 'tsconfig.json') }
  })
  scheme = JSON.parse(output.trim().split('\n').at(-1))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
if (!existsSync(path.join(upstream, THEME_FILE)) || git('status', '--porcelain', '--', THEME_FILE)) {
  throw new Error(`upstream's generator wrote a ${THEME_FILE} that differs from the one committed at ${COMMIT}`)
}

const { name, type, colors, tokenColors } = JSON.parse(readFileSync(path.join(upstream, THEME_FILE), 'utf8'))
if (type !== 'dark') {
  throw new Error(`${THEME_FILE} is a ${type} theme; this plugin ships it as dark`)
}
const { version } = JSON.parse(readFileSync(path.join(upstream, 'packages/vscode/package.json'), 'utf8'))
const out = { repository: REPOSITORY, commit: COMMIT, version, scheme, vscode: { file: THEME_FILE, name, colors, tokenColors } }
writeFileSync(path.join(import.meta.dirname, 'aura-palette.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`Vendored ${name} ${version} from ${COMMIT}. The generated theme equals ${THEME_FILE} at that commit.`)
