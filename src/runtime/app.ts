import type { AppWindowOptions } from './browser'
import type { SecondInstanceEvent, SingleInstanceResult } from './single-instance'
import type { UpdateCheckResult, Updater, UpdaterOptions } from './updater'
import type { WindowsIntegrationOptions, WindowsIntegrationResult, WindowsIntegrationStatus } from './windows-integration'
import type { ActionRegistry, DesktopActionOptions } from './actions'
import type { LinuxIntegrationOptions } from './linux-integration'
import type { WebViewWindow } from './webview2'
import { join } from 'node:path'
import { launchAppWindow } from './browser'
import { getAppDataDirectory } from './paths'
import { createWebViewWindow } from './webview2'
import { createWebKitWindow } from './webkit'
import { acquireSingleInstance } from './single-instance'
import { cleanupAfterUpdate, createUpdater } from './updater'
import {
  actionsApiPath,
  actionsApiRoutes,
  actionsConsolePath,
  actionsConsoleResponse,
  createActionRegistry,
} from './actions'
import {
  getLinuxIntegrationStatus,
  registerLinuxIntegration,
  unregisterLinuxIntegration,
} from './linux-integration'
import { getServiceStatus, installService, uninstallService } from './service-integration'
import { notifySystem, type DesktopNotificationOptions } from './notifications'
import { createTray, type DesktopTrayOptions, type TrayController } from './tray'
import { isTermux } from './platform'
import { resolveAppEnvironment, type AppEnvironment } from './environment'
import {
  getWindowsIntegrationStatus,
  registerWindowsIntegration,
  unregisterWindowsIntegration,
} from './windows-integration'

export type DesktopIntegrationOptions = WindowsIntegrationOptions

export type DesktopAppWindow = Bun.Subprocess | WebViewWindow

export interface DesktopWindowOptions extends Omit<AppWindowOptions, 'appId' | 'url'> {
  path?: string
  exitWithWindow?: boolean
  /** 'browser' (default) launches Chromium App Mode or an isolated Firefox window; 'webview' uses the in-process WebView2 window (Windows only); 'webkit' uses the in-process WebKitGTK window (Linux only). */
  provider?: 'browser' | 'webview' | 'webkit'
  /** In-process providers ('webview'/'webkit'): initial window size and title. */
  width?: number
  height?: number
  title?: string
  /** In-process providers: page-initiated messages (window.chrome.webview.postMessage). */
  onMessage?: (message: unknown) => void
  /** In-process providers: navigation completion. */
  onNavigateCompleted?: (info: { success: boolean; errorStatus: number }) => void
}

/** User-facing CLI choice; `webview` maps to WebView2 on Windows and WebKitGTK on Linux. */
export type CliWindowProvider = 'browser' | 'webview'

export interface DesktopUpdateOptions extends UpdaterOptions {
  checkOnStartup?: boolean
}

export interface DesktopCliHelpOption {
  flags: string
  description: string
}

export interface DesktopCliOptions {
  /** Name displayed by --help and --version; defaults to the application id. */
  name?: string
  description?: string
  /** Application-specific options to append to the generated help. */
  options?: DesktopCliHelpOption[]
}

