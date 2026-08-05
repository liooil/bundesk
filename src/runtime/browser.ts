import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppDataDirectory } from './paths'
import { isTermux } from './platform'

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

const macosEdgeCandidates = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const macosChromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
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

  let edge: string[]
  let chrome: string[]
  if (process.platform === 'win32') {
    edge = windowsEdgeCandidates()
    chrome = windowsChromeCandidates()
  } else if (process.platform === 'darwin') {
    edge = macosEdgeCandidates
    chrome = macosChromeCandidates
  } else {
    edge = linuxEdgeCandidates
    chrome = linuxChromeCandidates
  }
  const candidates = preferred === 'chrome' ? [...chrome, ...edge] : [...edge, ...chrome]
  for (const candidate of candidates) {
    if (candidate && await Bun.file(candidate).exists()) return candidate
  }
  return null
}

const termuxUrlLaunchers = [
  ['am', 'start', '-a', 'android.intent.action.VIEW', '-d'],
  ['/system/bin/am', 'start', '-a', 'android.intent.action.VIEW', '-d'],
  ['termux-open-url'],
]

/**
 * Termux has no Chromium CLI with App Mode. The window is an Android VIEW
 * intent: the OS opens the URL in the default (or chosen) browser.
 */
async function launchTermuxWindow(url: string): Promise<Bun.Subprocess | null> {
  for (const launcher of termuxUrlLaunchers) {
    if (await Bun.file(launcher[0]!).exists()) {
      return Bun.spawn([...launcher, url], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    }
  }
  return null
}

export async function launchAppWindow(options: AppWindowOptions): Promise<Bun.Subprocess | null> {
  if (isTermux()) return launchTermuxWindow(String(options.url))

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
