// Loads a theme plugin in a real Orca build and, for every app theme in its orca-plugin.json,
// checks the painted app tokens and editor colors against the theme file, then saves
// <theme id>-editor.png and <theme id>-terminal.png. cover.png (1600x1000) shows the first theme.
//
// Copy into an Orca checkout's tests/e2e/ and run from that checkout:
//   ORCA_THEME_PLUGIN_DIR=/path/to/plugin ORCA_THEME_SHOTS_DIR=/path/to/shots \
//     npx playwright test tests/e2e/theme.spec.ts --config tests/playwright.config.ts --project=electron-headless
// ORCA_THEME_DEMO_DIR (default /tmp/orca-theme-demo) holds the demo project while the test runs. Its
// path shows in the editor shot, so keep it out of $HOME.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, editorTokenColor, enableDevPlugins, openRepoFile } from './helpers/plugin-smoke'
import { discoverActivePtyId, execInTerminal, waitForTerminalOutput } from './helpers/terminal'

type Contribution = { id: string; title: string; path: string }
type Manifest = {
  id: string
  publisher?: string
  contributes: { themes?: Contribution[]; terminalThemes?: Contribution[] }
}
type TokenColorRule = { scope: string | string[]; settings: { foreground?: string } }
type AppTheme = { base: 'light' | 'dark'; tokens: Record<string, string>; tokenColors?: TokenColorRule[] }

const DEMO_ROOT = process.env.ORCA_THEME_DEMO_DIR || '/tmp/orca-theme-demo'
const DEMO_NAME = 'atlas'
const CODE_FILE = 'src/palette.ts'
const CODE = `// Resolve the palette for the active workspace.
import { createTheme, type Theme } from './theme'

export type Style = 'light' | 'dim' | 'dark'

export interface Workspace {
  name: string
  tabs: number
  style: Style
  pinned?: boolean
}

const BACKGROUNDS: Record<Style, string> = {
  light: '#ffffff',
  dim: '#2b2d31',
  dark: '#16171a'
}

/** Pick a compact layout once a workspace has more than a dozen tabs. */
export function openWorkspace(ws: Workspace): Theme {
  const theme = createTheme({ contrast: 0.92, accent: 'blue' })
  if (ws.tabs > 12 && !ws.pinned) {
    return theme.compact()
  }
  return { ...theme, title: \`\${ws.name} (\${ws.style})\`, background: BACKGROUNDS[ws.style] }
}

export async function loadWorkspaces(url: URL): Promise<Workspace[]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(\`atlas: \${response.status}\`)
  return (await response.json()).filter((ws: Workspace) => /^[a-z-]+$/.test(ws.name))
}
`
// [Monaco's text in CODE, the TextMate scope Orca colors it by].
const EDITOR_SAMPLES = [
  ['export', 'keyword'],
  ['// Resolve the palette for the active workspace.', 'comment'],
  ["'blue'", 'string'],
  ['0.92', 'constant.numeric']
] as const

const PALETTE_SCRIPT = `names='black red green yellow blue magenta cyan white'
i=0
for name in $names; do printf '\\033[3%sm%-9s\\033[0m' $i $name; i=$((i + 1)); done; echo
i=0
for name in $names; do printf '\\033[9%sm%-9s\\033[0m' $i $name; i=$((i + 1)); done; echo
for i in 0 1 2 3 4 5 6 7; do printf '\\033[4%sm         \\033[0m' $i; done; echo
for i in 0 1 2 3 4 5 6 7; do printf '\\033[10%sm         \\033[0m' $i; done; echo
`

