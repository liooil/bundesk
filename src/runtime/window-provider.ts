import { join } from 'node:path'
import {
  findChromiumBrowser,
  findFirefoxBrowser,
  isPwaInstalled,
  launchAndroidViewIntent,
  launchChromiumAppWindow,
  launchFirefoxWindow,
  launchPwaWindow,
  launchSystemBrowser,
  resolvePwaTarget,
  systemBrowserCommand,
  type AppWindowOptions,
  type InstalledPwaOptions,
} from './browser'
import { getAppDataDirectory } from './paths'
import { isTermux } from './platform'
import { createWebKitWindow, inspectWebKitAvailability, type WebKitWindow } from './webkit'
import { createWebViewWindow, inspectWebView2Availability, type WebViewWindow } from './webview2'
import { createWKWebViewWindow, inspectWKWebViewAvailability, type WKWebViewWindow } from './wkwebview'

export const windowProviderIds = [
  'webview2',
  'webkitgtk',
  'wkwebview',
  'chromium-app',
  'chromium-pwa',
  'firefox-window',
  'system-browser',
  'android-view-intent',
] as const

export type WindowProviderId = typeof windowProviderIds[number]

export type WindowCapability =
  | 'navigation'
  | 'host-ready'
  | 'navigation-ready'
  | 'execute-script'
  | 'messaging'
  | 'close'
  | 'close-observable'
  | 'managed-process'
  | 'external-launch'

export type ProviderFailureKind =
  | 'invalid-config'
  | 'unsupported'
  | 'unavailable'
  | 'launch-failed'
  | 'ready-failed'
  | 'closed-early'

export type ProviderVerification = 'verified' | 'experimental' | 'unverified'
export type ProviderImplementation = 'implemented' | 'not-implemented'

export interface WindowProviderFallback {
  provider: WindowProviderId
  /** Failure from the preceding attempt that permits this fallback. */
  on: readonly ProviderFailureKind[]
}

export interface WindowProviderOptions extends Omit<AppWindowOptions, 'appId' | 'url'> {
  provider: WindowProviderId
  fallback?: readonly WindowProviderFallback[]
  /** Maximum time to wait for the provider's declared readiness evidence. Defaults to 30 seconds. */
  readyTimeoutMs?: number
  pwa?: InstalledPwaOptions
  width?: number
  height?: number
  title?: string
  onMessage?: (message: unknown) => void
  onNavigateCompleted?: (info: { success: boolean; errorStatus: number }) => void
}

export interface OpenWindowProviderOptions extends WindowProviderOptions {
  appId: string
  url: string | URL
}

export interface ProviderDiagnostic {
  code: string
  message: string
  remediation?: readonly string[]
}

export interface WindowProviderMatrixEntry {
  provider: WindowProviderId
  platform: 'win32' | 'linux' | 'darwin' | 'android'
  arch: 'x64' | 'arm64' | 'any'
  implementation: ProviderImplementation
  verification: ProviderVerification
  runtimeRequirements: readonly string[]
  evidence?: string
}

export interface WindowProviderReport {
  provider: WindowProviderId
  capabilities: readonly WindowCapability[]
  compatibility: 'compatible' | 'incompatible'
  availability: 'available' | 'unavailable'
  verification: ProviderVerification
  diagnostics: readonly ProviderDiagnostic[]
}

export interface WindowReadyResult {
  evidence: 'navigation-completed' | 'host-created' | 'process-started' | 'launch-dispatched'
  url: string
  pid?: number
}

export interface WindowCloseResult {
  evidence: 'window-closed' | 'process-exited'
  exitCode: number | null
}

export interface WindowProviderAttempt {
  provider: WindowProviderId
  outcome: 'opened' | 'failed'
  failure?: ProviderFailureKind
  diagnostics: readonly ProviderDiagnostic[]
}
export interface WindowLifecycle {
  ownership: 'window' | 'launcher-process' | 'external'
  windowCloseObservable: boolean
}


