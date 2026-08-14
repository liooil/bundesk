/**
 * bundesk example app — showcases the framework's surface:
 *
 * - fullstack HTML page (HTML import route, HMR in dev, AOT in prod)
 * - app-owned concrete provider/fallback policy for each platform
 * - tray (Windows), notifications, single instance, desktop integration
 * - the resolved runtime environment (context.env) and `--smoke` for CI
 */
import {
  createDesktopApp,
  isTermux,
  type DesktopNotificationOptions,
  type DesktopWindowOptions,
  type WindowProviderId,
} from '../../src/index'
import page from './page/index.html'

declare const __EXAMPLE_APP_VERSION__: string

const APP_ID = 'com.bundesk.example-app'
const VERSION = typeof __EXAMPLE_APP_VERSION__ === 'string' ? __EXAMPLE_APP_VERSION__ : '0.2.0-dev'

// The window's onMessage fires before onReady has provided the context;
// route notifications through a mutable holder instead.
let notify: (options: DesktopNotificationOptions) => Promise<boolean> = () => Promise.resolve(false)
let appContextEnv: 'development' | 'production' | undefined
let appContextProvider: WindowProviderId | undefined

const recommendedWindow = platformWindowProviders()

const app = createDesktopApp({
  id: APP_ID,
  version: VERSION,
  cli: {
    name: 'example-app',
    description: 'BunDesk full-stack desktop application showcase',
    options: [{ flags: '--smoke', description: 'Run the headless CI smoke check and exit' }],
  },
  server: {
    port: 0,
    routes: {
      '/': page,
      '/api/info': () => Response.json({
        id: APP_ID,
        version: VERSION,
        env: appContextEnv ?? 'development',
        platform: process.platform,
        provider: appContextProvider ?? providerName(),
      }),
    },
  },
  window: {
    ...recommendedWindow,
    path: '/',
    title: 'BunDesk Example App',
    width: 1100,
    height: 720,
    exitWithWindow: !isTermux(),
    onMessage: (message) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'notify') {
        void notify({ title: 'BunDesk example', body: 'Notification delivered through context.notify' })
      }
    },
  },
  singleInstance: {},
  notifications: true,
  tray: {
    tooltip: 'BunDesk Example App',
    menu: [
      { label: 'Open window', onClick: (context) => { void context.launchWindow() } },
      { label: 'Notify', onClick: (context) => { void context.notify({ title: 'BunDesk example', body: 'From the tray menu' }) } },
      { label: '', separator: true },
      { label: 'Quit', onClick: (context) => void context.stop() },
    ],
  },
  desktopIntegration: {
    startMenuShortcut: { name: 'bundesk-example-app', description: 'BunDesk framework example app' },
    fileAssociations: [{
      extension: '.bundesk-demo',
      progId: 'com.bundesk.example-app.demo',
      description: 'BunDesk demo document',
    }],
  },
  onReady: async (context) => {
    notify = context.notify
    appContextEnv = context.env
    appContextProvider = context.windowProvider ?? providerName()
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

if (Bun.argv.slice(2).includes('--smoke')) {
  // Headless CI check: server only, no window. Exercises the same code path
  // as a real run without needing a display.
  const result = await app.start(['--no-window'])
  if (result.kind === 'primary') {
    const info = await fetch(new URL('/api/info', result.url)).then((response) => response.json()) as { id: string }
    console.log(`[smoke] server ok: ${result.url.href} id=${info.id} env=${result.env}`)
    await result.stop()
    process.exit(0)
  }
  console.error('[smoke] unexpected start result:', result.kind)
  process.exit(1)
}

await app.run()
