import type { DesktopAppSession, DesktopAppStartResult } from './app'

interface HotRuntimeState {
  sessions: Map<string, DesktopAppSession<unknown>>
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
  const state = globalThis.__bundeskHotRuntimeState ??= { sessions: new Map() }
  const previous = state.sessions.get(appId)
  if (previous) await previous.stop()

  const result = await start()
  if (result.kind !== 'primary') return result

  state.sessions.set(appId, result as DesktopAppSession<unknown>)
  void result.wait().finally(() => {
    if (state.sessions.get(appId) === result) state.sessions.delete(appId)
  })
  return result
}
