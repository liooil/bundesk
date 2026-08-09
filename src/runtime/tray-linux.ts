/**
 * Linux tray via the StatusNotifierItem spec over D-Bus (pure JS).
 *
 * Registers a well-known name (`org.kde.StatusNotifierItem-<pid>-<n>`),
 * exports the item object (org.kde.StatusNotifierItem) with a
 * com.canonical.dbusmenu menu, and lets the host (KDE Plasma, XFCE,
 * GNOME + AppIndicator extension, ...) discover it by watching names or
 * through the StatusNotifierWatcher. No native dependencies.
 *
 * Requires a session bus and a StatusNotifierItem-capable host to be
 * visible; without either, creation returns null (graceful degradation).
 */
import type { DesktopTrayOptions, TrayController, TrayMenuItem } from './tray'
import { connectDBus, DBUS_IFACE, DBUS_PATH, type DBusConnection, type DBusMessage } from './dbus'

const SNI_IFACE = 'org.kde.StatusNotifierItem'
const SNI_WATCHER = 'org.kde.StatusNotifierWatcher'
const SNI_WATCHER_PATH = '/StatusNotifierWatcher'
const MENU_IFACE = 'com.canonical.dbusmenu'
const PROPS_IFACE = 'org.freedesktop.DBus.Properties'
const ITEM_PATH = '/StatusNotifierItem'
const MENU_PATH = '/MenuBar'

interface TrayState {
  menu: TrayMenuItem<unknown>[]
  tooltip: string
}

function pixmapBytes(red: number, green: number, blue: number, size = 22): number[] {
  const rows: number[] = []
  for (let index = 0; index < size * size; index++) {
    rows.push(red, green, blue, 255)
  }
  return rows
}

/** Wraps the state with lazy D-Bus startup; safe to destroy before connect. */
export function createLinuxTray<WebSocketData = undefined>(
  options: DesktopTrayOptions<WebSocketData>,
  callbacks: { onActivate: () => void; onMenuClick: (item: TrayMenuItem<WebSocketData>) => void },
): TrayController<WebSocketData> | null {
  let controller: TrayController<WebSocketData> | null = null
  let pendingMenu: TrayMenuItem<WebSocketData>[] = options.menu ?? []
  let pendingTooltip = options.tooltip ?? ''
  let destroyed = false
  let startingConnection: DBusConnection | null = null

  // The controller is returned synchronously; the D-Bus connection is
  // established in the background and the item registers when ready.
  void startLinuxTray({
    initialMenu: pendingMenu,
    initialTooltip: pendingTooltip,
    onActivate: callbacks.onActivate,
    onMenuClick: callbacks.onMenuClick,
    isCancelled: () => destroyed,
    onConnection: (connection) => {
      startingConnection = connection
      if (destroyed) connection.close()
    },
  }).then((created) => {
    startingConnection = null
    if (destroyed) {
      created?.destroy()
      return
    }
    controller = created
    if (created) {
      if (pendingMenu !== created.options.menu) created.update({ menu: pendingMenu as TrayMenuItem<unknown>[] })
      if (pendingTooltip !== created.options.tooltip) created.update({ tooltip: pendingTooltip })
    }
  })

  return {
    update(next) {
      if (next.menu) pendingMenu = next.menu as TrayMenuItem<WebSocketData>[]
      if (next.tooltip !== undefined) pendingTooltip = next.tooltip
      controller?.update(next as Partial<DesktopTrayOptions<unknown>>)
    },
    destroy() {
      destroyed = true
      startingConnection?.close()
      startingConnection = null
      controller?.destroy()
      controller = null
    },
  }
}

interface CreatedTray {
  options: DesktopTrayOptions<unknown>
  update(next: Partial<DesktopTrayOptions<unknown>>): void
  destroy(): void
}

