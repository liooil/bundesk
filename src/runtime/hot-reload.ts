import type { DesktopAppSession, DesktopAppStartResult } from './app'

interface HotRuntimeState {
  sessions: Map<string, DesktopAppSession<unknown>>
  signalHandlersInstalled?: boolean
  terminating?: boolean
}

declare global {
  // Bun preserves globalThis across `--hot` module graph evaluations.
  var __bundeskHotRuntimeState: HotRuntimeState | undefined
}

export function isBunHotMode(): boolean {
  return process.execArgv.includes('--hot') || process.env.BUN_OPTIONS?.split(/\s+/).includes('--hot') === true
}

export async function replaceHotRun<WebSocketData>(
  appId: string,
  start: () => Promise<DesktopAppStartResult<WebSocketData>>,
): Promise<DesktopAppStartResult<WebSocketData>> {
  const state: HotRuntimeState = globalThis.__bundeskHotRuntimeState ??= { sessions: new Map() }
  installHotTerminationHandlers(state)
  const previous = state.sessions.get(appId)
  if (previous) {
    // Its wait() completion belongs to replacement, not application exit.
    state.sessions.delete(appId)
    await previous.stop()
  }

  const result = await start()
  if (result.kind !== 'primary') return result

  state.sessions.set(appId, result as DesktopAppSession<unknown>)
  void result.wait({ handleSignals: false }).finally(() => {
    if (state.sessions.get(appId) !== result) return
    state.sessions.delete(appId)
    // `bun --hot` keeps its watcher alive after the application lifecycle has
    // ended. Preserve exitWithWindow/stop semantics for the current session.
    if (state.sessions.size === 0 && !state.terminating) process.exit(0)
  })
  return result
}

function installHotTerminationHandlers(state: HotRuntimeState): void {
  if (state.signalHandlersInstalled) return
  state.signalHandlersInstalled = true
  process.once('SIGINT', () => terminateHotRuntime(state, 130))
  process.once('SIGTERM', () => terminateHotRuntime(state, 143))
}

function terminateHotRuntime(state: HotRuntimeState, exitCode: number): void {
  if (state.terminating) return
  state.terminating = true
  const sessions = [...state.sessions.values()]
  state.sessions.clear()
  void Promise.allSettled(sessions.map((session) => session.stop())).finally(() => {
    process.exit(exitCode)
  })
}
