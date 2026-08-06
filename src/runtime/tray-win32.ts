import { dlopen, JSCallback, ptr, type Pointer } from 'bun:ffi'

/**
 * System tray for Windows, implemented purely with bun:ffi against Win32 —
 * no native toolchain, consistent with BunDesk's build story.
 *
 * Shell_NotifyIconW needs a window to receive callback messages, so we
 * register a hidden window class with a WndProc callback and pump its message
 * queue from a short timer on the Bun event loop (PeekMessageW drain every
 * 50ms). Tray events are fast and rare; polling cost is negligible and avoids
 * blocking a dedicated thread.
 */

export interface Win32TrayItem {
  label?: string
  enabled?: boolean
  checked?: boolean
  separator?: boolean
}

export interface Win32TrayOptions {
  icon?: string
  tooltip?: string
  menu?: Win32TrayItem[]
  onActivate: () => void
  onMenuClick: (index: number) => void
}

export interface Win32TrayHandle {
  update(options: { icon?: string; tooltip?: string; menu?: Win32TrayItem[] }): void
  destroy(): void
  /** True when the icon is present in the notification area (Win10+ probe; false while overflowed). */
  iconPresent(): boolean
}

// Lazily loaded: tray.ts imports this module on every platform (index.ts
// re-exports it), and dlopen of win32 DLLs must not run outside Windows.
interface Win32TrayLibs {
  user32: {
    symbols: {
      RegisterClassW(wndClass: Pointer): number
      CreateWindowExW(exStyle: number, cls: Pointer, title: Pointer | null, style: number, x: number, y: number, w: number, h: number, parent: Pointer | null, menu: Pointer | null, inst: Pointer | number | null, param: Pointer | null): Pointer | null
      DefWindowProcW(hwnd: Pointer | number, msg: number, wp: number | bigint, lp: number | bigint): number
      DestroyWindow(hwnd: Pointer): number
      PeekMessageW(msg: Pointer, hwnd: Pointer | null, min: number, max: number, remove: number): number
      TranslateMessage(msg: Pointer): number
      DispatchMessageW(msg: Pointer): number
      PostMessageW(hwnd: Pointer | null, msg: number, wp: number, lp: number): number
      LoadImageW(hInst: Pointer | null, name: Pointer, type: number, w: number, h: number, flags: number): Pointer | null
      LoadIconW(hInst: Pointer | null, name: Pointer): Pointer | null
      SetForegroundWindow(hwnd: Pointer | null): number
      GetCursorPos(point: Pointer): number
      CreatePopupMenu(): Pointer | null
      AppendMenuW(hmenu: Pointer, flags: number, id: number, label: Pointer | null): number
      TrackPopupMenu(hmenu: Pointer | null, flags: number, x: number, y: number, reserved: number, hwnd: Pointer | null, rect: Pointer | null): number
      DestroyMenu(hmenu: Pointer): number
    }
  }
  shell32: {
    symbols: {
      Shell_NotifyIconW(op: number, data: Pointer): number
      Shell_NotifyIconGetRect(data: Pointer, rect: Pointer): number
    }
  }
  kernel32: {
    symbols: {
      GetModuleHandleW(name: Pointer | null): Pointer | null
    }
  }
}