interface DesktopWindowHandleBase {
  provider: WindowProviderId
  kind: 'embedded' | 'launcher-process' | 'external'
  capabilities: readonly WindowCapability[]
  ready: Promise<WindowReadyResult>
  closed: Promise<WindowCloseResult> | null
  close(): boolean
  lifecycle: WindowLifecycle
  isClosed(): boolean
  attempts: readonly WindowProviderAttempt[]
}

export interface EmbeddedDesktopWindowHandle extends DesktopWindowHandleBase {
  provider: 'webview2' | 'webkitgtk' | 'wkwebview'
  kind: 'embedded'
  native: WebViewWindow | WebKitWindow | WKWebViewWindow
  navigate(url: string): void
  postMessage(value: unknown): void
  executeScript(script: string): Promise<unknown>
}

export interface ProcessDesktopWindowHandle extends DesktopWindowHandleBase {
  provider: 'chromium-app' | 'chromium-pwa' | 'firefox-window' | 'android-view-intent'
  kind: 'launcher-process'
  process: Bun.Subprocess
  closed: Promise<WindowCloseResult>
}

export interface ExternalDesktopWindowHandle extends DesktopWindowHandleBase {
  provider: 'system-browser'
  kind: 'external'
  closed: null
}

export type DesktopWindowHandle =
  | EmbeddedDesktopWindowHandle
  | ProcessDesktopWindowHandle
  | ExternalDesktopWindowHandle

type UntrackedDesktopWindowHandle =
  | Omit<EmbeddedDesktopWindowHandle, 'attempts'>
  | Omit<ProcessDesktopWindowHandle, 'attempts'>
  | Omit<ExternalDesktopWindowHandle, 'attempts'>

export class WindowProviderError extends Error {
  readonly provider: WindowProviderId
  readonly kind: ProviderFailureKind
  readonly diagnostics: readonly ProviderDiagnostic[]
  readonly attempts: readonly WindowProviderAttempt[]

