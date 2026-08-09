import { createLinuxTray } from '../../src/runtime/tray-linux'

const tray = createLinuxTray(
  { tooltip: 'fast-stop', menu: [{ label: 'Item' }] },
  { onActivate: () => {}, onMenuClick: () => {} },
)
tray?.destroy()