export interface DesktopAppOptions<WebSocketData = undefined, Routes extends string = string> {
  id: string
  version?: string
  cli?: DesktopCliOptions
  server: Bun.Serve.Options<WebSocketData, Routes>
  window?: DesktopWindowOptions | false
  singleInstance?: false | {
    dataDirectory?: string
    timeoutMs?: number
  }
  updates?: DesktopUpdateOptions
  /**
   * One functionality, three layers. Each action is reachable as
   * `my-app <name> --arg value`, `POST /api/actions/<name>`, and the
   * generated console at `/__bundesk/actions`.
   */
  actions?: DesktopActionOptions<WebSocketData>[]
  /** File associations and launcher entry; dispatched to the current platform (Windows registry / Linux XDG). */
  desktopIntegration?: DesktopIntegrationOptions
  /** System tray icon with menu. Windows is implemented; see src/runtime/tray.ts for platform status. */
  tray?: DesktopTrayOptions<WebSocketData>
  /**
   * Enable system notifications (`context.notify`). Windows delivers WinRT
   * toasts via a PowerShell bridge; `{ aumid }` attributes the toast to your
   * AppUserModelID (a Start Menu shortcut carrying the AUMID must exist).
   */
  notifications?: boolean | { aumid?: string }
  onReady?: (context: DesktopAppContext<WebSocketData>) => void | Promise<void>
  onSecondInstance?: (
    event: SecondInstanceEvent,
    context: DesktopAppContext<WebSocketData>,
  ) => void | Promise<void>
}

export interface DesktopAppContext<WebSocketData = undefined> {
  server: Bun.Server<WebSocketData>
  url: URL
  /** Resolved app environment ('development' | 'production'); CLI > BUNDESK_ENV > NODE_ENV > default. */
  env: AppEnvironment
  window: DesktopAppWindow | null
  /** Effective provider after applying a CLI --browser/--webview override. */
  windowProvider: NonNullable<DesktopWindowOptions['provider']> | null
  updater: Updater | null
  actions: ActionRegistry
  tray: TrayController<WebSocketData> | null
  notify(options: DesktopNotificationOptions): Promise<boolean>
  launchWindow(options?: Partial<DesktopWindowOptions>): Promise<DesktopAppWindow | null>
  stop(): Promise<void>
}

export interface DesktopAppSession<WebSocketData = undefined> extends DesktopAppContext<WebSocketData> {
  kind: 'primary'
  wait(): Promise<void>
}

export type DesktopAppStartResult<WebSocketData = undefined> =
  | DesktopAppSession<WebSocketData>
  | SingleInstanceResult & { kind: 'secondary' }
  | {
    kind: 'command'
    command: 'help' | 'version' | 'register' | 'unregister' | 'status' | 'upgrade' | 'install-service' | 'uninstall-service' | 'service-status'
    result: unknown
  }
  | { kind: 'action'; action: string; result: unknown }
  | { kind: 'updated'; update: UpdateCheckResult }

interface ParsedRuntimeArgs {
  appArgs: string[]
  command?: 'serve' | 'register' | 'unregister' | 'status' | 'upgrade' | 'install-service' | 'uninstall-service' | 'service-status'
  browser: boolean
  windowProvider?: CliWindowProvider
  host?: string
  port?: number
  dryRun: boolean
  makeDefault: boolean
  force: boolean
  afterUpdate: boolean
  waitForPid?: number
}

type IntegrationResult = WindowsIntegrationResult | WindowsIntegrationStatus
type IntegrationStatus = WindowsIntegrationStatus

export class DesktopApp<WebSocketData = undefined, Routes extends string = string> {
  readonly options: DesktopAppOptions<WebSocketData, Routes>

  constructor(options: DesktopAppOptions<WebSocketData, Routes>) {
    this.options = options
  }