  constructor(
    provider: WindowProviderId,
    kind: ProviderFailureKind,
    message: string,
    diagnostics: readonly ProviderDiagnostic[] = [],
    attempts: readonly WindowProviderAttempt[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WindowProviderError'
    this.provider = provider
    this.kind = kind
    this.diagnostics = diagnostics
    this.attempts = attempts
  }
}

const embeddedCapabilities = [
  'navigation',
  'host-ready',
  'navigation-ready',
  'execute-script',
  'messaging',
  'close',
  'close-observable',
] as const satisfies readonly WindowCapability[]

const processCapabilities = [
  'host-ready',
  'close',
  'close-observable',
  'managed-process',
] as const satisfies readonly WindowCapability[]
const launcherProcessCapabilities = [
  'host-ready',
  'managed-process',
  'external-launch',
] as const satisfies readonly WindowCapability[]


const externalCapabilities = [
  'host-ready',
  'external-launch',
] as const satisfies readonly WindowCapability[]

const capabilitiesByProvider: Record<WindowProviderId, readonly WindowCapability[]> = {
  webview2: embeddedCapabilities,
  webkitgtk: embeddedCapabilities,
  wkwebview: embeddedCapabilities,
  'chromium-app': processCapabilities,
  'chromium-pwa': launcherProcessCapabilities,
  'firefox-window': processCapabilities,
  'system-browser': externalCapabilities,
  'android-view-intent': launcherProcessCapabilities,
}

/** Release evidence. This data reports facts and never participates in provider selection. */
export const windowProviderMatrix: readonly WindowProviderMatrixEntry[] = [
  {
    provider: 'webview2', platform: 'win32', arch: 'x64', implementation: 'implemented',
    verification: 'experimental', runtimeRequirements: ['bun:ffi cc()', 'WebView2 Runtime'],
    evidence: 'Windows 11 x64: create, navigation, script, messaging, and close smoke passed',
  },
  {
    provider: 'webview2', platform: 'win32', arch: 'arm64', implementation: 'not-implemented',
    verification: 'unverified', runtimeRequirements: ['Bun compiled runtime with native shim loading'],
    evidence: 'Current implementation requires runtime TinyCC, unavailable in the tested Windows arm64 compiled runtime',
  },
  {
    provider: 'webkitgtk', platform: 'linux', arch: 'x64', implementation: 'implemented',
    verification: 'verified', runtimeRequirements: ['bun:ffi cc()', 'WebKit2GTK 4.1', 'desktop display'],
    evidence: 'WSL2 Arch x64: create, navigation, script, messaging, and close smoke passed',
  },
  {
    provider: 'webkitgtk', platform: 'linux', arch: 'arm64', implementation: 'implemented',
    verification: 'unverified', runtimeRequirements: ['bun:ffi cc()', 'WebKit2GTK 4.1', 'desktop display'],
  },
  {
    provider: 'wkwebview', platform: 'darwin', arch: 'arm64', implementation: 'implemented',
    verification: 'verified', runtimeRequirements: ['bun:ffi cc()', 'macOS AppKit and WebKit frameworks'],
    evidence: 'macOS 15 arm64: create, navigation, script, bidirectional messaging, and close smoke passed',
  },
  {
    provider: 'wkwebview', platform: 'darwin', arch: 'x64', implementation: 'implemented',
    verification: 'unverified', runtimeRequirements: ['bun:ffi cc()', 'macOS AppKit and WebKit frameworks'],
  },
  ...(['win32', 'linux', 'darwin'] as const).flatMap((platform) => [
    {
      provider: 'chromium-app' as const, platform, arch: 'any' as const, implementation: 'implemented' as const,
      verification: platform === 'darwin' ? 'unverified' as const : 'verified' as const,
      runtimeRequirements: ['Chromium-family browser'],
    },
    {
      provider: 'chromium-pwa' as const, platform, arch: 'any' as const, implementation: 'implemented' as const,
      verification: platform === 'win32' ? 'verified' as const : 'unverified' as const,
      runtimeRequirements: ['Installed Chromium-family PWA'],
    },
    {
      provider: 'firefox-window' as const, platform, arch: 'any' as const, implementation: 'implemented' as const,
      verification: 'unverified' as const, runtimeRequirements: ['Firefox'],
    },
    {
      provider: 'system-browser' as const, platform, arch: 'any' as const, implementation: 'implemented' as const,
      verification: platform === 'win32' ? 'verified' as const : 'unverified' as const,
      runtimeRequirements: ['System URL opener'],
    },
  ]),
  {
    provider: 'android-view-intent', platform: 'android', arch: 'any', implementation: 'implemented',
    verification: 'unverified', runtimeRequirements: ['Termux', 'Android am or termux-open-url'],
  },
]

export function isWindowProviderId(value: string): value is WindowProviderId {
  return (windowProviderIds as readonly string[]).includes(value)
}

export function getWindowProviderMatrix(): readonly WindowProviderMatrixEntry[] {
  return windowProviderMatrix
}

export async function inspectWindowProvider(
  provider: WindowProviderId,
  options: Partial<OpenWindowProviderOptions> = {},
): Promise<WindowProviderReport> {
  const matrix = matchingMatrixEntry(provider)
  const verification = matrix?.verification ?? 'unverified'
  const capabilities = capabilitiesByProvider[provider]
  const unsupported = (code: string, message: string): WindowProviderReport => ({
    provider,
    capabilities,
    compatibility: 'incompatible',
    availability: 'unavailable',
    verification,
    diagnostics: [{ code, message }],
  })
  const unavailable = (code: string, message: string, remediation?: readonly string[]): WindowProviderReport => ({
    provider,
    capabilities,
    compatibility: 'compatible',
    availability: 'unavailable',
    verification,
    diagnostics: [{ code, message, remediation }],
  })
  const available = (): WindowProviderReport => ({
    provider,
    capabilities,
    compatibility: 'compatible',
    availability: 'available',
    verification,
    diagnostics: [],
  })

  if (matrix?.implementation === 'not-implemented') {
    return unsupported('BUNDESK_PROVIDER_TARGET_UNSUPPORTED', `${provider} is not implemented for ${platformLabel()} ${process.arch}`)
  }

  switch (provider) {
    case 'webview2': {
      if (process.platform !== 'win32') return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'webview2 is available only on Windows')
      if (process.arch !== 'x64') return unsupported('BUNDESK_PROVIDER_ARCH_UNSUPPORTED', `webview2 is not implemented for Windows ${process.arch}`)
      const result = await inspectWebView2Availability()
      return result.available
        ? available()
        : unavailable('BUNDESK_WEBVIEW2_RUNTIME_UNAVAILABLE', result.diagnostic ?? 'WebView2 is unavailable')
    }
    case 'webkitgtk': {
      if (process.platform !== 'linux' || isTermux()) return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'webkitgtk is available only on desktop Linux')
      const result = await inspectWebKitAvailability()
      return result.available
        ? available()
        : unavailable('BUNDESK_WEBKITGTK_RUNTIME_UNAVAILABLE', result.diagnostic ?? 'WebKitGTK is unavailable')
    }
    case 'wkwebview': {
      if (process.platform !== 'darwin') return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'wkwebview is available only on macOS')
      const result = await inspectWKWebViewAvailability()
      return result.available
        ? available()
        : unavailable('BUNDESK_WKWEBVIEW_RUNTIME_UNAVAILABLE', result.diagnostic ?? 'WKWebView is unavailable')
    }
    case 'chromium-app': {
      if (isTermux()) return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'chromium-app is not available in Termux')
      const browser = await findChromiumBrowser(options)
      return browser ? available() : unavailable(
        'BUNDESK_CHROMIUM_NOT_FOUND',
        'No Chromium-family browser was found',
        ['Set window.preferred or window.candidates to a Chromium executable'],
      )
    }
    case 'chromium-pwa': {
      if (isTermux()) return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'chromium-pwa is not available in Termux')
      if (!options.pwa) return unavailable('BUNDESK_PWA_CONFIG_REQUIRED', 'chromium-pwa requires window.pwa')
      try {
        const target = await resolvePwaTarget({ ...options, ...options.pwa })
        return await isPwaInstalled(target)
          ? available()
          : unavailable('BUNDESK_PWA_NOT_INSTALLED', `PWA ${target.appId} is not installed in browser profile ${target.profileDirectory}`)
      } catch (error) {
        return unavailable('BUNDESK_PWA_UNAVAILABLE', errorMessage(error))
      }
    }
    case 'firefox-window': {
      if (isTermux()) return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'firefox-window is not available in Termux')
      const browser = await findFirefoxBrowser({ candidates: options.firefoxCandidates })
      return browser ? available() : unavailable(
        'BUNDESK_FIREFOX_NOT_FOUND',
        'Firefox was not found',
        ['Set window.firefoxCandidates to a Firefox executable'],
      )
    }
    case 'system-browser':
      if (isTermux()) return unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'system-browser does not map to Android VIEW intents')
      return systemBrowserCommand(String(options.url ?? 'about:blank'))
        ? available()
        : unavailable('BUNDESK_SYSTEM_OPENER_NOT_FOUND', 'No system URL opener was found')
    case 'android-view-intent':
      return isTermux()
        ? available()
        : unsupported('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED', 'android-view-intent is available only in Termux')
  }
}

