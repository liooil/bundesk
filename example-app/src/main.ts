/**
 * BunDesk playground — the example application intentionally configures and
 * exposes every framework surface so each feature can be tried in one place:
 *
 * - fullstack HTML page (HTML import route, HMR in dev, AOT in prod)
 * - app-owned window provider policy with explicit fallback
 * - provider matrix and window-handle facts through the composable API
 * - PWA manifest/service worker/icons plus install-pwa / policy commands
 * - single instance with a second-instance handler and forwarded argv
 * - both update providers (GitHub Releases by default, static URL via env)
 * - system tray, notifications, desktop integration, service commands
 * - sticky port, runtime environment (context.env), and headless --smoke
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  createDesktopApp,
  type DesktopApp,
  getAppDataDirectory,
  getWindowProviderMatrix,
  githubReleaseProvider,
  isTermux,
  staticBinaryProvider,
  type DesktopAppContext,
  type DesktopNotificationOptions,
  type DesktopWindowOptions,
  type SecondInstanceEvent,
  type UpdateProgress,
  type WindowProviderId,
} from '../../src/index'
import page from './page/index.html'

declare const __EXAMPLE_APP_VERSION__: string

const APP_ID = 'com.bundesk.example-app'
const VERSION = typeof __EXAMPLE_APP_VERSION__ === 'string'
  ? __EXAMPLE_APP_VERSION__
  : (process.env.BUNDESK_EXAMPLE_VERSION ?? '0.4.2').replace(/^v/, '') + '-dev'
const PWA_APP_ID = 'abcdefghijklmnopabcdefghijklmnop'
const PLAYGROUND_PORT = readPlaygroundPort()
const PLAYGROUND_DATA_DIRECTORY = process.env.BUNDESK_EXAMPLE_DATA_DIR ?? getAppDataDirectory(APP_ID)
const SMOKE_DATA_DIRECTORY = isSmokeInvocation()
  ? mkdtempSync(join(tmpdir(), 'bundesk-example-smoke-'))
  : undefined

// The window's onMessage fires before onReady has provided the context;
// route notifications through a mutable holder instead.
let notify: (options: DesktopNotificationOptions) => Promise<boolean> = () => Promise.resolve(false)
let appContext: DesktopAppContext | undefined
let appContextEnv: 'development' | 'production' | undefined
let appContextProvider: WindowProviderId | undefined
let latestUpdateProgress: UpdateProgress | undefined
let lastNavigation: { success: boolean; errorStatus: number; at: string } | undefined

interface RecordedSecondInstanceEvent extends SecondInstanceEvent {
  handledAt: string
}

const secondInstanceEvents: RecordedSecondInstanceEvent[] = []

const recommendedWindow = platformWindowProviders()

const updateProvider = configuredUpdateProvider()
const updates = {
  currentVersion: VERSION,
  checkOnStartup: false,
  provider: updateProvider,
  onProgress: (progress: UpdateProgress) => {
    latestUpdateProgress = progress
  },
}

const app: DesktopApp = createDesktopApp({
  id: APP_ID,
  version: VERSION,
  cli: {
    name: 'example-app',
    description: 'BunDesk playground exercising every framework feature',
    options: [{ flags: '--smoke', description: 'Run the headless CI smoke check and exit' }],
  },
  server: {
    port: PLAYGROUND_PORT,
    stickyPort: SMOKE_DATA_DIRECTORY ? false : { dataDirectory: PLAYGROUND_DATA_DIRECTORY },
    routes: {
      '/': page,
      '/api/info': () => Response.json(appInfo()),
      '/api/playground': () => Response.json(playgroundSnapshot()),
      '/api/providers': () => Response.json({
        matrix: getWindowProviderMatrix(),
        current: appContext ? windowSnapshot(appContext.window) : null,
      }),
      '/api/second-instance': () => Response.json(secondInstanceEvents),
      '/api/update-progress': () => Response.json(latestUpdateProgress ?? { phase: 'idle' }),
      '/api/update-check': async () => {
        if (!appContext?.updater) {
          return Response.json({ error: 'updater is not configured' }, { status: 503 })
        }
        try {
          const result = await appContext.updater.check(AbortSignal.timeout(20_000))
          return Response.json(result)
        } catch (error) {
          return Response.json({
            error: error instanceof Error ? error.message : String(error),
          }, { status: 502 })
        }
      },
      '/api/notify': async (request: Request) => {
        if (request.method !== 'POST') {
          return Response.json({ error: 'use POST' }, { status: 405 })
        }
        const body = await request.json().catch(() => ({})) as { title?: string; body?: string }
        const delivered = await notify({
          title: body.title ?? 'BunDesk playground',
          body: body.body ?? 'Notification delivered through context.notify',
        })
        return Response.json({ delivered })
      },
      '/manifest.webmanifest': () => new Response(JSON.stringify({
        id: '/',
        start_url: '/',
        scope: '/',
        name: 'BunDesk Playground',
        short_name: 'BunDesk',
        description: 'Runnable showcase of the BunDesk desktop framework',
        display: 'standalone',
        background_color: '#f4f5f7',
        theme_color: '#2563eb',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      }), {
        headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
      }),
      '/sw.js': () => new Response(serviceWorkerSource(), {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      }),
      '/icon-192.png': () => new Response(pngResponseBody(192), {
        headers: { 'content-type': 'image/png' },
      }),
      '/icon-512.png': () => new Response(pngResponseBody(512), {
        headers: { 'content-type': 'image/png' },
      }),
    },
  },
  window: {
    ...recommendedWindow,
    path: '/',
    title: 'BunDesk Playground',
    width: 1100,
    height: 760,
    // Windows and Linux have a tray to quit from; keep the backend alive so
    // closing/reopening windows and `--provider chromium-pwa` work. macOS has
    // no tray implementation yet, so let the window own the app lifetime.
    exitWithWindow: process.platform === 'darwin',
    preferred: 'edge',
    userDataDir: join(PLAYGROUND_DATA_DIRECTORY, 'Browser'),
    pwa: {
      appId: PWA_APP_ID,
      profileDirectory: 'Default',
      userDataDir: join(PLAYGROUND_DATA_DIRECTORY, 'Browser'),
      installTimeoutMs: 5 * 60_000,
      policy: {
        createDesktopShortcut: true,
        customName: 'BunDesk Playground',
      },
    },
    onMessage: (message) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'notify') {
        void notify({ title: 'BunDesk playground', body: 'Notification delivered through window.postMessage' })
      }
    },
    onNavigateCompleted: (info) => {
      lastNavigation = { ...info, at: new Date().toISOString() }
      console.log(`[example-app] navigation ${info.success ? 'succeeded' : `failed (${info.errorStatus})`}`)
    },
  },
  singleInstance: SMOKE_DATA_DIRECTORY
    ? { dataDirectory: join(SMOKE_DATA_DIRECTORY, 'instance') }
    : { dataDirectory: join(PLAYGROUND_DATA_DIRECTORY, 'instance') },
  updates,
  notifications: {
    aumid: APP_ID,
  },
  tray: {
    tooltip: 'BunDesk Playground',
    menu: [
      { label: 'Open window', onClick: (context) => { void context.launchWindow() } },
      { label: 'Notify', onClick: (context) => { void context.notify({ title: 'BunDesk playground', body: 'From the tray menu' }) } },
      { label: '', separator: true },
      { label: 'Quit', onClick: (context) => void context.stop() },
    ],
  },
  desktopIntegration: {
    startMenuShortcut: { name: 'bundesk-example-app', description: 'BunDesk framework playground' },
    fileAssociations: [{
      extension: '.bundesk-demo',
      progId: 'com.bundesk.example-app.demo',
      description: 'BunDesk demo document',
    }],
  },
  onSecondInstance: async (event, context) => {
    secondInstanceEvents.unshift({ ...event, handledAt: new Date().toISOString() })
    if (!context.window || context.window.isClosed()) {
      await context.launchWindow()
    }
    await context.notify({
      title: 'BunDesk playground',
      body: `Second instance forwarded: ${event.argv.join(' ') || '(no arguments)'}`,
    })
  },
  onReady: async (context) => {
    appContext = context
    notify = context.notify
    appContextEnv = context.env
    appContextProvider = context.windowProvider ?? recommendedWindow.provider
    console.log(`[example-app] ${VERSION} ready: ${context.url.href} env=${context.env}`)
  },
})

function platformWindowProviders(): Pick<DesktopWindowOptions, 'provider' | 'fallback'> {
  if (isTermux()) return { provider: 'android-view-intent' }
  if (process.platform === 'win32') {
    return {
      provider: 'webview2',
      fallback: [
        { provider: 'chromium-app', on: ['unsupported', 'unavailable'] },
        { provider: 'firefox-window', on: ['unsupported', 'unavailable'] },
      ],
    }
  }
  if (process.platform === 'linux') {
    return {
      provider: 'webkitgtk',
      fallback: [
        { provider: 'chromium-app', on: ['unsupported', 'unavailable'] },
        { provider: 'firefox-window', on: ['unsupported', 'unavailable'] },
      ],
    }
  }
  return {
    provider: 'chromium-app',
    fallback: [{ provider: 'firefox-window', on: ['unsupported', 'unavailable'] }],
  }
}

function providerName(): WindowProviderId {
  return recommendedWindow.provider
}

function configuredUpdateProvider() {
  const staticUrl = process.env.BUNDESK_EXAMPLE_UPDATE_URL
  if (staticUrl) {
    return staticBinaryProvider({
      binaryUrl: staticUrl,
      version: process.env.BUNDESK_EXAMPLE_UPDATE_VERSION,
      changelogUrl: process.env.BUNDESK_EXAMPLE_UPDATE_CHANGELOG_URL,
      structuralUpdates: true,
    })
  }
  return githubReleaseProvider({
    owner: 'liooil',
    repository: 'bundesk',
    assetName: {
      'windows-x64': 'example-app.exe',
      'linux-x64': 'example-app-linux',
      'darwin-arm64': 'example-app-macos',
      'darwin-x64': 'example-app-macos-x64',
    },
    structuralUpdates: true,
  })
}

interface PlaygroundInfo {
  id: string
  version: string
  env: 'development' | 'production'
  platform: NodeJS.Platform
  arch: string
  provider: WindowProviderId
  url: string | null
  singleInstance: boolean
  updater: 'github-release' | 'static-binary'
  tray: boolean
  notifications: boolean
  desktopIntegration: boolean
  pwa: boolean
}

function appInfo(): PlaygroundInfo {
  return {
    id: APP_ID,
    version: VERSION,
    env: appContextEnv ?? 'development',
    platform: process.platform,
    arch: process.arch,
    provider: appContextProvider ?? providerName(),
    url: appContext?.url.href ?? null,
    singleInstance: true,
    updater: updateProviderName(),
    tray: true,
    notifications: true,
    desktopIntegration: true,
    pwa: true,
  }
}

interface PlaygroundSnapshot {
  info: PlaygroundInfo
  window: ReturnType<typeof windowSnapshot>
  update: {
    provider: 'github-release' | 'static-binary'
    currentVersion: string
    checkOnStartup: boolean
    structuralUpdates: boolean
    progress: UpdateProgress | null
  }
  navigation: typeof lastNavigation | null
  secondInstanceEvents: RecordedSecondInstanceEvent[]
  features: PlaygroundFeature[]
  commands: Array<{ command: string; description: string }>
}

function playgroundSnapshot(): PlaygroundSnapshot {
  return {
    info: appInfo(),
    window: appContext ? windowSnapshot(appContext.window) : null,
    update: {
      provider: updateProviderName(),
      currentVersion: VERSION,
      checkOnStartup: updates.checkOnStartup,
      structuralUpdates: true,
      progress: latestUpdateProgress ?? null,
    },
    navigation: lastNavigation ?? null,
    secondInstanceEvents,
    features: playgroundFeatures(),
    commands: frameworkCommands(),
  }
}

function windowSnapshot(window: DesktopAppContext['window']) {
  if (!window) return null
  return {
    provider: window.provider,
    kind: window.kind,
    capabilities: window.capabilities,
    lifecycle: window.lifecycle,
    isClosed: window.isClosed(),
    attempts: window.attempts,
  }
}

interface PlaygroundFeature {
  id: string
  name: string
  status: 'active' | 'configured' | 'available' | 'build-config'
  detail: string
  endpoint?: string
  command?: string
}

function playgroundFeatures(): PlaygroundFeature[] {
  return [
    {
      id: 'fullstack-page',
      name: 'Fullstack page (HTML import, HMR in dev, AOT in prod)',
      status: 'active',
      detail: 'This page is an imported HTML route.',
      endpoint: '/',
    },
    {
      id: 'window-provider-policy',
      name: 'App-owned window provider policy with explicit fallback',
      status: 'active',
      detail: `${recommendedWindow.provider} on ${process.platform}`,
      command: '--provider webview2|webkitgtk|chromium-app|chromium-pwa|firefox-window|system-browser|android-view-intent',
    },
    {
      id: 'window-provider-facts',
      name: 'Provider matrix and window-handle facts (composable API)',
      status: 'active',
      detail: 'getWindowProviderMatrix() + returned DesktopWindowHandle',
      endpoint: '/api/providers',
    },
    {
      id: 'single-instance',
      name: 'Single instance with loopback token IPC',
      status: 'active',
      detail: 'A second launch is forwarded to the primary instance.',
      command: 'bun run second-instance',
    },
    {
      id: 'second-instance',
      name: 'Second-instance argv, cwd and PID handler',
      status: 'active',
      detail: 'Events are recorded and shown below.',
      endpoint: '/api/second-instance',
    },
    {
      id: 'updates',
      name: 'Automatic updates (check, install, restart, rollback)',
      status: 'configured',
      detail: `Active provider: ${updateProviderName()} with structuralUpdates`,
      command: 'upgrade --force',
      endpoint: '/api/update-check',
    },
    {
      id: 'notifications',
      name: 'System notifications (bridge and HTTP API)',
      status: 'active',
      detail: 'Windows WinRT toast / Linux notify-send / macOS osascript / Termux API.',
      endpoint: '/api/notify',
    },
    {
      id: 'tray',
      name: 'System tray with menu and context actions',
      status: 'configured',
      detail: process.platform === 'win32' || process.platform === 'linux'
        ? `Tray is implemented on ${process.platform}.`
        : `Tray is configured but not implemented on ${process.platform}.`,
    },
    {
      id: 'desktop-integration',
      name: 'File associations and launcher (Windows registry / Linux XDG)',
      status: 'configured',
      detail: '.bundesk-demo is associated with this app.',
      command: 'register [--default] | unregister | status',
    },
    {
      id: 'service-registration',
      name: 'Headless service registration',
      status: 'available',
      detail: 'Windows HKCU Run key / Linux systemd user unit / macOS launchd / Termux boot.',
      command: 'install-service | uninstall-service | service-status',
    },
    {
      id: 'pwa',
      name: 'PWA install, policy install and chromium-pwa provider',
      status: 'configured',
      detail: `Manifest, service worker and icons are served by the app (appId ${PWA_APP_ID}).`,
      command: 'install-pwa | install-pwa --policy | remove-pwa-policy | --provider chromium-pwa',
    },
    {
      id: 'sticky-port',
      name: 'Sticky random port (pass --port 0)',
      status: 'configured',
      detail: `Default playground origin is port ${PLAYGROUND_PORT}; --port 0 persists the last selected port.`,
      command: '--port 0',
    },
    {
      id: 'environment',
      name: 'Resolved development/production environment',
      status: 'active',
      detail: 'CLI --mode > BUNDESK_ENV > NODE_ENV > packaged-runtime default.',
      endpoint: '/api/playground',
    },
    {
      id: 'cli',
      name: 'Generated CLI help, version and custom app options',
      status: 'active',
      detail: 'Try --help, --version and --smoke.',
      command: '--help | --version | --smoke',
    },
    {
      id: 'macos-bundle',
      name: 'macOS .app packaging (Info.plist, document/URL types)',
      status: 'build-config',
      detail: 'Configures both darwin-arm64 and darwin-x64 .app bundles.',
      command: 'bun run build:macos',
    },
    {
      id: 'windows-console-modes',
      name: 'Windows console mode (detached by default)',
      status: 'build-config',
      detail: 'Set BUNDESK_EXAMPLE_CONSOLE to detached, hidden, or inherit before building.',
      command: 'BUNDESK_EXAMPLE_CONSOLE=hidden bun run build:win',
    },
    {
      id: 'cross-compile',
      name: 'Cross-compiled targets from build configs',
      status: 'build-config',
      detail: 'Linux builds Windows; macOS builds both Apple Silicon and x64 bundles.',
      command: 'bun run build:win | bun run build:macos',
    },
  ]
}

function frameworkCommands(): Array<{ command: string; description: string }> {
  return [
    { command: '--help, --version', description: 'Generated CLI help/version, including custom --smoke' },
    { command: 'serve --no-window', description: 'Start only the HTTP server' },
    { command: '--provider <provider>', description: 'Pin one concrete window provider and disable fallback' },
    { command: '--no-window, --host <host>, --port <port>, --mode <mode>', description: 'Runtime server/window overrides' },
    { command: 'register [--default] | unregister | status', description: 'Desktop integration commands' },
    { command: 'install-service | uninstall-service | service-status', description: 'User service commands' },
    { command: 'install-pwa | install-pwa --policy | remove-pwa-policy', description: 'Assisted and enterprise PWA installation' },
    { command: 'upgrade [--force]', description: 'Check for and install updates' },
    { command: '<file>', description: 'Launch, or forward the file argument to the primary instance' },
  ]
}

function updateProviderName(): 'github-release' | 'static-binary' {
  return process.env.BUNDESK_EXAMPLE_UPDATE_URL ? 'static-binary' : 'github-release'
}

function readPlaygroundPort(): number {
  const value = Number.parseInt(process.env.BUNDESK_EXAMPLE_PORT ?? '', 10)
  if (Number.isInteger(value) && value > 0 && value <= 65_535) return value
  return 43_123
}

function isSmokeInvocation(): boolean {
  return Bun.argv.slice(2).includes('--smoke')
}

function serviceWorkerSource(): string {
  return `const CACHE = 'bundesk-playground-v1'
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))
        }
        return response
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error())),
  )
})`
}

function pngResponseBody(size: number): ArrayBuffer {
  const png = playgroundPngIcon(size)
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
}

function playgroundPngIcon(size: number): Buffer {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  const border = Math.max(2, Math.floor(size / 16))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const insideRing = x >= border && x < size - border && y >= border && y < size - border
      const insideTile = insideRing && ((x >= size / 2) !== (y >= size / 2))
      const [blue, green, red, alpha] = insideTile ? [0xff, 0xff, 0xff, 0xff] : [0x36, 0x84, 0xff, 0xff]
      const offset = rowStart + 1 + x * 4
      raw[offset] = blue
      raw[offset + 1] = green
      raw[offset + 2] = red
      raw[offset + 3] = alpha
    }
  }
  return encodePng(size, size, raw)
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rgba)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

if (isSmokeInvocation()) {
  // Headless CI check: server and every smoke-safe API route, no window.
  // Exercise the same lifecycle as a real run without needing a display or
  // a writable app-data directory.
  try {
    const result = await app.start(['--no-window', '--port', '0'])
    if (result.kind === 'primary') {
      const playground = await fetch(new URL('/api/playground', result.url)).then((response) => response.json()) as {
        info: { id: string; version: string }
        features: unknown[]
      }
      const providers = await fetch(new URL('/api/providers', result.url)).then((response) => response.json()) as { matrix: unknown[] }
      console.log(`[smoke] server ok: ${result.url.href} id=${playground.info.id} env=${result.env}`)
      console.log(`[smoke] playground ok: v=${playground.info.version} features=${playground.features.length} providers=${providers.matrix.length}`)
      await result.stop()
      process.exitCode = 0
    } else {
      console.error('[smoke] unexpected start result:', result.kind)
      process.exitCode = 1
    }
  } catch (error) {
    console.error('[smoke] playground check failed:', error)
    process.exitCode = 1
  } finally {
    if (SMOKE_DATA_DIRECTORY) rmSync(SMOKE_DATA_DIRECTORY, { recursive: true, force: true })
  }
} else {
  await app.run()
}