  async start(args: string[] = Bun.argv.slice(2)): Promise<DesktopAppStartResult<WebSocketData>> {
    let currentContext: DesktopAppContext<WebSocketData> | undefined
    const registry = createActionRegistry(this.options.actions ?? [], () => {
      if (!currentContext) throw new Error('Actions were invoked before the app context was ready')
      return currentContext
    })

    if (args.includes('--help') || args.includes('-h')) {
      return { kind: 'command', command: 'help', result: renderCliHelp(this.options, registry.list()) }
    }
    if (args.includes('--version') || args.includes('-V')) {
      const name = this.options.cli?.name ?? this.options.id
      return { kind: 'command', command: 'version', result: `${name} ${this.options.version ?? 'unknown'}` }
    }

    const parsed = registry.has(args[0] ?? '') ? parseActionModeArgs(args) : parseRuntimeArgs(args)
    const env = resolveAppEnvironment(args)
    const cliWindowProvider = parsed.windowProvider && parsed.browser && parsed.command !== 'serve' && this.options.window !== false
      ? resolveCliWindowProvider(parsed.windowProvider)
      : undefined
    if (parsed.afterUpdate) {
      await cleanupAfterUpdate({ waitForPid: parsed.waitForPid })
    }

    const commandResult = await this.runIntegrationCommand(parsed)
    if (commandResult) return commandResult

    let contextResolve: ((context: DesktopAppContext<WebSocketData>) => void) | undefined
    const contextReady = new Promise<DesktopAppContext<WebSocketData>>((resolve) => {
      contextResolve = resolve
    })
    const updater = this.options.updates
      ? createUpdater({
          ...this.options.updates,
          currentVersion: this.options.updates.currentVersion ?? this.options.version,
          restartArgs: this.options.updates.restartArgs ?? parsed.appArgs,
        })
      : null

    const onSecondInstance = async (event: SecondInstanceEvent) => {
      const context = await contextReady
      if (event.argv[0] === 'upgrade' && updater) {
        const checked = await updater.check(undefined, event.argv.includes('--force'))
        if (checked.update) {
          await updater.installAndRestart(checked.update)
          await context.stop()
        }
        return
      }
      if (registry.has(event.argv[0] ?? '')) {
        const outcome = await registry.callFromCli(event.argv)
        return outcome?.result
      }
      return this.options.onSecondInstance?.(event, context)
    }

    let instance: SingleInstanceResult | null = null
    if (this.options.singleInstance !== false) {
      instance = await acquireSingleInstance({
        appId: this.options.id,
        dataDirectory: this.options.singleInstance?.dataDirectory,
        timeoutMs: this.options.singleInstance?.timeoutMs,
        argv: parsed.command === 'upgrade'
          ? ['upgrade', ...(parsed.force ? ['--force'] : []), ...parsed.appArgs]
          : parsed.appArgs,
        cwd: process.cwd(),
        onSecondInstance,
      })
      if (instance.kind === 'secondary') {
        // secondary 进程是"转发后即退出"，没有任何窗口/服务；不给用户提示
        // 会被当成"启动没反应"。转发结果与僵尸持有者两种场景分开说明。
        if (instance.accepted) {
          console.log(`检测到 ${this.options.id} 已在运行，启动参数已转发，本进程退出。`)
        } else {
          console.warn(
            `检测到 ${this.options.id} 实例在运行，但启动参数转发未得到确认。` +
            '若该实例无响应（如残留的僵死进程），请结束其进程后重试。',
          )
        }
        return instance
      }
    }

    if (parsed.command === 'upgrade') {
      if (!updater) {
        await instance?.release()
        throw new Error('The upgrade command requires updates configuration')
      }
      const checked = await updater.check(undefined, parsed.force)
      if (checked.update) await updater.installAndRestart(checked.update)
      await instance?.release()
      return { kind: 'command', command: 'upgrade', result: checked }
    }

    if (updater && this.options.updates?.checkOnStartup) {
      const checked = await updater.check()
      if (checked.update) {
        await updater.installAndRestart(checked.update)
        await instance?.release()
        return { kind: 'updated', update: checked }
      }
    }

    const serverOptions = withActionRoutes({
      ...this.options.server,
      // Mode fills the default only; an explicit user setting always wins.
      development: this.options.server.development ?? env === 'development',
      hostname: parsed.host ?? ('hostname' in this.options.server ? this.options.server.hostname : undefined),
      port: parsed.port ?? ('port' in this.options.server ? this.options.server.port : undefined),
    } as Bun.Serve.Options<WebSocketData, Routes>, registry)
    const server = Bun.serve(serverOptions)
    const protocol = 'tls' in serverOptions && serverOptions.tls ? 'https' : 'http'
    const configuredHost = 'hostname' in serverOptions ? serverOptions.hostname : undefined
    const urlHost = !configuredHost || configuredHost === '0.0.0.0'
      ? '127.0.0.1'
      : configuredHost === '::'
        ? '[::1]'
        : configuredHost
    const appUrl = new URL(`${protocol}://${urlHost}:${server.port}`)
    const windowOptions = this.options.window === false ? null : this.options.window ?? {}
    if (windowOptions?.path) appUrl.pathname = windowOptions.path.startsWith('/') ? windowOptions.path : `/${windowOptions.path}`

    let appWindow: DesktopAppWindow | null = null
    let stopped = false
    let stopResolve: (() => void) | undefined
    const stoppedPromise = new Promise<void>((resolve) => {
      stopResolve = resolve
    })
    const launch = async (overrides: Partial<DesktopWindowOptions> = {}) => {
      if (!windowOptions) return null
      const merged = {
        ...windowOptions,
        ...overrides,
        ...(cliWindowProvider ? { provider: cliWindowProvider } : {}),
      }
      const windowUrl = new URL(appUrl)
      if (merged.path) windowUrl.pathname = merged.path.startsWith('/') ? merged.path : `/${merged.path}`
      if (merged.provider === 'webview') {
        if (process.platform !== 'win32') {
          throw new Error('The webview window provider is only available on Windows')
        }
        appWindow = await createWebViewWindow({
          url: String(windowUrl),
          title: merged.title,
          width: merged.width,
          height: merged.height,
          userDataFolder: merged.userDataDir ?? join(getAppDataDirectory(this.options.id), 'WebView2'),
          onMessage: merged.onMessage,
          onNavigateCompleted: merged.onNavigateCompleted,
        })
      } else if (merged.provider === 'webkit') {
        if (process.platform !== 'linux') {
          throw new Error('The webkit window provider is only available on Linux')
        }
        appWindow = await createWebKitWindow({
          url: String(windowUrl),
          title: merged.title,
          width: merged.width,
          height: merged.height,
          onMessage: merged.onMessage,
          onNavigateCompleted: merged.onNavigateCompleted,
        })
      } else {
        appWindow = await launchAppWindow({
          ...merged,
          appId: this.options.id,
          url: windowUrl,
        })
      }
      return appWindow
    }
    const stop = async () => {
      if (stopped) return
      stopped = true
      stopResolve?.()
      tray?.destroy()
      if (appWindow && appWindow.exitCode === null) appWindow.kill()
      await server.stop(true)
      if (instance?.kind === 'primary') await instance.release()
    }
    const wait = async () => {
      const signal = waitForTerminationSignal()
      // With a tray, closing the window keeps the app alive in the tray unless
      // exitWithWindow is explicitly enabled.
      const shouldExitWithWindow = (windowOptions?.exitWithWindow ?? !this.options.tray) && !isTermux()
      if (appWindow && shouldExitWithWindow) {
        await Promise.race([appWindow.exited.then(() => undefined), signal.promise, stoppedPromise])
      } else {
        await Promise.race([signal.promise, stoppedPromise])
      }
      signal.dispose()
      await stop()
    }

    let tray: TrayController<WebSocketData> | null = null
    const notificationsAumid = typeof this.options.notifications === 'object' ? this.options.notifications.aumid : undefined
    const context: DesktopAppSession<WebSocketData> = {
      kind: 'primary',
      server,
      url: appUrl,
      env,
      window: appWindow,
      windowProvider: windowOptions ? cliWindowProvider ?? windowOptions.provider ?? 'browser' : null,
      updater,
      actions: registry,
      tray,
      notify: (notification) => notifySystem(notification, { aumid: notificationsAumid }),
      launchWindow: launch,
      stop,
      wait,
    }
    currentContext = context
    contextResolve?.(context)

    if (registry.has(parsed.appArgs[0] ?? '')) {
      const actionName = parsed.appArgs[0]!
      let result: unknown
      try {
        result = (await registry.callFromCli(parsed.appArgs))?.result
      } catch (error) {
        await stop()
        throw error
      }
      await stop()
      return { kind: 'action', action: actionName, result }
    }

    if (this.options.tray) {
      const trayOptions = this.options.tray
      tray = await createTray<WebSocketData>(trayOptions, {
        onActivate: () => {
          void (async () => {
            try {
              if (trayOptions.onActivate) {
                await trayOptions.onActivate(context)
              } else if (!appWindow || appWindow.exitCode !== null) {
                await launch()
              }
            } catch (error) {
              console.error('[BunDesk] tray activate failed:', error)
            }
          })()
        },
        onMenuClick: (item) => {
          void (async () => {
            try {
              await item.onClick?.(context)
            } catch (error) {
              console.error('[BunDesk] tray menu item failed:', error)
            }
          })()
        },
      })
      context.tray = tray
    }

    if (windowOptions && parsed.browser && parsed.command !== 'serve') {
      context.window = await launch()
    }
    try {
      await this.options.onReady?.(context)
    } catch (error) {
      await stop()
      throw error
    }
    return context
  }