/** Opens exactly the provider chain supplied by the application. No provider is inferred or appended. */
export async function openDesktopWindow(options: OpenWindowProviderOptions): Promise<DesktopWindowHandle> {
  const chain = [
    { provider: options.provider, on: null },
    ...(options.fallback ?? []).map((entry) => ({ provider: entry.provider, on: entry.on })),
  ]
  const attempts: WindowProviderAttempt[] = []
  let precedingFailure: ProviderFailureKind | null = null

  for (const entry of chain) {
    if (entry.on && (!precedingFailure || !entry.on.includes(precedingFailure))) continue
    const report = await inspectWindowProvider(entry.provider, { ...options, provider: entry.provider })
    if (report.compatibility === 'incompatible' || report.availability === 'unavailable') {
      precedingFailure = report.compatibility === 'incompatible' ? 'unsupported' : 'unavailable'
      attempts.push({ provider: entry.provider, outcome: 'failed', failure: precedingFailure, diagnostics: report.diagnostics })
      continue
    }

    try {
      const handle = await openProvider(entry.provider, options, attempts)
      await waitForWindowReady(handle, options.readyTimeoutMs ?? 30_000)
      attempts.push({ provider: entry.provider, outcome: 'opened', diagnostics: [] })
      return { ...handle, attempts }
    } catch (error) {
      const failure = error instanceof WindowProviderError ? error.kind : 'launch-failed'
      const diagnostics = error instanceof WindowProviderError
        ? error.diagnostics
        : [{ code: 'BUNDESK_PROVIDER_LAUNCH_FAILED', message: errorMessage(error) }]
      precedingFailure = failure
      attempts.push({ provider: entry.provider, outcome: 'failed', failure, diagnostics })
    }
  }

  const last = attempts.at(-1)
  const provider = last?.provider ?? options.provider
  const kind = last?.failure ?? 'unavailable'
  const message = attempts.length === 0
    ? `No configured fallback accepts the preceding provider failure`
    : attempts.map((attempt) => `${attempt.provider}: ${attempt.failure ?? attempt.outcome}`).join('; ')
  throw new WindowProviderError(provider, kind, `Unable to open a desktop window (${message})`, last?.diagnostics ?? [], attempts)
}

