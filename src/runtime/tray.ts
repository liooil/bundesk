import type { DesktopAppContext } from './app'
import { isTermux } from './platform'
import type { Win32TrayHandle } from './tray-win32'
import { createWin32Tray } from './tray-win32'

/**
 * System tray support.
 *
 * Feasibility per platform:
 * - Windows: implemented — pure bun:ffi against user32/shell32
 *   (Shell_NotifyIconW + hidden window + message pump). No native toolchain.
 * - macOS: feasible via AppKit NSStatusItem driven through objc_msgSend FFI,
 *   but needs an NSApplication/run-loop dance; not implemented yet.
 * - Linux: feasible via the StatusNotifierItem D-Bus protocol (pure-JS D-Bus
 *   client, context menu via DBusMenu); not implemented yet.
 * - Termux/Android: no system tray concept.
 */

export interface TrayMenuItem<WebSocketData = undefined> {
  id?: string
  label: string
  enabled?: boolean
  checked?: boolean
  separator?: boolean
  onClick?: (context: DesktopAppContext<WebSocketData>) => void | Promise<void>
}

export interface DesktopTrayOptions<WebSocketData = undefined> {
  /** Windows: path to an .ico file or an executable/DLL; defaults to the app's own executable. */
  icon?: string
  tooltip?: string
  menu?: TrayMenuItem<WebSocketData>[]
  /** Left click / double click on the icon. */
  onActivate?: (context: DesktopAppContext<WebSocketData>) => void | Promise<void>
}

export interface TrayController<WebSocketData = undefined> {
  update(options: Partial<DesktopTrayOptions<WebSocketData>>): void
  destroy(): void
}

export function createTray<WebSocketData = undefined>(
  options: DesktopTrayOptions<WebSocketData>,
  callbacks: { onActivate: () => void; onMenuClick: (item: TrayMenuItem<WebSocketData>) => void },
): TrayController<WebSocketData> | null {
  if (process.platform === 'win32') {
    let currentMenu: TrayMenuItem<WebSocketData>[] = options.menu ?? [] as TrayMenuItem<WebSocketData>[]
    const handle: Win32TrayHandle | null = createWin32Tray({
      icon: options.icon,
      tooltip: options.tooltip,
      menu: currentMenu,
      onActivate: callbacks.onActivate,
      onMenuClick: (index) => {
        const item = currentMenu[index]
        if (item) callbacks.onMenuClick(item)
      },
    })
    if (!handle) return null
    return {
      update(next) {
        if (next.menu) currentMenu = next.menu
        handle.update({
          icon: next.icon,
          tooltip: next.tooltip,
          menu: next.menu,
        })
      },
      destroy() {
        handle.destroy()
      },
    }
  }

  if (isTermux()) {
    throw new Error('System tray is not available on Termux (Android has no tray concept)')
  }
  throw new Error(
    `System tray is not implemented for ${process.platform} yet: ` +
      'Windows works via Win32 FFI; macOS needs AppKit NSStatusItem through FFI; ' +
      'Linux needs StatusNotifierItem over D-Bus',
  )
}