  async run(args: string[] = Bun.argv.slice(2)): Promise<DesktopAppStartResult<WebSocketData>> {
    const result = await this.start(args)
    if (result.kind === 'primary') await result.wait()
    if (result.kind === 'command' || result.kind === 'action') {
      console.log(
        result.kind === 'command' && (result.command === 'help' || result.command === 'version')
          ? String(result.result)
          : JSON.stringify(result.result, null, 2),
      )
    }
    if (result.kind === 'secondary' && result.result !== undefined) {
      console.log(JSON.stringify(result.result, null, 2))
    }
    return result
  }

  private async runIntegrationCommand(
    parsed: ParsedRuntimeArgs,
  ): Promise<DesktopAppStartResult<WebSocketData> | null> {
    if (!parsed.command || parsed.command === 'serve' || parsed.command === 'upgrade') return null

    if (parsed.command === 'install-service' || parsed.command === 'uninstall-service' || parsed.command === 'service-status') {
      const serviceOptions = { appId: this.options.id }
      const result = parsed.command === 'install-service'
        ? await installService(serviceOptions, { dryRun: parsed.dryRun })
        : parsed.command === 'uninstall-service'
          ? await uninstallService(serviceOptions, { dryRun: parsed.dryRun })
          : await getServiceStatus(serviceOptions)
      return { kind: 'command', command: parsed.command, result }
    }

    const integration = this.options.desktopIntegration
    if (!integration) throw new Error(`${parsed.command} requires desktopIntegration configuration`)

    const settings = { dryRun: parsed.dryRun, makeDefault: parsed.makeDefault }
    let result: IntegrationResult
    if (process.platform === 'win32') {
      result = parsed.command === 'register'
        ? await registerWindowsIntegration(integration, settings)
        : parsed.command === 'unregister'
          ? await unregisterWindowsIntegration(integration, { dryRun: parsed.dryRun })
          : await getWindowsIntegrationStatus(integration)
    } else if (process.platform === 'linux') {
      const linuxOptions: LinuxIntegrationOptions = { ...integration, appId: this.options.id }
      result = parsed.command === 'register'
        ? await registerLinuxIntegration(linuxOptions, settings)
        : parsed.command === 'unregister'
          ? await unregisterLinuxIntegration(linuxOptions, { dryRun: parsed.dryRun })
          : await getLinuxIntegrationStatus(linuxOptions)
    } else if (parsed.command === 'status') {
      result = unsupportedIntegrationStatus()
    } else {
      result = unsupportedIntegrationResult()
    }
    return { kind: 'command', command: parsed.command, result }
  }
}

