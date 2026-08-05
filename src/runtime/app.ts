import type { AppWindowOptions } from './browser'
import type { SecondInstanceEvent, SingleInstanceResult } from './single-instance'
import type { UpdateCheckResult, Updater, UpdaterOptions } from './updater'
import type { WindowsIntegrationOptions, WindowsIntegrationResult, WindowsIntegrationStatus } from './windows-integration'
import type { ActionRegistry, DesktopActionOptions } from './actions'
import type { LinuxIntegrationOptions } from './linux-integration'
import { launchAppWindow } from './browser'
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
import { createTray, type DesktopTrayOptions, type TrayController } from './tray'
import { isTermux } from './platform'
import {
  getWindowsIntegrationStatus,
  registerWindowsIntegration,
  unregisterWindowsIntegration,
} from './windows-integration'

export type DesktopIntegrationOptions = WindowsIntegrationOptions

export interface DesktopWindowOptions extends Omit<AppWindowOptions, 'appId' | 'url'> {
  path?: string
  exitWithWindow?: boolean
}

export interface DesktopUpdateOptions extends UpdaterOptions {
  checkOnStartup?: boolean
}

export interface DesktopAppOptions<WebSocketData = undefined, Routes extends string = string> {
  id: string
  version?: string
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
  onReady?: (context: DesktopAppContext<WebSocketData>) => void | Promise<void>
  onSecondInstance?: (
    event: SecondInstanceEvent,
    context: DesktopAppContext<WebSocketData>,
  ) => void | Promise<void>
}

export interface DesktopAppContext<WebSocketData = undefined> {
  server: Bun.Server<WebSocketData>
  url: URL
  window: Bun.Subprocess | null
  updater: Updater | null
  actions: ActionRegistry
  tray: TrayController<WebSocketData> | null
  launchWindow(options?: Partial<DesktopWindowOptions>): Promise<Bun.Subprocess | null>
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
    command: 'register' | 'unregister' | 'status' | 'upgrade' | 'install-service' | 'uninstall-service' | 'service-status'
    result: unknown
  }
  | { kind: 'action'; action: string; result: unknown }
  | { kind: 'updated'; update: UpdateCheckResult }

interface ParsedRuntimeArgs {
  appArgs: string[]
  command?: 'serve' | 'register' | 'unregister' | 'status' | 'upgrade' | 'install-service' | 'uninstall-service' | 'service-status'
  browser: boolean
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

    const parsed = registry.has(args[0] ?? '') ? parseActionModeArgs(args) : parseRuntimeArgs(args)
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
      if (instance.kind === 'secondary') return instance
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

    let appWindow: Bun.Subprocess | null = null
    let stopped = false
    let stopResolve: (() => void) | undefined
    const stoppedPromise = new Promise<void>((resolve) => {
      stopResolve = resolve
    })
    const launch = async (overrides: Partial<DesktopWindowOptions> = {}) => {
      if (!windowOptions) return null
      const merged = { ...windowOptions, ...overrides }
      const windowUrl = new URL(appUrl)
      if (merged.path) windowUrl.pathname = merged.path.startsWith('/') ? merged.path : `/${merged.path}`
      appWindow = await launchAppWindow({
        ...merged,
        appId: this.options.id,
        url: windowUrl,
      })
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
    const context: DesktopAppSession<WebSocketData> = {
      kind: 'primary',
      server,
      url: appUrl,
      window: appWindow,
      updater,
      actions: registry,
      tray,
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
      tray = createTray<WebSocketData>(trayOptions, {
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
      console.log(JSON.stringify(result.result, null, 2))
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

export function createDesktopApp<WebSocketData = undefined, Routes extends string = string>(
  options: DesktopAppOptions<WebSocketData, Routes>,
): DesktopApp<WebSocketData, Routes> {
  return new DesktopApp(options)
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
