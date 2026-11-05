// Adds the release entry Orca's validator prints for HEAD as the newest entry in orca-catalog.json,
// keeping every older entry. Run it right after the release commit, then commit the catalog alone.
// Usage: ORCA_DIR=/path/to/orca node catalog-entry.mjs <repo>
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const orcaDir = process.env.ORCA_DIR
const repo = path.resolve(process.argv[2] ?? '.')
if (!orcaDir) {
  console.error('Set ORCA_DIR to an Orca checkout with dependencies installed.')
  process.exit(2)
}
const file = path.join(repo, 'orca-catalog.json')
// The entry pins HEAD, so every change other than the catalog itself must be committed first.
const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line && !line.endsWith(' orca-catalog.json'))
if (dirty.length) {
  console.error(`Commit these changes first, so the entry pins them:\n${dirty.join('\n')}`)
  process.exit(1)
}
// On a first release the validator exits 1, because the catalog's `releases` is still empty, and it
// warns that the catalog is uncommitted. It still prints the entry, so read its output whatever the
// exit code, and require only that the manifest is ok.
const run = spawnSync('pnpm', ['-s', 'validate:plugin', repo], { cwd: orcaDir, encoding: 'utf8' })
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
if (!output.includes(`${path.join(repo, 'orca-plugin.json')}: ok`)) {
  console.error(`The validator rejected orca-plugin.json:\n${output}`)
  process.exit(1)
}
const marker = output.indexOf('Catalog release entry for HEAD')
if (marker === -1) {
  console.error(`The validator printed no release entry:\n${output}`)
  process.exit(1)
}
// The entry is the pretty-printed object from the first `{` to the first `}` at column 0.
const start = output.indexOf('{', marker)
const entry = JSON.parse(output.slice(start, output.indexOf('\n}', start) + 2))
const catalog = JSON.parse(readFileSync(file, 'utf8'))
const { releases } = catalog.plugins[0]
if (releases.some((release) => release.version === entry.version)) {
  console.error(`${entry.version} is already in ${file}. Bump the version, or drop the unpushed catalog commit first.`)
  process.exit(1)
}
releases.unshift(entry)
writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Added ${entry.version} at ${entry.commit.slice(0, 7)} (minimumOrca ${entry.minimumOrca}) to ${file}.`)