function renderCliHelp<WebSocketData, Routes extends string>(
  options: DesktopAppOptions<WebSocketData, Routes>,
  actions: ReturnType<ActionRegistry['list']>,
): string {
  const name = options.cli?.name ?? options.id
  const lines = [
    ...(options.cli?.description ? [options.cli.description, ''] : []),
    `Usage: ${name} [command] [options]`,
    ...(actions.length > 0 ? [`       ${name} <action> [arguments]`] : []),
    '',
    'Commands:',
    '  serve                         Run the HTTP server without opening a window',
  ]

  if (options.desktopIntegration) {
    lines.push(
      '  register [--default]         Register file associations and the application launcher',
      '  unregister                   Remove desktop integration',
      '  status                       Show desktop integration status',
    )
  }
  lines.push(
    '  install-service              Install the headless user service',
    '  uninstall-service            Remove the headless user service',
    '  service-status               Show user service status',
  )
  if (options.updates) lines.push('  upgrade [--force]              Check for and install an update')

  if (actions.length > 0) {
    lines.push('', 'Actions:')
    for (const action of actions) {
      const args = action.args.map((arg) => {
        const flag = `--${arg.name}${arg.type === 'boolean' ? '' : ` <${arg.type}>`}`
        return arg.required ? flag : `[${flag}]`
      }).join(' ')
      lines.push(`  ${action.name}${args ? ` ${args}` : ''}${action.description ? `\n      ${action.description}` : ''}`)
    }
  }

  lines.push(
    '',
    'Options:',
    '  -h, --help                   Show this help and exit',
    '  -V, --version                Show the application version and exit',
    '      --browser                Open with the system Chromium browser',
    '      --webview                Open with the platform-native embedded WebView',
    '      --provider <provider>    Select browser or webview',
    '      --no-browser             Run without opening a desktop window',
    '  -H, --host <hostname>        Override the server hostname',
    '  -p, --port <port>            Override the server port (0-65535)',
    '      --mode <mode>            Set development or production mode',
    '      --dry-run                Preview integration/service changes',
  )
  for (const option of options.cli?.options ?? []) {
    lines.push(`  ${option.flags.padEnd(30)}${option.description}`)
  }
  return lines.join('\n')
}

