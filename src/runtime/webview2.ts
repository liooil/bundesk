import { cc, CString, dlopen, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The shim ships as a real file; `bun build --compile` embeds it into the
// single binary, and the import resolves to the embedded file path.
import shimPath from '../webview2-shim.c' with { type: 'file' }
import { materializeNativePath } from './native-assets'

/**
 * WebView2 window provider (Windows).
 *
 * The COM host is a small header-free C shim compiled at runtime by Bun's
 * embedded TinyCC (`cc`), so no native toolchain and no extra binary are
 * needed: the single-file build story is preserved. Vtable layouts in the
 * shim are verified against the official WebView2.h.
 *
 * The official WebView2Loader.dll is deliberately NOT used. Discovery mirrors
 * the loader's own logic (jchv/OpenWebView2Loader): EdgeUpdate records the
 * runtime install folder in
 * HKCU|HKLM\Software\Microsoft\EdgeUpdate\ClientState\{F3017226-...}\EBWebView
 * (both registry views probed; the loader is 32-bit and relies on implicit
 * redirection). The shim then loads
 * <base>\EBWebView\x64\EmbeddedBrowserWebView.dll and calls its undocumented
 * CreateWebViewEnvironmentWithOptionsInternal export directly with the
 * 5-argument (bool, runtimeType, userDataDir, options, handler) signature
 * cross-checked against jchv/OpenWebView2Loader. This is the SAME dependency
 * the official loader has — its entire env-creation path is a GetProcAddress
 * on this export plus a direct call, with no fallback. The export is
 * undocumented but de-facto ABI-stable: Microsoft cannot change it without
 * breaking every already-deployed loader in the wild, so a frozen binary
 * fails identically whether it embeds the loader or this shim.
 *
 * Verified working (2026-08-06, Windows 11, Edge-unified runtime 151.0.4129.59,
 * no loader DLL anywhere in the process):
 * - tinycc compiles the shim at runtime and links kernel32/user32/ole32/advapi32;
 * - registry discovery -> LoadLibrary(EmbeddedBrowserWebView.dll) ->
 *   CreateWebViewEnvironmentWithOptionsInternal -> env callback (S_OK);
 * - environment + controller creation, navigation (NavigationCompleted),
 *   ExecuteScript and bidirectional postMessage all verified end to end;
 * - root cause of the earlier "no browser process / 0x8007139F" failure was a
 *   missing AddRef on the environment/controller — the loader releases its
 *   references after the completed callbacks, leaving dangling pointers that
 *   broke the async browser spawn. Objects we hold are AddRef'd now.
 *
 * Two TinyCC codegen constraints shape the shim: stack frames must stay small
 * (tcc miscompiles functions with >~2KB of locals — a frame with two
 * wchar_t[1024] buffers crashed every call, shrinking to MAX_PATH-sized
 * buffers fixed it), and `long` is 32-bit on Windows x64 so pointer<->long
 * casts are compile errors.
 *
 * Remaining notes: `bun build --compile` embeds the .c asset into the single
 * binary (verified). close() skips controller Close() (can crash when the
 * runtime is torn down); the process teardown handles it. Pages served by the app must
…
 * as plain text and the DOM is not queryable.
 */

export interface WebViewWindowOptions {
  url: string
  title?: string
  width?: number
  height?: number
  userDataFolder?: string
  onMessage?: (message: unknown) => void
  onClose?: () => void
  onNavigateCompleted?: (info: { success: boolean; errorStatus: number }) => void
}

/** controller 回调就绪等待上限；超时说明 WebView2 侧挂起（常见于 user data 目录被占用）。 */
const WEBVIEW_READY_TIMEOUT_MS = 45_000

export interface WebViewWindow {
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
  set_handlers(env: number, ctrl: number, msg: number, nav: number, exec: number, close: number): void
  wv_init(): number
  wv_use_runtime(): number
  wv_create_window(width: number, height: number, title: number): number | null
  wv_show(): number
  wv_create_environment(userDataFolder: number): number
  wv_create_controller(env: number, hwnd: number): number
  wv_setup(ctrl: number): number
  wv_navigate(url: number): number
  wv_post_json(json: number): number
  wv_execute_script(js: number): void
  wv_close(): void
}

let shimPromise: Promise<ShimSymbols> | null = null

function utf16(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf16le')
}

async function loadShim(): Promise<ShimSymbols> {
  if (!shimPromise) {
    shimPromise = (async () => {
      const sourcePath = await materializeNativePath(shimPath, `bundesk-webview2-shim-${process.pid}.c`)
      const library = cc({
        source: sourcePath,
        library: ['kernel32', 'user32', 'ole32', 'advapi32', 'shell32'],
        symbols: {
          set_handlers: { returns: 'void', args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'] },
          wv_init: { returns: 'i32', args: [] },
          wv_use_runtime: { returns: 'i32', args: [] },
          wv_create_window: { returns: 'ptr', args: ['i32', 'i32', 'ptr'] },
          wv_show: { returns: 'i32', args: [] },
          wv_create_environment: { returns: 'i32', args: ['ptr'] },
          wv_create_controller: { returns: 'i32', args: ['ptr', 'ptr'] },
          wv_setup: { returns: 'i32', args: ['ptr'] },
          wv_navigate: { returns: 'i32', args: ['ptr'] },
          wv_post_json: { returns: 'i32', args: ['ptr'] },
          wv_execute_script: { returns: 'void', args: ['ptr'] },
          wv_close: { returns: 'void', args: [] },
        },
      })
      return library.symbols as unknown as ShimSymbols
    })()
  }
  return shimPromise
}

let user32: {
  symbols: {
    PeekMessageW(message: Pointer, hwnd: Pointer | null, min: number, max: number, remove: number): number
    TranslateMessage(message: Pointer): number
    DispatchMessageW(message: Pointer): number
  }
} | null = null

// Lazy: this module is imported on every platform (index.ts re-exports it),
// and dlopen('user32.dll') must not run outside Windows. The cast is needed
// because dlopen's generic return type cannot express these callable shapes.
function pumpSymbols() {
  if (!user32) {
    user32 = dlopen('user32.dll', {
      PeekMessageW: { args: ['ptr', 'ptr', 'u32', 'u32', 'u32'], returns: 'i32' },
      TranslateMessage: { args: ['ptr'], returns: 'i32' },
      DispatchMessageW: { args: ['ptr'], returns: 'i64' },
    }) as unknown as NonNullable<typeof user32>
  }
  return user32.symbols
}

let pump: Timer | undefined

function startPump(): void {
  if (pump) return
  pump = setInterval(() => {
    const s = pumpSymbols()
    const message = Buffer.alloc(40)
    while (s.PeekMessageW(ptr(message), null, 0, 0, 1)) {
      s.TranslateMessage(ptr(message))
      s.DispatchMessageW(ptr(message))
    }
  }, 25)
}

function stopPump(): void {
  clearInterval(pump)
  pump = undefined
}

export async function createWebViewWindow(options: WebViewWindowOptions): Promise<WebViewWindow> {
  if (process.platform !== 'win32') {
    throw new Error('WebView2 windows are only available on Windows')
  }
  const shim = await loadShim()
  const width = options.width ?? 900
  const height = options.height ?? 640
  const userDataFolder = options.userDataFolder ?? join(tmpdir(), `bundesk-webview2-data-${process.pid}`)

  let resolveReady: ((ctrl: number) => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let pendingExec: ((result: unknown) => void) | null = null

  const envCallback = new JSCallback((err: number, env: number) => {
    if (err !== 0 || env === 0) {
      rejectReady?.(new Error(
        `WebView2 environment creation failed (HRESULT 0x${(err >>> 0).toString(16)}). ` +
        `userDataFolder 可能被其他 WebView2 进程占用: ${userDataFolder}`,
      ))
      return
    }
    shim.wv_create_controller(env, hwnd as unknown as number)
  }, { args: ['i32', 'ptr'], returns: 'void' })

  const ctrlCallback = new JSCallback((err: number, ctrl: number) => {
    if (err !== 0 || ctrl === 0) {
      rejectReady?.(new Error(
        `WebView2 controller creation failed (HRESULT 0x${(err >>> 0).toString(16)}). ` +
        `userDataFolder 可能被其他 WebView2 进程占用: ${userDataFolder}`,
      ))
      return
    }
    // COM 调用必须在此回调所在线程执行（WebView2 派发线程）：JS 线程调用
    // 会崩溃（0xFFFFFFFF）。wv_setup 内含 put_Bounds（窗口不可见时不会收到
    // WM_SIZE，Bounds 必须显式初始化，否则内容区域为 0 导致白屏）与
    // put_IsVisible。
    const hr = shim.wv_setup(ctrl)
    if (hr !== 0) {
      rejectReady?.(new Error(`WebView2 setup failed (HRESULT 0x${(hr >>> 0).toString(16)})`))
      return
    }
    shim.wv_navigate(ptr(utf16(options.url)))
    resolveReady?.(ctrl)
  }, { args: ['i32', 'ptr'], returns: 'void' })

  const messageCallback = new JSCallback((utf8Ptr: Pointer) => {
    const raw = new CString(utf8Ptr).toString()
    try {
      options.onMessage?.(JSON.parse(raw))
    } catch {
      options.onMessage?.(raw)
    }
  }, { args: ['ptr'], returns: 'void' })

  const navCallback = new JSCallback((success: number, errorStatus: number) => {
    options.onNavigateCompleted?.({ success: success !== 0, errorStatus })
  }, { args: ['i32', 'i32'], returns: 'void' })

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

  let closed = false
  let exitCode: number | null = null
  let resolveExited: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  const closeWindow = () => {
    if (closed) return
    closed = true
    exitCode = 0
    // 全部在 JS 线程执行：CoUninitialize 必须与 CoInitializeEx（wv_init，
    // JS 线程）同线程；DestroyWindow 需要窗口线程。resolveExited 触发
    // app.wait() → stop() → 进程退出。
    resolveExited?.()
    shim.wv_close()
    stopPump()
    // 不主动 close 各 JSCallback：进程即将退出，OS 回收；且 closeCallback
    // 正在执行（WebView2 COM 层仍持有函数指针），回调内 close 自身会
    // use-after-free 崩溃。
  }

  const closeCallback = new JSCallback(() => {
    options.onClose?.()
    // WM_CLOSE → 派发回 JS 线程执行关闭（回调本身跑在 WebView2 派发线程）。
    setTimeout(closeWindow, 0)
  }, { args: [], returns: 'void' })

  shim.set_handlers(
    envCallback.ptr as unknown as number,
    ctrlCallback.ptr as unknown as number,
    messageCallback.ptr as unknown as number,
    navCallback.ptr as unknown as number,
    execCallback.ptr as unknown as number,
    closeCallback.ptr as unknown as number,
  )

  shim.wv_init()
  if (!shim.wv_use_runtime()) {
    throw new Error(
      'WebView2 runtime not found. The runtime registers under EdgeUpdate Clients ' +
        '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} and hosts EmbeddedBrowserWebView.dll ' +
        '(installed with Microsoft Edge on Windows 10/11).',
    )
  }

  const hwnd = shim.wv_create_window(width, height, ptr(utf16(options.title ?? 'BunDesk')))
  if (!hwnd) throw new Error('Failed to create the WebView2 host window')

  startPump()
  const hr = shim.wv_create_environment(ptr(utf16(userDataFolder)))
  if (hr !== 0) {
    stopPump()
    throw new Error(`WebView2 environment creation failed (HRESULT 0x${(hr >>> 0).toString(16)})`)
  }

  let readyTimer: Timer | undefined
  const ctrl = await Promise.race([
    ready,
    new Promise<number>((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error(
        `WebView2 窗口在 ${WEBVIEW_READY_TIMEOUT_MS}ms 内未就绪（controller 回调未触发）。` +
        `userDataFolder 可能被其他 WebView2 进程占用: ${userDataFolder}`,
      )), WEBVIEW_READY_TIMEOUT_MS)
    }),
  ])
  // 就绪后必须清掉超时定时器，否则进程会滞留到定时器到期才退出。
  clearTimeout(readyTimer)
  // 窗口显示必须在创建线程（JS 线程）：回调线程（WebView2 派发线程）上的
  // SetWindowPos 无效（窗口存在但 WS_VISIBLE 未设置）。
  shim.wv_show()

  return {
    exitCode,
    exited,
    navigate(url: string) {
      shim.wv_navigate(ptr(utf16(url)))
    },
    postMessage(value: unknown) {
      shim.wv_post_json(ptr(utf16(JSON.stringify(value))))
    },
    executeScript(script: string) {
      const result = new Promise<unknown>((resolve) => {
        pendingExec = resolve
      })
      shim.wv_execute_script(ptr(utf16(script)))
      return result
    },
    kill: closeWindow,
    close: closeWindow,
  }
}