async function openProvider(
  provider: WindowProviderId,
  options: OpenWindowProviderOptions,
  attempts: readonly WindowProviderAttempt[],
): Promise<UntrackedDesktopWindowHandle> {
  const url = String(options.url)
  switch (provider) {
    case 'webview2':
      return openEmbedded(provider, url, options, attempts, (callbacks) => createWebViewWindow({
        url,
        title: options.title,
        width: options.width,
        height: options.height,
        userDataFolder: options.userDataDir ?? join(getAppDataDirectory(options.appId), 'WebView2'),
        onMessage: options.onMessage,
        onNavigateCompleted: callbacks.onNavigateCompleted,
      }))
    case 'webkitgtk':
      return openEmbedded(provider, url, options, attempts, (callbacks) => createWebKitWindow({
        url,
        title: options.title,
        width: options.width,
        height: options.height,
        userDataDir: options.userDataDir,
        onMessage: options.onMessage,
        onNavigateCompleted: callbacks.onNavigateCompleted,
      }))
    case 'wkwebview':
      return openEmbedded(provider, url, options, attempts, (callbacks) => createWKWebViewWindow({
        url,
        title: options.title,
        width: options.width,
        height: options.height,
        userDataDir: options.userDataDir,
        onMessage: options.onMessage,
        onNavigateCompleted: callbacks.onNavigateCompleted,
      }))
    case 'chromium-app':
      return processHandle(provider, url, await launchChromiumAppWindow({ ...options, appId: options.appId, url }))
    case 'chromium-pwa':
      if (!options.pwa) throw new WindowProviderError(provider, 'invalid-config', 'chromium-pwa requires window.pwa', [], attempts)
      return processHandle(provider, url, await launchPwaWindow({
        ...options.pwa,
        preferred: options.preferred,
        candidates: options.candidates,
        browserArgs: options.browserArgs,
        inheritOutput: options.inheritOutput,
      }))
    case 'firefox-window':
      return processHandle(provider, url, await launchFirefoxWindow({ ...options, appId: options.appId, url }))
    case 'android-view-intent':
      return processHandle(provider, url, await launchAndroidViewIntent(url))
    case 'system-browser':
      await launchSystemBrowser(url, options.inheritOutput !== false)
      return {
        provider,
        lifecycle: { ownership: 'external', windowCloseObservable: false },
        kind: 'external',
        capabilities: capabilitiesByProvider[provider],
        ready: Promise.resolve({ evidence: 'launch-dispatched', url }),
        closed: null,
        close: () => false,
        isClosed: () => false,
      }
  }
}