async function startLinuxTray(
  args: {
    initialMenu: TrayMenuItem<unknown>[]
    initialTooltip: string
    onActivate: () => void
    onMenuClick: (item: TrayMenuItem<unknown>) => void
    isCancelled: () => boolean
    onConnection: (connection: DBusConnection) => void
  },
): Promise<CreatedTray | null> {
  const { sessionBusAddress } = await import('./dbus')
  const address = sessionBusAddress()
  if (!address) {
    console.warn('[BunDesk] Linux tray skipped: no D-Bus session bus address (DBUS_SESSION_BUS_ADDRESS)')
    return null
  }

  let connection: DBusConnection | undefined
  let revision = 0
  let destroyed = false
  const state: TrayState = {
    menu: args.initialMenu,
    tooltip: args.initialTooltip,
  }

  const itemName = `org.kde.StatusNotifierItem-${process.pid}-1`

  const propertyValue = (name: string): [string, unknown] | null => {
    switch (name) {
      case 'Category': return ['s', 'ApplicationStatus']
      case 'Id': return ['s', `bundesk-${process.pid}`]
      case 'Title': return ['s', state.tooltip]
      case 'Status': return ['s', 'Active']
      case 'IconName': return ['s', 'application-x-executable']
      case 'IconPixmap': return ['a(iiay)', [[22, 22, pixmapBytes(0x36, 0x84, 0xff)]]]
      case 'Menu': return ['o', MENU_PATH]
      case 'ItemIsMenu': return ['b', false]
      case 'ToolTip': return ['(ssa(iiay))', ['', state.tooltip, []]]
      default: return null
    }
  }

  const menuItemProperties = (item: TrayMenuItem<unknown>): [string, [string, unknown]][] => {
    const props: [string, [string, unknown]][] = [
      ['label', ['s', item.separator ? '' : item.label]],
      ['enabled', ['b', item.separator ? false : (item.enabled ?? true)]],
      ['visible', ['b', true]],
    ]
    if (item.separator) props.push(['type', ['s', 'separator']])
    if (item.checked !== undefined) {
      props.push(['toggle-type', ['s', 'checkmark']])
      props.push(['toggle-state', ['i', item.checked ? 1 : 0]])
    }
    return props
  }

  const menuLayout = (): [number, unknown] => {
    const items = state.menu.map((item, index) => ({
      id: index + 1,
      props: menuItemProperties(item),
      children: [] as unknown[],
    }))
    const rootProps: [string, [string, unknown]][] = [['children-display', ['s', 'submenu']]]
    const root = { id: 0, props: rootProps, children: items.map((item) => [item.id, item.props, item.children]) }
    return [revision, [root]]
  }

  const handleMethodCall = async (message: DBusMessage) => {
    if (!connection || message.path !== ITEM_PATH && message.path !== MENU_PATH) return
    const member = message.member ?? ''
    const body = message.body

    if (message.path === ITEM_PATH && message.iface === PROPS_IFACE) {
      if (member === 'Get') {
        const property = String(body[1] ?? '')
        const value = propertyValue(property)
        if (value) connection.reply(message.serial, 'v', [value])
        else connection.sendError(message.serial, 'org.freedesktop.DBus.Error.InvalidArgs', `no property ${property}`)
        return
      }
      if (member === 'GetAll') {
        const entries = (['Category', 'Id', 'Title', 'Status', 'IconName', 'IconPixmap', 'Menu', 'ItemIsMenu', 'ToolTip'] as const)
          .map((name) => [name, propertyValue(name)!] as [string, [string, unknown]])
        connection.reply(message.serial, 'a{sv}', [entries])
        return
      }
    }
    if (message.path === ITEM_PATH && message.iface === SNI_IFACE) {
      if (member === 'Activate' || member === 'SecondaryActivate') {
        args.onActivate()
        connection.reply(message.serial, '', [])
        return
      }
      if (member === 'ContextMenu' || member === 'Scroll') {
        // the host shows the menu itself via dbusmenu
        connection.reply(message.serial, '', [])
        return
      }
    }
    if (message.path === MENU_PATH && message.iface === MENU_IFACE) {
      if (member === 'GetLayout') {
        const [layoutRevision, layout] = menuLayout()
        connection.reply(message.serial, '(ua(ia{sv}av))', [[layoutRevision, layout]])
        return
      }
      if (member === 'GetProperty') {
        const id = Number(body[0] ?? 0)
        const name = String(body[1] ?? '')
        let value: [string, unknown] | null = null
        if (id === 0) {
          if (name === 'children-display') value = ['s', 'submenu']
        } else {
          const item = state.menu[id - 1]
          if (item) {
            value = menuItemProperties(item).find(([key]) => key === name)?.[1] ?? null
          }
        }
        if (value) connection.reply(message.serial, 'v', [value])
        else connection.sendError(message.serial, 'org.freedesktop.DBus.Error.InvalidArgs', `no property ${name}`)
        return
      }
      if (member === 'GetGroupProperties') {
        connection.reply(message.serial, 'a(ia{sv})', [[]])
        return
      }
      if (member === 'AboutToShow' || member === 'AboutToShowGroup') {
        connection.reply(message.serial, 'b', [true])
        return
      }
      if (member === 'Event') {
        const id = Number(body[0] ?? 0)
        const event = String(body[1] ?? '')
        if (event === 'clicked' && id >= 1) {
          const item = state.menu[id - 1]
          if (item) args.onMenuClick(item)
        }
        connection.reply(message.serial, '', [])
        return
      }
    }
  }

  try {
    connection = await connectDBus(address, handleMethodCall)
    args.onConnection(connection)
    if (args.isCancelled()) {
      connection.close()
      return null
    }
  } catch (error) {
    if (args.isCancelled()) return null
    console.warn(`[BunDesk] Linux tray unavailable (${error instanceof Error ? error.message : String(error)})`)
    return null
  }

  try {
    await connection.call(DBUS_IFACE, DBUS_PATH, DBUS_IFACE, 'RequestName', 'su', [itemName, 0])
    if (args.isCancelled()) {
      connection.close()
      return null
    }
    // Tell the watcher (when present) about the item; hosts also discover the
    // well-known name via NameOwnerChanged. The watcher may be absent, in
    // which case the call errors — that's fine, discovery falls back to name
    // watching. The probe is intentionally NOT done first: querying a missing
    // watcher name makes some daemons drop the connection.
    await connection.call(SNI_WATCHER, SNI_WATCHER_PATH, SNI_IFACE, 'RegisterStatusNotifierItem', 's', [itemName])
      .catch(() => {})
    if (args.isCancelled()) {
      connection.close()
      return null
    }
  } catch (error) {
    if (args.isCancelled()) {
      connection.close()
      return null
    }
    console.warn(`[BunDesk] Linux tray registration failed (${error instanceof Error ? error.message : String(error)})`)
    connection.close()
    return null
  }

  const emitLayoutUpdated = () => {
    revision++
    connection?.signal(MENU_PATH, MENU_IFACE, 'LayoutUpdated', 'ui', [revision, 0])
  }

  return {
    options: { menu: state.menu, tooltip: state.tooltip },
    update(next) {
      if (next.menu !== undefined) state.menu = next.menu as TrayMenuItem<unknown>[]
      if (next.tooltip !== undefined) state.tooltip = next.tooltip
      if (!connection || destroyed) return
      if (next.tooltip !== undefined) {
        connection.signal(ITEM_PATH, SNI_IFACE, 'NewToolTip', '', [])
        connection.signal(ITEM_PATH, SNI_IFACE, 'NewTitle', '', [])
      }
      emitLayoutUpdated()
    },
    destroy() {
      destroyed = true
      connection?.close()
      connection = undefined
    },
  }
}