export function createDesktopApp<WebSocketData = undefined, Routes extends string = string>(
  options: DesktopAppOptions<WebSocketData, Routes>,
): DesktopApp<WebSocketData, Routes> {
  return new DesktopApp(options)
}

export function resolveCliWindowProvider(
  provider: CliWindowProvider,
  platform: NodeJS.Platform = process.platform,
): NonNullable<DesktopWindowOptions['provider']> {
  if (provider === 'browser') return 'browser'
  if (platform === 'win32') return 'webview'
  if (platform === 'linux' && !isTermux()) return 'webkit'
  throw new Error(`The webview provider is not available on ${platform}`)
}

function withActionRoutes<WebSocketData, Routes extends string>(
  options: Bun.Serve.Options<WebSocketData, Routes>,
  registry: ActionRegistry,
): Bun.Serve.Options<WebSocketData, Routes> {
  if (registry.list().length === 0) return options
  const userRoutes = options.routes
  if (!userRoutes || typeof userRoutes !== 'object') return options
  const reserved = [actionsApiPath, `${actionsApiPath}/:name`, actionsConsolePath]
  if (reserved.some((path) => path in userRoutes)) return options
  return {
    ...options,
    routes: {
      ...userRoutes,
      ...actionsApiRoutes(registry),
      [actionsConsolePath]: actionsConsoleResponse,
    } as unknown as Bun.Serve.Routes<WebSocketData, Routes>,
  }
}

function unsupportedIntegrationResult(): WindowsIntegrationResult {
  return {
    ok: false,
    changed: false,
    details: [
      'Desktop integration is only supported on Windows (registry) and Linux (XDG); ' +
        'macOS file associations are declared in the .app bundle at build time',
    ],
  }
}

