// Adds the release entry Orca's validator prints for HEAD as the newest entry in orca-catalog.json,
// keeping every older entry. Run it right after the release commit, then commit the catalog alone.
// Usage: ORCA_DIR=/path/to/orca node catalog-entry.mjs <repo>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const orcaDir = process.env.ORCA_DIR
const repo = path.resolve(process.argv[2] ?? '.')
if (!orcaDir) {
  console.error('Set ORCA_DIR to an Orca checkout with dependencies installed.')
  process.exit(2)
}
const output = execFileSync('pnpm', ['-s', 'validate:plugin', repo], { cwd: orcaDir, encoding: 'utf8' })
const marker = output.indexOf('Catalog release entry for HEAD')
if (marker === -1) {
  console.error(`The validator printed no release entry:\n${output}`)
  process.exit(1)
}
const entry = JSON.parse(output.slice(output.indexOf('{', marker)))
const file = path.join(repo, 'orca-catalog.json')
const catalog = JSON.parse(readFileSync(file, 'utf8'))
const { releases } = catalog.plugins[0]
if (releases.some((release) => release.version === entry.version)) {
  console.error(`${entry.version} is already in ${file}. Bump the version, or drop the unpushed catalog commit first.`)
  process.exit(1)
}
releases.unshift(entry)
writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Added ${entry.version} at ${entry.commit.slice(0, 7)} (minimumOrca ${entry.minimumOrca}) to ${file}.`)
