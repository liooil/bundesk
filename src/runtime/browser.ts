import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppDataDirectory } from './paths'

export type BrowserPreference = 'edge' | 'chrome' | string

export interface FindBrowserOptions {
  preferred?: BrowserPreference
  candidates?: string[]
}

export interface AppWindowOptions extends FindBrowserOptions {
  appId: string
  url: string | URL
  userDataDir?: string
  browserArgs?: string[]
  inheritOutput?: boolean
}

const windowsEdgeCandidates = () => [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

const windowsChromeCandidates = () => [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

const linuxEdgeCandidates = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
]

const linuxChromeCandidates = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export async function findChromiumBrowser(options: FindBrowserOptions = {}): Promise<string | null> {
  if (options.candidates) {
    for (const candidate of options.candidates) {
      if (candidate && await Bun.file(candidate).exists()) return candidate
    }
  }

  const preferred = options.preferred
  if (preferred && preferred !== 'edge' && preferred !== 'chrome') {
    return await Bun.file(preferred).exists() ? preferred : null
  }

  const edge = process.platform === 'win32' ? windowsEdgeCandidates() : linuxEdgeCandidates
  const chrome = process.platform === 'win32' ? windowsChromeCandidates() : linuxChromeCandidates
  const candidates = preferred === 'chrome' ? [...chrome, ...edge] : [...edge, ...chrome]
  for (const candidate of candidates) {
    if (candidate && await Bun.file(candidate).exists()) return candidate
  }
  return null
}

export async function launchAppWindow(options: AppWindowOptions): Promise<Bun.Subprocess | null> {
  const browser = await findChromiumBrowser(options)
  if (!browser) return null

  const userDataDir = options.userDataDir ?? join(getAppDataDirectory(options.appId), 'Browser')
  await mkdir(userDataDir, { recursive: true })
  const output = options.inheritOutput === false ? 'ignore' : 'inherit'
  return Bun.spawn([
    browser,
    `--app=${String(options.url)}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-extensions',
    '--edge-skip-compat-layer-relaunch',
    ...(options.browserArgs ?? []),
  ], {
    stdio: ['ignore', output, output],
  })
}