let trayLibs: Win32TrayLibs | null = null
function libs(): Win32TrayLibs {
  if (!trayLibs) {
    // dlopen's generic return type cannot express the callable symbol shapes; the
    // interface below is the FFI contract this module actually uses.
    trayLibs = {
      user32: dlopen('user32.dll', {
  RegisterClassW: { args: ['ptr'], returns: 'u32' },
  CreateWindowExW: { args: ['u32', 'ptr', 'ptr', 'u32', 'i32', 'i32', 'i32', 'i32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'ptr' },
  DefWindowProcW: { args: ['ptr', 'u32', 'i64', 'i64'], returns: 'i64' },
  DestroyWindow: { args: ['ptr'], returns: 'i32' },
  PeekMessageW: { args: ['ptr', 'ptr', 'u32', 'u32', 'u32'], returns: 'i32' },
  TranslateMessage: { args: ['ptr'], returns: 'i32' },
  DispatchMessageW: { args: ['ptr'], returns: 'i64' },
  PostMessageW: { args: ['ptr', 'u32', 'i64', 'i64'], returns: 'i32' },
  LoadImageW: { args: ['ptr', 'ptr', 'u32', 'i32', 'i32', 'u32'], returns: 'ptr' },
  LoadIconW: { args: ['ptr', 'ptr'], returns: 'ptr' },
  SetForegroundWindow: { args: ['ptr'], returns: 'i32' },
  GetCursorPos: { args: ['ptr'], returns: 'i32' },
  CreatePopupMenu: { args: [], returns: 'ptr' },
  AppendMenuW: { args: ['ptr', 'u32', 'i64', 'ptr'], returns: 'i32' },
  TrackPopupMenu: { args: ['ptr', 'u32', 'i32', 'i32', 'i32', 'ptr', 'ptr'], returns: 'i32' },
  DestroyMenu: { args: ['ptr'], returns: 'i32' },
}) as unknown as Win32TrayLibs['user32'],

      shell32: dlopen('shell32.dll', {
        Shell_NotifyIconW: { args: ['u32', 'ptr'], returns: 'i32' },
        Shell_NotifyIconGetRect: { args: ['ptr', 'ptr'], returns: 'i32' },
      }) as unknown as Win32TrayLibs['shell32'],
      kernel32: dlopen('kernel32.dll', {
        GetModuleHandleW: { args: ['ptr'], returns: 'ptr' },
      }) as unknown as Win32TrayLibs['kernel32'],
    }
  }
  return trayLibs
}

const NIM_ADD = 0
const NIM_MODIFY = 1
const NIM_DELETE = 2

const NIF_MESSAGE = 0x1
const NIF_ICON = 0x2
const NIF_TIP = 0x4

const WM_TRAY = 0x8001
const WM_LBUTTONUP = 0x202
const WM_LBUTTONDBLCLK = 0x203
const WM_RBUTTONUP = 0x205

const IMAGE_ICON = 1
const LR_LOADFROMFILE = 0x10
const IDI_APPLICATION = 32512

const MF_SEPARATOR = 0x800
const MF_GRAYED = 0x1
const MF_CHECKED = 0x8
const TPM_RETURNCMD = 0x100
const TPM_RIGHTBUTTON = 0x2
const TPM_NONOTIFY = 0x80

const NOTIFYICONDATAW_V3_SIZE = 976
const MENU_ID_BASE = 1000

function utf16(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf16le')
}

function loadIcon(iconPath: string | undefined): number {
  if (iconPath) {
    const pathBuffer = utf16(iconPath)
    const handle = libs().user32.symbols.LoadImageW(null, ptr(pathBuffer), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
    if (handle) return Number(handle)
  }
  // IDI_APPLICATION is a MAKEINTRESOURCE value: the constant itself is the pointer.
  const applicationIcon = libs().user32.symbols.LoadIconW(null, IDI_APPLICATION as unknown as Pointer)
  return Number(applicationIcon ?? 0)
}

function writeNotifyIconData(
  buffer: Buffer,
  hwnd: number,
  hicon: number,
  flags: number,
  tooltip: string | undefined,
): void {
  buffer.fill(0)
  buffer.writeUInt32LE(NOTIFYICONDATAW_V3_SIZE, 0)
  buffer.writeBigUInt64LE(BigInt(hwnd), 8)
  buffer.writeUInt32LE(1, 16) // uID
  buffer.writeUInt32LE(flags, 20)
  buffer.writeUInt32LE(WM_TRAY, 24)
  buffer.writeBigUInt64LE(BigInt(hicon), 32)
  if (tooltip) {
    buffer.write(tooltip.slice(0, 127), 40, 'utf16le')
  }
}

export function createWin32Tray(options: Win32TrayOptions): Win32TrayHandle | null {
  const hInstance = Number(libs().kernel32.symbols.GetModuleHandleW(null) ?? 0)
  const className = `BunDeskTray_${process.pid}_${Date.now()}`
  const classNameBuffer = utf16(className)

  // WNDCLASSW (x64): style@0, wndProc@8, cbClsExtra@16, cbWndExtra@20,
  // hInstance@24, hIcon@32, hCursor@40, hbrBackground@48, menu@56, class@64
  const windowClass = Buffer.alloc(72)
  let wndProcCallback: JSCallback | null = null
  windowClass.writeUInt32LE(0, 0)
  windowClass.writeBigUInt64LE(BigInt(0), 8) // lpfnWndProc filled below
  windowClass.writeUInt32LE(0, 16)
  windowClass.writeUInt32LE(0, 20)
  windowClass.writeBigUInt64LE(BigInt(hInstance), 24)
  windowClass.writeBigUInt64LE(BigInt(0), 40)
  windowClass.writeBigUInt64LE(BigInt(0), 48)
  windowClass.writeBigUInt64LE(BigInt(0), 56)
  windowClass.writeBigUInt64LE(BigInt(ptr(classNameBuffer)), 64)

  let hwnd: Pointer | null = null
  let notifyData = Buffer.alloc(NOTIFYICONDATAW_V3_SIZE)
  let currentMenu: Win32TrayItem[] = options.menu ?? []
  let iconPath = options.icon
  let tooltip = options.tooltip
  let interval: Timer | undefined
  let destroyed = false

  const pumpMessages = (): void => {
    const message = Buffer.alloc(40)
    while (libs().user32.symbols.PeekMessageW(ptr(message), null, 0, 0, 1)) {
      libs().user32.symbols.TranslateMessage(ptr(message))
      libs().user32.symbols.DispatchMessageW(ptr(message))
    }
  }

  const showMenu = (): void => {
    const point = Buffer.alloc(8)
    libs().user32.symbols.GetCursorPos(ptr(point))
    const x = point.readInt32LE(0)
    const y = point.readInt32LE(4)
    const hmenu = libs().user32.symbols.CreatePopupMenu()
    if (!hmenu) return
    for (let index = 0; index < currentMenu.length; index++) {
      const item = currentMenu[index]!
      if (item.separator) {
        libs().user32.symbols.AppendMenuW(hmenu, MF_SEPARATOR, 0, null)
        continue
      }
      let flags = 0
      if (item.enabled === false) flags |= MF_GRAYED
      if (item.checked) flags |= MF_CHECKED
      libs().user32.symbols.AppendMenuW(hmenu, flags, MENU_ID_BASE + index, ptr(utf16(item.label ?? '')))
    }
    libs().user32.symbols.SetForegroundWindow(hwnd)
    const selected = libs().user32.symbols.TrackPopupMenu(hmenu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, x, y, 0, hwnd, null)
    libs().user32.symbols.PostMessageW(hwnd, 0, 0, 0)
    libs().user32.symbols.DestroyMenu(hmenu)
    if (selected >= MENU_ID_BASE) options.onMenuClick(selected - MENU_ID_BASE)
  }

  wndProcCallback = new JSCallback(
    (callbackHwnd: number, message: number, _wParam: number | bigint, lParam: number | bigint) => {
      if (Number(message) === WM_TRAY) {
        const event = Number(lParam)
        if (event === WM_LBUTTONUP || event === WM_LBUTTONDBLCLK) {
          options.onActivate()
        } else if (event === WM_RBUTTONUP) {
          showMenu()
        }
        return 0
      }
      return Number(libs().user32.symbols.DefWindowProcW(callbackHwnd, message, _wParam, lParam))
    },
    { args: ['ptr', 'u32', 'i64', 'i64'], returns: 'i64' },
  )
  windowClass.writeBigUInt64LE(BigInt(wndProcCallback.ptr ?? 0), 8)

  if (!libs().user32.symbols.RegisterClassW(ptr(windowClass))) return null

  hwnd = libs().user32.symbols.CreateWindowExW(
    0,
    ptr(classNameBuffer),
    null,
    0,
    0, 0, 0, 0,
    null,
    null,
    hInstance,
    null,
  )
  if (!hwnd) return null

  const hicon = loadIcon(iconPath)
  const flags = NIF_MESSAGE | NIF_ICON | (tooltip ? NIF_TIP : 0)
  writeNotifyIconData(notifyData, hwnd, hicon, flags, tooltip)
  if (!libs().shell32.symbols.Shell_NotifyIconW(NIM_ADD, ptr(notifyData))) {
    libs().user32.symbols.DestroyWindow(hwnd)
    return null
  }

  interval = setInterval(pumpMessages, 50)

  return {
    update(next) {
      if (destroyed) return
      iconPath = next.icon ?? iconPath
      tooltip = next.tooltip ?? tooltip
      if (next.menu) currentMenu = next.menu
      const nextIcon = loadIcon(iconPath)
      const nextFlags = NIF_MESSAGE | NIF_ICON | (tooltip ? NIF_TIP : 0)
      writeNotifyIconData(notifyData, hwnd, nextIcon, nextFlags, tooltip)
      libs().shell32.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(notifyData))
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      clearInterval(interval)
      libs().shell32.symbols.Shell_NotifyIconW(NIM_DELETE, ptr(notifyData))
      libs().user32.symbols.DestroyWindow(hwnd)
      wndProcCallback?.close()
    },
    iconPresent() {
      const identifier = Buffer.alloc(24)
      identifier.writeUInt32LE(24, 0)
      identifier.writeBigUInt64LE(BigInt(hwnd), 8)
      identifier.writeUInt32LE(1, 16)
      const rect = Buffer.alloc(16)
      return libs().shell32.symbols.Shell_NotifyIconGetRect(ptr(identifier), ptr(rect)) === 0
    },
  }
}
