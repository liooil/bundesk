import { cc, CString, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { materializeNativePath } from './native-assets'
import shimPath from '../webkit-shim.c' with { type: 'file' }

/**
 * WebKitGTK window provider (Linux) — the in-process window used by
 * `provider: 'webkit'`. Mirrors the WebView2 provider's surface
 * (`WebViewWindow`): executeScript, postMessage, navigate, close + the
 * Bun.Subprocess-compatible exitCode/exited, so pages written for
 * `window.chrome.webview` work unchanged (the shim injects the bridge).
 *
 * The shim is a header-free C file compiled at runtime by Bun's embedded
 * TinyCC; all GTK/WebKit symbols are dlopen'd, so the only system
 * requirement is the WebKit2GTK 4.1 stack (libwebkit2gtk-4.1.so.0 +
 * libjavascriptcoregtk-4.1.so.0 + libgtk-4.so.1). The GLib main loop is
 * pumped from JS (25ms interval), same pattern as the Win32 message pump.
 *
 * Verified working (2026-08-06, WSL2 Arch, webkit2gtk-4.1 2.52.3, WSLg):
 * window creation, navigation (load-changed FINISHED), executeScript with
 * JSON round-trip, page->app and app->page message bridges.
 *
 * Not supported yet: userDataDir (WebKitGTK uses the system webkit profile;
 * accepted for API parity, unused), concurrent executeScript (single pending
 * slot, like the WebView2 provider).
 */

export interface WebKitWindowOptions {
  url: string
  title?: string
  width?: number
  height?: number
  /** Accepted for API parity; WebKitGTK uses the system webkit profile. */
  userDataDir?: string
  onMessage?: (message: unknown) => void
  onClose?: () => void
  onNavigateCompleted?: (info: { success: boolean; errorStatus: number }) => void
}

export interface WebKitWindow {
  /** Null while the window is open; set on close (Bun.Subprocess-compatible). */
  exitCode: number | null
  /** Resolves when the window is closed (Bun.Subprocess-compatible). */
  exited: Promise<void>
  /** Close the window (Bun.Subprocess-compatible alias). */
  kill(): void
  close(): void
  navigate(url: string): void
  postMessage(value: unknown): void
  executeScript(script: string): Promise<unknown>
}

interface ShimSymbols {
  set_handlers(msg: number, nav: number, exec: number, execRaw: number, close: number): void
  wk_configure_environment(): number
  wk_init(): number
  wk_diag(): number
  wk_create_window(title: number, url: number, width: number, height: number): number
  wk_navigate(url: number): void
  wk_run_js(script: number): void
  wk_run_js_raw(script: number): void
  wk_pump(): void
  wk_close(): void
}

let shimPromise: Promise<ShimSymbols> | null = null

function utf8(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf8')
}

async function loadShim(): Promise<ShimSymbols> {
  if (!shimPromise) {
    shimPromise = (async () => {
      const sourcePath = await materializeNativePath(shimPath, `bundesk-webkit-shim-${process.pid}.c`)
      const library = cc({
        source: sourcePath,
        symbols: {
          set_handlers: { returns: 'void', args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'] },
          wk_configure_environment: { returns: 'i32', args: [] },
          wk_init: { returns: 'i32', args: [] },
          wk_diag: { returns: 'i32', args: [] },
          wk_create_window: { returns: 'i32', args: ['ptr', 'ptr', 'i32', 'i32'] },
          wk_navigate: { returns: 'void', args: ['ptr'] },
          wk_run_js: { returns: 'void', args: ['ptr'] },
          wk_run_js_raw: { returns: 'void', args: ['ptr'] },
          wk_pump: { returns: 'void', args: [] },
          wk_close: { returns: 'void', args: [] },
        },
      })
      return library.symbols as unknown as ShimSymbols
    })()
  }
  return shimPromise
}

let pump: Timer | undefined

function startPump(): void {
  if (pump) return
  pump = setInterval(() => {
    shimPromise?.then((shim) => shim.wk_pump())
  }, 25)
}

function stopPump(): void {
  clearInterval(pump)
  pump = undefined
}

export async function createWebKitWindow(options: WebKitWindowOptions): Promise<WebKitWindow> {
  if (process.platform !== 'linux') {
    throw new Error('WebKitGTK windows are only available on Linux')
  }
  const shim = await loadShim()
  // WebKitGTK's DMA-BUF renderer can fail to allocate a GBM buffer on some
  // Wayland/GPU combinations. This calls libc setenv before WebKit starts so
  // its child processes inherit the setting. A caller-supplied value wins.
  if (shim.wk_configure_environment()) {
    console.info('[BunDesk] WebKitGTK: disabled DMA-BUF rendering for Wayland compatibility')
  }
  const width = options.width ?? 900
  const height = options.height ?? 640

  let pendingExec: ((result: unknown) => void) | null = null

  const messageCallback = new JSCallback((utf8Ptr: Pointer) => {
    const raw = new CString(utf8Ptr).toString()
    try {
      options.onMessage?.(JSON.parse(raw))
    } catch {
      options.onMessage?.(raw)
    }
  }, { args: ['ptr'], returns: 'void' })

  // WEBKIT_LOAD_* : STARTED=0 REDIRECTED=1 COMMITTED=2 FINISHED=3
  const navCallback = new JSCallback((event: number) => {
    if (event === 3) options.onNavigateCompleted?.({ success: true, errorStatus: 0 })
  }, { args: ['i32'], returns: 'void' })

  const execCallback = new JSCallback((utf8Ptr: Pointer) => {
    const raw = new CString(utf8Ptr).toString()
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    const resolve = pendingExec
    pendingExec = null
    resolve?.(value)
  }, { args: ['ptr'], returns: 'void' })

  // Results of fire-and-forget evaluations (app->page postMessage dispatch).
  const execRawCallback = new JSCallback(() => {}, { args: ['ptr'], returns: 'void' })

  let closed = false
  let exitCode: number | null = null
  let resolveExited: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  let closeCallback: JSCallback
  const closeWindow = () => {
    if (closed) return
    closed = true
    exitCode = 0
    resolveExited?.()
    shim.wk_close()
    stopPump()
    messageCallback.close()
    navCallback.close()
    execCallback.close()
    execRawCallback.close()
    closeCallback.close()
  }
  closeCallback = new JSCallback(() => {
    options.onClose?.()
    // Let the GTK signal callback return before destroying the native window
    // and releasing its callback pointer.
    setTimeout(closeWindow, 0)
  }, { args: [], returns: 'void' })

  shim.set_handlers(
    messageCallback.ptr as unknown as number,
    navCallback.ptr as unknown as number,
    execCallback.ptr as unknown as number,
    execRawCallback.ptr as unknown as number,
    closeCallback.ptr as unknown as number,
  )

  if (!shim.wk_init()) {
    const diag = shim.wk_diag()
    throw new Error(
      `WebKitGTK not available (init diagnostic ${diag}). ` +
        'Install the WebKit2GTK 4.1 stack ' +
        '(libwebkit2gtk-4.1, libjavascriptcoregtk-4.1, libgtk-4) and a display server; ' +
        "or use the default 'browser' provider.",
    )
  }

  startPump()
  if (!shim.wk_create_window(ptr(utf8(options.title ?? 'BunDesk')), ptr(utf8(options.url)), width, height)) {
    stopPump()
    throw new Error('Failed to create the WebKitGTK window')
  }

  return {
    exitCode,
    exited,
    navigate(url: string) {
      shim.wk_navigate(ptr(utf8(url)))
    },
    postMessage(value: unknown) {
      // dispatch a synthetic MessageEvent the injected bridge subscribes to
      const json = JSON.stringify(value)
      const snippet = `window.dispatchEvent(new MessageEvent('bundesk-message',{data:${JSON.stringify(json)}}))`
      shim.wk_run_js_raw(ptr(utf8(snippet)))
    },
    executeScript(script: string) {
      const wrapped = `JSON.stringify(eval(${JSON.stringify(script)}))`
      return new Promise<unknown>((resolve) => {
        pendingExec = resolve
        shim.wk_run_js(ptr(utf8(wrapped)))
      })
    },
    kill() {
      closeWindow()
    },
    close() {
      closeWindow()
    },
  }
}
