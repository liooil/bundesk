import type { AppWindowOptions } from './browser'
import type { SecondInstanceEvent, SingleInstanceResult } from './single-instance'
import type { UpdateCheckResult, Updater, UpdaterOptions } from './updater'
import type { WindowsIntegrationOptions, WindowsIntegrationResult, WindowsIntegrationStatus } from './windows-integration'
import { launchAppWindow } from './browser'
import { acquireSingleInstance } from './single-instance'
import { cleanupAfterUpdate, createUpdater } from './updater'
import {
  getWindowsIntegrationStatus,
  registerWindowsIntegration,
  unregisterWindowsIntegration,
} from './windows-integration'

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
  windowsIntegration?: WindowsIntegrationOptions
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
  | { kind: 'command'; command: 'register' | 'unregister' | 'status' | 'upgrade'; result: unknown }
  | { kind: 'updated'; update: UpdateCheckResult }

interface ParsedRuntimeArgs {
  appArgs: string[]
  command?: 'serve' | 'register' | 'unregister' | 'status' | 'upgrade'
  browser: boolean
  host?: string
  port?: number
  dryRun: boolean
  makeDefault: boolean
  force: boolean
  afterUpdate: boolean
  waitForPid?: number
}

export class DesktopApp<WebSocketData = undefined, Routes extends string = string> {
  readonly options: DesktopAppOptions<WebSocketData, Routes>

  constructor(options: DesktopAppOptions<WebSocketData, Routes>) {
    this.options = options
  }

  async start(args: string[] = Bun.argv.slice(2)): Promise<DesktopAppStartResult<WebSocketData>> {
    const parsed = parseRuntimeArgs(args)
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
      await this.options.onSecondInstance?.(event, context)
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

    const serverOptions = {
      ...this.options.server,
      hostname: parsed.host ?? ('hostname' in this.options.server ? this.options.server.hostname : undefined),
      port: parsed.port ?? ('port' in this.options.server ? this.options.server.port : undefined),
    } as Bun.Serve.Options<WebSocketData, Routes>
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
      if (appWindow && appWindow.exitCode === null) appWindow.kill()
      await server.stop(true)
      if (instance?.kind === 'primary') await instance.release()
    }
    const wait = async () => {
      const signal = waitForTerminationSignal()
      const shouldExitWithWindow = windowOptions?.exitWithWindow ?? true
      if (appWindow && shouldExitWithWindow) {
        await Promise.race([appWindow.exited.then(() => undefined), signal.promise])
      } else {
        await signal.promise
      }
      signal.dispose()
      await stop()
    }

    const context: DesktopAppSession<WebSocketData> = {
      kind: 'primary',
      server,
      url: appUrl,
      window: appWindow,
      updater,
      launchWindow: launch,
      stop,
      wait,
    }
    contextResolve?.(context)

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
    if (result.kind === 'command') console.log(JSON.stringify(result.result, null, 2))
    return result
  }

  private async runIntegrationCommand(
    parsed: ParsedRuntimeArgs,
  ): Promise<DesktopAppStartResult<WebSocketData> | null> {
    if (!parsed.command || parsed.command === 'serve' || parsed.command === 'upgrade') return null
    const integration = this.options.windowsIntegration
    if (!integration) throw new Error(`${parsed.command} requires windowsIntegration configuration`)

    let result: WindowsIntegrationResult | WindowsIntegrationStatus
    if (parsed.command === 'register') {
      result = await registerWindowsIntegration(integration, {
        dryRun: parsed.dryRun,
        makeDefault: parsed.makeDefault,
      })
    } else if (parsed.command === 'unregister') {
      result = await unregisterWindowsIntegration(integration, { dryRun: parsed.dryRun })
    } else {
      result = await getWindowsIntegrationStatus(integration)
    }
    return { kind: 'command', command: parsed.command, result }
  }
}

export function createDesktopApp<WebSocketData = undefined, Routes extends string = string>(
  options: DesktopAppOptions<WebSocketData, Routes>,
): DesktopApp<WebSocketData, Routes> {
  return new DesktopApp(options)
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
    if (index === 0 && ['serve', 'register', 'unregister', 'status', 'upgrade'].includes(arg)) {
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

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value ?? ''}`)
  return port
}

function waitForTerminationSignal(): { promise: Promise<void>; dispose(): void } {
  let resolveSignal: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolveSignal = resolve
  })
  const handler = () => resolveSignal?.()
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
  return {
    promise,
    dispose() {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    },
  }
}
