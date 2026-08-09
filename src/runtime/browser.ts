import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppDataDirectory } from './paths'
import { isTermux } from './platform'

export type BrowserPreference = 'edge' | 'chrome' | 'firefox' | string

export interface FindBrowserOptions {
  preferred?: BrowserPreference
  candidates?: string[]
}

export interface FindFirefoxOptions {
  candidates?: string[]
}

export interface AppWindowOptions extends FindBrowserOptions {
  appId: string
  url: string | URL
  userDataDir?: string
  browserArgs?: string[]
  /** Override Firefox discovery, primarily for portable installations. */
  firefoxCandidates?: string[]
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

const windowsFirefoxCandidates = () => [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Mozilla Firefox', 'firefox.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Mozilla Firefox', 'firefox.exe'),
]

const linuxFirefoxCandidates = [
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
  '/snap/bin/firefox',
]

const macosFirefoxCandidates = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
]

export async function findChromiumBrowser(options: FindBrowserOptions = {}): Promise<string | null> {
  if (options.candidates) {
    for (const candidate of options.candidates) {
      if (candidate && await Bun.file(candidate).exists()) return candidate
    }
  }

  const preferred = options.preferred
  if (preferred === 'firefox') return null
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

export async function findFirefoxBrowser(options: FindFirefoxOptions = {}): Promise<string | null> {
  let candidates = options.candidates
  if (!candidates) {
    if (process.platform === 'win32') candidates = windowsFirefoxCandidates()
    else if (process.platform === 'darwin') candidates = macosFirefoxCandidates
    else candidates = linuxFirefoxCandidates
  }
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

function systemBrowserCommand(url: string): string[] | null {
  if (process.platform === 'win32') {
    return ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
  }
  if (process.platform === 'darwin') {
    return ['/usr/bin/open', url]
  }
  if (Bun.which('xdg-open')) return [Bun.which('xdg-open')!, url]
  if (Bun.which('gio')) return [Bun.which('gio')!, 'open', url]
  return null
}

async function openWithSystemBrowser(url: string, inheritOutput: boolean): Promise<void> {
  const command = systemBrowserCommand(url)
  if (!command) {
    console.warn(`[BunDesk] No supported browser or system URL opener was found for ${url}`)
    return
  }
  console.info(`[BunDesk] Opening ${url} with the system default browser (${command[0]})`)
  const output = inheritOutput ? 'inherit' : 'ignore'
  const opener = Bun.spawn(command, { stdio: ['ignore', output, output] })
  const exitCode = await opener.exited
  if (exitCode !== 0) {
    console.warn(`[BunDesk] System browser launcher exited with code ${exitCode}: ${command[0]}`)
  }
}

export async function launchAppWindow(options: AppWindowOptions): Promise<Bun.Subprocess | null> {
  if (isTermux()) return launchTermuxWindow(String(options.url))

  const url = String(options.url)
  const output = options.inheritOutput === false ? 'ignore' : 'inherit'
  const browser = options.preferred === 'firefox' ? null : await findChromiumBrowser(options)
  if (browser) {
    const userDataDir = options.userDataDir ?? join(getAppDataDirectory(options.appId), 'Browser')
    await mkdir(userDataDir, { recursive: true })
    console.info(`[BunDesk] Opening ${url} in Chromium App Mode: ${browser}`)
    return Bun.spawn([
      browser,
      `--app=${url}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-extensions',
      '--edge-skip-compat-layer-relaunch',
      ...(options.browserArgs ?? []),
    ], {
      stdio: ['ignore', output, output],
    })
  }

  const firefox = await findFirefoxBrowser({ candidates: options.firefoxCandidates })
  if (firefox) {
    const userDataDir = options.userDataDir ?? join(getAppDataDirectory(options.appId), 'Firefox')
    await mkdir(userDataDir, { recursive: true })
    console.info(`[BunDesk] Opening ${url} in Firefox: ${firefox}`)
    return Bun.spawn([
      firefox,
      '--new-instance',
      '--profile',
      userDataDir,
      '--new-window',
      url,
      ...(options.browserArgs ?? []),
    ], {
      stdio: ['ignore', output, output],
    })
  }

  await openWithSystemBrowser(url, options.inheritOutput !== false)
  return null
}