async function openEmbedded(
  provider: 'webview2' | 'webkitgtk' | 'wkwebview',
  url: string,
  options: OpenWindowProviderOptions,
  attempts: readonly WindowProviderAttempt[],
  create: (callbacks: { onNavigateCompleted(info: { success: boolean; errorStatus: number }): void }) => Promise<WebViewWindow | WebKitWindow | WKWebViewWindow>,
): Promise<Omit<EmbeddedDesktopWindowHandle, 'attempts'>> {
  let resolveReady: ((value: WindowReadyResult) => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<WindowReadyResult>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const native = await create({
    onNavigateCompleted(info) {
      options.onNavigateCompleted?.(info)
      if (info.success) resolveReady?.({ evidence: 'navigation-completed', url })
      else rejectReady?.(new WindowProviderError(
        provider,
        'ready-failed',
        `${provider} navigation failed with status ${info.errorStatus}`,
        [{ code: 'BUNDESK_PROVIDER_NAVIGATION_FAILED', message: `Navigation failed with status ${info.errorStatus}` }],
        attempts,
      ))
    },
  })
  const closed = native.exited.then(() => ({ evidence: 'window-closed', exitCode: native.exitCode }) as const)
  return {
    provider,
    lifecycle: { ownership: 'window', windowCloseObservable: true },
    kind: 'embedded',
    native,
    capabilities: capabilitiesByProvider[provider],
    ready,
    closed,
    close() {
      native.close()
      return true
    },
    isClosed: () => native.exitCode !== null,
    navigate: native.navigate,
    postMessage: native.postMessage,
    executeScript: native.executeScript,
  }
}

function processHandle(
  provider: ProcessDesktopWindowHandle['provider'],
  url: string,
  process: Bun.Subprocess,
): Omit<ProcessDesktopWindowHandle, 'attempts'> {
  return {
    provider,
    lifecycle: {
      ownership: provider === 'chromium-pwa' || provider === 'android-view-intent' ? 'launcher-process' : 'window',
      windowCloseObservable: provider !== 'chromium-pwa' && provider !== 'android-view-intent',
    },
    kind: 'launcher-process',
    process,
    capabilities: capabilitiesByProvider[provider],
    ready: Promise.resolve({ evidence: 'process-started', url, pid: process.pid }),
    closed: process.exited.then((exitCode) => ({ evidence: 'process-exited', exitCode })),
    close() {
      if (process.exitCode !== null) return false
      process.kill()
      return true
    },
    isClosed: () => process.exitCode !== null,
  }
}

async function waitForWindowReady(
  handle: UntrackedDesktopWindowHandle,
  timeoutMs: number,
): Promise<WindowReadyResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    handle.close()
    throw new WindowProviderError(
      handle.provider,
      'invalid-config',
      'window.readyTimeoutMs must be greater than zero',
    )
  }
  let timer: Timer | undefined
  try {
    return await Promise.race([
      handle.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WindowProviderError(
          handle.provider,
          'ready-failed',
          `${handle.provider} did not become ready within ${timeoutMs}ms`,
          [{ code: 'BUNDESK_PROVIDER_READY_TIMEOUT', message: `Readiness timed out after ${timeoutMs}ms` }],
        )), timeoutMs)
      }),
    ])
  } catch (error) {
    handle.close()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function matchingMatrixEntry(provider: WindowProviderId): WindowProviderMatrixEntry | undefined {
  const platform = isTermux() ? 'android' : process.platform
  return windowProviderMatrix.find((entry) =>
    entry.provider === provider &&
    entry.platform === platform &&
    (entry.arch === 'any' || entry.arch === process.arch),
  )
}

function platformLabel(): string {
  return isTermux() ? 'android' : process.platform
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