const DEMO_COMMITS: { message: string; files: Record<string, string> }[] = [
  {
    message: 'Scaffold atlas',
    files: {
      'package.json': '{ "name": "atlas", "private": true }\n',
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n'
    }
  },
  {
    message: 'Add the theme factory',
    files: {
      'src/theme.ts':
        'export type Theme = Record<string, unknown> & { compact(): Theme }\n' +
        'export const createTheme = (options: object): Theme => ({ ...options, compact: () => createTheme(options) })\n'
    }
  },
  { message: 'Resolve the palette per workspace', files: { [CODE_FILE]: CODE } },
  { message: 'Document the palette script', files: { 'README.md': '# atlas\n', 'scripts/palette.sh': PALETTE_SCRIPT } }
]
const DEMO_EDITS: Record<string, string> = {
  'README.md': '# atlas\n\nWorkspaces and the palette each one uses.\n',
  'src/compact.ts': 'export const COMPACT_TAB_LIMIT = 12\n'
}
// Why fixed dates: commit hashes then stay the same from run to run, and so do the shots.
const GIT_DATE = '2026-01-15T10:00:00Z'
const TERMINAL_DEMO = [
  "PROMPT='%F{4}atlas%f %F{5}main%f %F{2}❯%f '; clear",
  'git log --graph --oneline --decorate',
  'git status -sb',
  'sh scripts/palette.sh'
]

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name}. See the header of this spec.`)
  }
  return value
}

/** A clean project, added and opened the way a user would, replacing the fixture repo. */
async function openDemoProject(page: Page, fixtureRepoPath: string): Promise<string> {
  const dir = join(DEMO_ROOT, DEMO_NAME)
  await rm(dir, { recursive: true, force: true })
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, '..'), { recursive: true })
      await writeFile(join(dir, name), text)
    }
  }
  await mkdir(dir, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', DEMO_NAME)
  git('config', 'user.email', `${DEMO_NAME}@example.com`)
  git('config', 'core.pager', 'cat')
  git('config', 'color.ui', 'always')
  for (const commit of DEMO_COMMITS) {
    await write(commit.files)
    git('add', '.')
    git('commit', '-qm', commit.message)
    if (commit.files[CODE_FILE]) {
      git('tag', 'v0.3.0')
    }
  }
  git('branch', 'feature/compact')
  await write(DEMO_EDITS)
  const repoPath = await realpath(dir)
  await page.evaluate(
    async ({ repoPath, fixtureRepoPath }) => {
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      const store = window.__store!
      await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      const fixture = store.getState().repos.find((repo) => repo.path === fixtureRepoPath)
      if (fixture) {
        await store.getState().removeProject(fixture.id, { hostId: fixture.executionHostId ?? 'local', errorFeedback: 'silent' })
      }
    },
    { repoPath, fixtureRepoPath }
  )
  await expect
    .poll(
      () =>
        page.evaluate(async (repoPath) => {
          const store = window.__store!
          const repo = store.getState().repos.find((entry) => entry.path === repoPath)
          if (!repo) {
            return null
          }
          await store.getState().fetchWorktrees(repo.id)
          const worktree = (store.getState().worktreesByRepo[repo.id] ?? [])[0]
          if (worktree) {
            store.getState().setActiveWorktree(worktree.id)
          }
          return store.getState().activeWorktreeId === worktree?.id ? worktree.id : null
        }, repoPath),
      { timeout: 15_000, message: 'the demo project never became the active workspace' }
    )
    .not.toBeNull()
  return repoPath
}

/** Loads the plugin from its folder and returns its key: `<publisher>.<id>`, or `local.<id>` without a publisher. */
async function loadPlugin(page: Page, pluginDir: string, manifest: Manifest): Promise<string> {
  await enableDevPlugins(page, [pluginDir])
  const keys = [...(manifest.publisher ? [`${manifest.publisher}.${manifest.id}`] : []), `local.${manifest.id}`]
  // Why the install fallback: builds that turn development folders off still install local paths.
  const plugin = await page.evaluate(
    async ({ keys, path }) => {
      const find = async () => (await window.api.plugins.refresh()).find((p) => keys.includes(p.pluginKey))
      let found = await find()
      if (!found) {
        await window.api.plugins.install({ kind: 'local-path', path })
        found = await find()
      }
      if (found?.status === 'pending' && found.consentFingerprint) {
        await window.api.plugins.consent({
          pluginKey: found.pluginKey,
          reviewedFingerprint: found.consentFingerprint,
          decision: 'approve'
        })
        found = await find()
      }
      return found
    },
    { keys, path: pluginDir }
  )
  expect(['idle', 'enabled'], `plugin ${keys.join(' or ')}: ${JSON.stringify(plugin)}`).toContain(plugin?.status)
  return plugin!.pluginKey
}

const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

/** The color Orca paints for an opaque or translucent hex foreground on the editor background. */
function paintedRgb(foreground: string, background: string): string {
  const alpha = foreground.length === 9 ? parseInt(foreground.slice(7), 16) / 255 : 1
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16)
  return `rgb(${[1, 3, 5].map((i) => Math.round(channel(foreground, i) * alpha + channel(background, i) * (1 - alpha))).join(', ')})`
}

/** The theme's foreground for a scope: the longest selector that is a dot-prefix of it, later rules winning ties. */
function scopeForeground(theme: AppTheme, scope: string): string | null {
  let best: [number, string] | null = null
  for (const rule of theme.tokenColors ?? []) {
    const selectors = [rule.scope].flat().flatMap((entry) => entry.split(',').map((selector) => selector.trim()))
    for (const selector of selectors) {
      const matches = scope === selector || scope.startsWith(`${selector}.`)
      const score = selector.split('.').length
      if (matches && rule.settings.foreground && score >= (best?.[0] ?? 0)) {
        best = [score, rule.settings.foreground]
      }
    }
  }
  return best?.[1] ?? null
}

const css = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => document.documentElement.style.getPropertyValue(name), token)

async function openAppearanceSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'appearance', repoId: null })
    state?.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="appearance"]')).toBeVisible()
}

async function showTerminal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const tab = state.tabsByWorktree[worktreeId]?.[0]
    if (tab) {
      state.setActiveTab(tab.id)
    }
    state.setActiveTabType('terminal', worktreeId)
  })
}

async function choose(page: Page, select: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: select, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test('every app theme in the plugin loads and paints the app, editor and terminal', async ({ orcaPage, seededRepoPath }) => {
  const pluginDir = requiredEnv('ORCA_THEME_PLUGIN_DIR')
  const shotsDir = requiredEnv('ORCA_THEME_SHOTS_DIR')
  const readJson = async (relative: string) => JSON.parse(await readFile(join(pluginDir, relative), 'utf8'))
  const manifest: Manifest = await readJson('orca-plugin.json')
  const appThemes = manifest.contributes.themes ?? []
  const terminalThemes = manifest.contributes.terminalThemes ?? []
  expect(appThemes.length, 'orca-plugin.json lists no app themes').toBeGreaterThan(0)
  test.setTimeout(120_000 + 60_000 * appThemes.length)
  await mkdir(shotsDir, { recursive: true })
  try {
    const pluginKey = await loadPlugin(orcaPage, pluginDir, manifest)
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    const demoPath = await openDemoProject(orcaPage, await realpath(seededRepoPath))
    await showTerminal(orcaPage)
    const ptyId = await discoverActivePtyId(orcaPage)
    for (const command of TERMINAL_DEMO) {
      await execInTerminal(orcaPage, ptyId, command)
    }
    await waitForTerminalOutput(orcaPage, 'magenta')

    for (const [index, contribution] of appThemes.entries()) {
      const theme: AppTheme = await readJson(contribution.path)
      const mode = theme.base === 'dark' ? 'Dark' : 'Light'
      await openAppearanceSettings(orcaPage)
      await orcaPage.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: mode, exact: true }).click()
      await choose(orcaPage, `${mode} theme`, contribution.title)
      for (const [token, value] of Object.entries(theme.tokens)) {
        await expect.poll(() => css(orcaPage, token), { message: `${contribution.id} ${token}` }).toBe(value)
      }

      const terminalTheme =
        terminalThemes.find((entry) => entry.id === contribution.id) ??
        terminalThemes.find((entry) => entry.title === contribution.title)
      if (terminalThemes.length && !terminalTheme) {
        throw new Error(`no terminal theme has the id or title of app theme ${contribution.id}`)
      }
      if (terminalTheme) {
        const terminal = await readJson(terminalTheme.path)
        await orcaPage.evaluate(
          async ({ id, base, colors }) => {
            const settings = await window.api.settings.set({
              [base === 'dark' ? 'terminalThemeDark' : 'terminalThemeLight']: `plugin:${id}`,
              terminalUseSeparateLightTheme: true,
              terminalPluginPalettes: [{ id: `plugin:${id}`, colors }]
            })
            window.__store?.setState({ settings })
          },
          { id: `${pluginKey}/${terminalTheme.id}`, base: theme.base, colors: terminal.terminal }
        )
      }

      await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
      await openRepoFile(orcaPage, demoPath, CODE_FILE)
      const editorBackground = theme.tokens['--editor-surface'] ?? theme.tokens['--background']
      for (const [text, scope] of EDITOR_SAMPLES) {
        const foreground = scopeForeground(theme, scope)
        if (!foreground) {
          test.info().annotations.push({ type: 'unchecked', description: `${contribution.id} sets no color for ${scope}` })
          continue
        }
        await expect
          .poll(() => editorTokenColor(orcaPage, text), { timeout: 15_000, message: `${contribution.id} ${scope}` })
          .toBe(foreground.length === 9 ? paintedRgb(foreground, editorBackground) : rgb(foreground))
      }
      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        state?.showRightSidebarFiles()
        state?.setRightSidebarOpen(true)
      })
      await orcaPage.waitForTimeout(800)
      await orcaPage.screenshot({ path: join(shotsDir, `${contribution.id}-editor.png`) })
      if (index === 0) {
        await orcaPage.setViewportSize({ width: 1600, height: 1000 })
        await orcaPage.waitForTimeout(800)
        await orcaPage.screenshot({ path: join(shotsDir, 'cover.png') })
        await orcaPage.setViewportSize({ width: 1440, height: 900 })
      }
      await showTerminal(orcaPage)
      await orcaPage.waitForTimeout(800)
      await orcaPage.screenshot({ path: join(shotsDir, `${contribution.id}-terminal.png`) })
    }
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(join(DEMO_ROOT, DEMO_NAME), { recursive: true, force: true })
  }
})