function unsupportedIntegrationStatus(): IntegrationStatus {
  return {
    supported: false,
    executablePath: process.execPath,
    fileAssociations: [],
    startMenuShortcut: { configured: false, path: null, exists: false },
  }
}

function parseRuntimeArgs(args: string[]): ParsedRuntimeArgs {
  const parsed: ParsedRuntimeArgs = {
    appArgs: [],
    browser: true,
    dryRun: false,
    makeDefault: false,
    force: false,
    afterUpdate: false,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (index === 0 && ['serve', 'register', 'unregister', 'status', 'upgrade', 'install-service', 'uninstall-service', 'service-status'].includes(arg)) {
      parsed.command = arg as ParsedRuntimeArgs['command']
    } else if (arg === '--browser') {
      parsed.browser = true
      parsed.windowProvider = 'browser'
    } else if (arg === '--webview') {
      parsed.browser = true
      parsed.windowProvider = 'webview'
    } else if (arg === '--provider') {
      parsed.browser = true
      parsed.windowProvider = parseCliWindowProvider(args[++index], arg)
    } else if (arg.startsWith('--provider=')) {
      parsed.browser = true
      parsed.windowProvider = parseCliWindowProvider(arg.slice(arg.indexOf('=') + 1), '--provider')
    } else if (arg === '--no-browser') {
      parsed.browser = false
    } else if (arg === '--dry-run') {
      parsed.dryRun = true
    } else if (arg === '--default') {
      parsed.makeDefault = true
    } else if (arg === '--force') {
      parsed.force = true
    } else if (arg === '--bun-desktop-after-update') {
      parsed.afterUpdate = true
    } else if (arg.startsWith('--bun-desktop-wait-for-pid=')) {
      parsed.waitForPid = Number.parseInt(arg.slice(arg.indexOf('=') + 1), 10)
    } else if (arg === '--port' || arg === '-p') {
      parsed.port = parsePort(args[++index])
    } else if (arg.startsWith('--port=')) {
      parsed.port = parsePort(arg.slice(arg.indexOf('=') + 1))
    } else if (arg === '--host' || arg === '-H') {
      parsed.host = args[++index]
      if (!parsed.host) throw new Error(`${arg} requires a hostname`)
    } else if (arg.startsWith('--host=')) {
      parsed.host = arg.slice(arg.indexOf('=') + 1)
    } else if (index !== 0 || parsed.command === undefined) {
      parsed.appArgs.push(arg)
    }
  }
  return parsed
}

function parseCliWindowProvider(value: string | undefined, flag: string): CliWindowProvider {
  if (value === 'browser' || value === 'webview') return value
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires browser or webview`)
  throw new Error(`Invalid window provider: ${value} (expected browser or webview)`)
}

/**
 * An action invocation owns the whole argv line: framework flags like
 * `--no-browser` become action arguments. Only the update-restart markers are
 * still consumed, because they are appended by `installAndRestart`.
 */
function parseActionModeArgs(args: string[]): ParsedRuntimeArgs {
  const parsed: ParsedRuntimeArgs = {
    appArgs: [],
    browser: false,
    dryRun: false,
    makeDefault: false,
    force: false,
    afterUpdate: false,
  }
  for (const arg of args) {
    if (arg === '--bun-desktop-after-update') {
      parsed.afterUpdate = true
    } else if (arg.startsWith('--bun-desktop-wait-for-pid=')) {
      parsed.waitForPid = Number.parseInt(arg.slice(arg.indexOf('=') + 1), 10)
    } else {
      parsed.appArgs.push(arg)
    }
  }
  return parsed
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return port
}

function waitForTerminationSignal(): { promise: Promise<void>; dispose(): void } {
  const controller = new AbortController()
  const promise = new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        controller.abort()
        resolve()
      })
    }
  })
  return {
    promise,
    dispose() {
      controller.abort()
    },
  }
}
