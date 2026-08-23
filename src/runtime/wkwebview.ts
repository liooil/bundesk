import { cc, CString, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { materializeNativePath } from './native-assets'
import shimPath from '../wkwebview-shim.c' with { type: 'file' }

/**
 * Native macOS WKWebView window provider.
 *
 * The header-free C shim is compiled by Bun at runtime and talks to AppKit,
 * WebKit and the Objective-C runtime already included with macOS. No browser
 * installation, Xcode headers, or separately distributed native helper is
 * required.
 */

export interface WKWebViewWindowOptions {
  url: string
  title?: string
  width?: number
  height?: number
  /** Accepted for API parity; public WKWebView APIs do not expose an arbitrary profile path. */
  userDataDir?: string
  onMessage?: (message: unknown) => void
  onClose?: () => void
  onNavigateCompleted?: (info: { success: boolean; errorStatus: number }) => void
}

export interface WKWebViewWindow {
  /** Null while the window is open; set on close (Bun.Subprocess-compatible). */
  readonly exitCode: number | null
  /** Resolves when the native window is closed (Bun.Subprocess-compatible). */
  exited: Promise<void>
  /** Close the native window (Bun.Subprocess-compatible alias). */
  kill(): void
  close(): void
  navigate(url: string): void
  postMessage(value: unknown): void
  executeScript(script: string): Promise<unknown>
}

interface ShimSymbols {
  macwk_set_handlers(msg: number, nav: number, exec: number, close: number): void
  macwk_init(): number
  macwk_diag(): number
  macwk_create_window(title: number, url: number, width: number, height: number): number
  macwk_navigate(url: number): void
  macwk_run_js(script: number): void
  macwk_pump(): void
  macwk_close(): void
}

interface ScriptResult {
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

let shimPromise: Promise<ShimSymbols> | null = null
let pump: Timer | undefined

function utf8(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf8')
}

async function loadShim(): Promise<ShimSymbols> {
  if (!shimPromise) {
    shimPromise = (async () => {
      const sourcePath = await materializeNativePath(shimPath, `bundesk-wkwebview-shim-${process.pid}.c`)
      const library = cc({
        source: sourcePath,
        library: ['objc'],
        symbols: {
          macwk_set_handlers: { returns: 'void', args: ['ptr', 'ptr', 'ptr', 'ptr'] },
          macwk_init: { returns: 'i32', args: [] },
          macwk_diag: { returns: 'i32', args: [] },
          macwk_create_window: { returns: 'i32', args: ['ptr', 'ptr', 'i32', 'i32'] },
          macwk_navigate: { returns: 'void', args: ['ptr'] },
          macwk_run_js: { returns: 'void', args: ['ptr'] },
          macwk_pump: { returns: 'void', args: [] },
          macwk_close: { returns: 'void', args: [] },
        },
      })
      return library.symbols as unknown as ShimSymbols
    })()
  }
  return shimPromise
}

function startPump(shim: ShimSymbols): void {
  if (pump) return
  pump = setInterval(() => shim.macwk_pump(), 16)
}

function stopPump(): void {
  clearInterval(pump)
  pump = undefined
}

export async function inspectWKWebViewAvailability(): Promise<{ available: boolean; diagnostic?: string }> {
  if (process.platform !== 'darwin') {
    return { available: false, diagnostic: 'WKWebView is available only on macOS' }
  }
  try {
    const runtime = await loadShim()
    return runtime.macwk_init()
      ? { available: true }
      : { available: false, diagnostic: `WKWebView initialization diagnostic ${runtime.macwk_diag()}` }
  } catch (error) {
    return { available: false, diagnostic: error instanceof Error ? error.message : String(error) }
  }
}

export async function createWKWebViewWindow(options: WKWebViewWindowOptions): Promise<WKWebViewWindow> {
  if (process.platform !== 'darwin') {
    throw new Error('WKWebView windows are only available on macOS')
  }
  const shim = await loadShim()
  const pendingScripts = new Map<number, PromiseWithResolvers<unknown>>()
  let nextScriptId = 1
  let closed = false
  let exitCode: number | null = null
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<void>()

  const messageCallback = new JSCallback((utf8Ptr: Pointer) => {
    const raw = new CString(utf8Ptr).toString()
    try {
      options.onMessage?.(JSON.parse(raw))
    } catch {
      options.onMessage?.(raw)
    }
  }, { args: ['ptr'], returns: 'void' })

  const navigationCallback = new JSCallback((success: number, errorStatus: number) => {
    options.onNavigateCompleted?.({ success: success !== 0, errorStatus })
  }, { args: ['i32', 'i32'], returns: 'void' })

  const scriptCallback = new JSCallback((utf8Ptr: Pointer) => {
    const raw = new CString(utf8Ptr).toString()
    let result: ScriptResult
    try {
      result = JSON.parse(raw) as ScriptResult
    } catch {
      return
    }
    const pending = pendingScripts.get(result.id)
    if (!pending) return
    pendingScripts.delete(result.id)
    if (result.ok) pending.resolve(result.value)
    else pending.reject(new Error(result.error ?? 'WKWebView script evaluation failed'))
  }, { args: ['ptr'], returns: 'void' })

  let closeCallback: JSCallback
  const dispose = () => {
    messageCallback.close()
    navigationCallback.close()
    scriptCallback.close()
    closeCallback.close()
  }
  const closeWindow = () => {
    if (closed) return
    closed = true
    exitCode = 0
    for (const pending of pendingScripts.values()) pending.reject(new Error('WKWebView window closed'))
    pendingScripts.clear()
    shim.macwk_close()
    stopPump()
    resolveExited()
    dispose()
  }
  closeCallback = new JSCallback(() => {
    options.onClose?.()
    // Return to AppKit before destroying callback pointers and finalizing the
    // TypeScript-side handle.
    setTimeout(closeWindow, 0)
  }, { args: [], returns: 'void' })

  shim.macwk_set_handlers(
    messageCallback.ptr as unknown as number,
    navigationCallback.ptr as unknown as number,
    scriptCallback.ptr as unknown as number,
    closeCallback.ptr as unknown as number,
  )

  if (!shim.macwk_init()) {
    const diagnostic = shim.macwk_diag()
    dispose()
    throw new Error(`WKWebView is unavailable (initialization diagnostic ${diagnostic})`)
  }
  startPump(shim)
  if (!shim.macwk_create_window(
    ptr(utf8(options.title ?? 'BunDesk')),
    ptr(utf8(options.url)),
    options.width ?? 900,
    options.height ?? 640,
  )) {
    const diagnostic = shim.macwk_diag()
    stopPump()
    shim.macwk_close()
    dispose()
    throw new Error(`Failed to create the WKWebView window (diagnostic ${diagnostic})`)
  }

  return {
    get exitCode() {
      return exitCode
    },
    exited,
    navigate(url: string) {
      if (!closed) shim.macwk_navigate(ptr(utf8(url)))
    },
    postMessage(value: unknown) {
      if (closed) return
      const json = JSON.stringify(value) ?? 'null'
      const snippet = `window.dispatchEvent(new MessageEvent('bundesk-message',{data:${JSON.stringify(json)}}))`
      shim.macwk_run_js(ptr(utf8(snippet)))
    },
    executeScript(script: string) {
      if (closed) return Promise.reject(new Error('WKWebView window is closed'))
      const id = nextScriptId++
      const pending = Promise.withResolvers<unknown>()
      pendingScripts.set(id, pending)
      const wrapped = `(()=>{const id=${id};const send=(p)=>window.webkit.messageHandlers.bundeskExec.postMessage(JSON.stringify(p));try{Promise.resolve(eval(${JSON.stringify(script)})).then(value=>{try{send({id,ok:true,value})}catch(error){send({id,ok:false,error:String(error)})}},error=>send({id,ok:false,error:String(error)}))}catch(error){send({id,ok:false,error:String(error)})}})()`
      shim.macwk_run_js(ptr(utf8(wrapped)))
      return pending.promise
    },
    kill() {
      closeWindow()
    },
    close() {
      closeWindow()
    },
  }
}
