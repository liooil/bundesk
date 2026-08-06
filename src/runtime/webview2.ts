import { cc, CString, dlopen, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import shimSource from '../webview2-shim.c' with { type: 'text' }
import loaderBase64 from '../webview2-loader-b64'

/**
 * WebView2 window provider (Windows) — SPIKE status.
 *
 * The COM host is a small header-free C shim compiled at runtime by Bun's
 * embedded TinyCC (`cc`), so no native toolchain and no extra binary are
 * needed: the single-file build story is preserved. Vtable layouts in the
 * shim are verified against the official WebView2.h.
 *
 * Verified working (2026-08-05, Windows 11, runtime 151.0.4129.59):
 * - tinycc compiles the shim at runtime and links kernel32/user32/ole32;
 * - the official WebView2Loader.dll (embedded base64) loads and discovers the
 *   runtime; environment and controller COM objects are created; their
 *   completed-handler callbacks arrive through the PeekMessageW pump;
 * - the runtime's per-user profile directory is created.
 *
 * NOT working on this machine: navigation. `Navigate`/`NavigateToString`
 * return S_OK but the source stays `about:blank` and NavigationCompleted never
 * fires; deferred calls fail with 0x8007139F ("resource not in correct
 * state"). The browser process (msedgewebview2.exe) is spawned only
 * unreliably/delayed for a bun.exe host, and this install has an unusual
 * Edge-unified runtime with no WebView2.dll anywhere. This looks
 * machine/runtime-specific, not an FFI defect — the env/controller/callback
 * plumbing is all proven. Validate on a machine with a standard Evergreen
 * WebView2 runtime before wiring `window.provider = 'webview'` into app.ts.
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

export interface WebViewWindow {
  navigate(url: string): void
  postMessage(value: unknown): void
  executeScript(script: string): Promise<unknown>
  close(): void
}

interface ShimSymbols {
  set_handlers(env: number, ctrl: number, msg: number, nav: number, exec: number, close: number): void
  wv_init(): number
  wv_use_loader(loaderPath: number): number
  wv_create_window(width: number, height: number, title: number): number | null
  wv_show(): void
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
      const sourcePath = join(tmpdir(), `bundesk-webview2-shim-${process.pid}.c`)
      await writeFile(sourcePath, shimSource, 'utf8')
      const library = cc({
        source: sourcePath,
        library: ['kernel32', 'user32', 'ole32', 'advapi32'],
        symbols: {
          set_handlers: { returns: 'void', args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'] },
          wv_init: { returns: 'i32', args: [] },
          wv_use_loader: { returns: 'i32', args: ['ptr'] },
          wv_create_window: { returns: 'ptr', args: ['i32', 'i32', 'ptr'] },
          wv_show: { returns: 'void', args: [] },
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

const user32 = dlopen('user32.dll', {
  PeekMessageW: { args: ['ptr', 'ptr', 'u32', 'u32', 'u32'], returns: 'i32' },
  TranslateMessage: { args: ['ptr'], returns: 'i32' },
  DispatchMessageW: { args: ['ptr'], returns: 'i64' },
})

let pump: Timer | undefined

function startPump(): void {
  if (pump) return
  pump = setInterval(() => {
    const message = Buffer.alloc(40)
    while (user32.symbols.PeekMessageW(ptr(message), null, 0, 0, 1)) {
      user32.symbols.TranslateMessage(ptr(message))
      user32.symbols.DispatchMessageW(ptr(message))
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

  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let pendingExec: ((result: unknown) => void) | null = null

  const envCallback = new JSCallback((_err: number, env: number) => {
    shim.wv_create_controller(env, hwnd as unknown as number)
  }, { args: ['i32', 'ptr'], returns: 'void' })

  const ctrlCallback = new JSCallback((_err: number, ctrl: number) => {
    const hr = shim.wv_setup(ctrl)
    if (hr !== 0) {
      rejectReady?.(new Error(`WebView2 setup failed (HRESULT 0x${(hr >>> 0).toString(16)})`))
      return
    }
    shim.wv_navigate(ptr(utf16(options.url)))
    shim.wv_show()
    resolveReady?.()
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

  const closeCallback = new JSCallback(() => {
    options.onClose?.()
  }, { args: [], returns: 'void' })

  shim.set_handlers(
    envCallback.ptr as unknown as number,
    ctrlCallback.ptr as unknown as number,
    messageCallback.ptr as unknown as number,
    navCallback.ptr as unknown as number,
    execCallback.ptr as unknown as number,
    closeCallback.ptr as unknown as number,
  )

  const loaderPath = join(tmpdir(), `bundesk-webview2-loader-${process.pid}.dll`)
  await writeFile(loaderPath, Buffer.from(loaderBase64, 'base64'))

  shim.wv_init()
  if (!shim.wv_use_loader(ptr(utf16(loaderPath)))) {
    throw new Error('WebView2Loader.dll failed to load or locate the WebView2 runtime')
  }

  const hwnd = shim.wv_create_window(width, height, ptr(utf16(options.title ?? 'BunDesk')))
  if (!hwnd) throw new Error('Failed to create the WebView2 host window')

  startPump()
  const hr = shim.wv_create_environment(ptr(utf16(userDataFolder)))
  if (hr !== 0) {
    stopPump()
    throw new Error(`WebView2 environment creation failed (HRESULT 0x${(hr >>> 0).toString(16)})`)
  }

  await ready

  let closed = false
  return {
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
    close() {
      if (closed) return
      closed = true
      shim.wv_close()
      stopPump()
      envCallback.close()
      ctrlCallback.close()
      messageCallback.close()
      navCallback.close()
      execCallback.close()
      closeCallback.close()
    },
  }
}
