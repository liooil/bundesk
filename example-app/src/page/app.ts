/** Frontend for the BunDesk playground page (bundled by the fullstack pipeline). */

interface PlaygroundInfo {
  id: string
  version: string
  env: string
  platform: string
  arch: string
  provider: string
  url: string | null
  updater: string
  pwa: boolean
}

interface PlaygroundFeature {
  id: string
  name: string
  status: 'active' | 'configured' | 'available' | 'build-config'
  detail: string
  endpoint?: string
  command?: string
}

interface SecondInstanceEvent {
  argv: string[]
  cwd: string
  pid: number
  receivedAt: string
  handledAt: string
}

interface PlaygroundSnapshot {
  info: PlaygroundInfo
  window: {
    provider: string
    kind: string
    capabilities: string[]
    lifecycle: { ownership: string; windowCloseObservable: boolean }
    isClosed: boolean
    attempts: Array<{ provider: string; outcome: string; failure?: string }>
  } | null
  update: {
    provider: string
    currentVersion: string
    checkOnStartup: boolean
    structuralUpdates: boolean
    progress: unknown
  }
  navigation: { success: boolean; errorStatus: number; at: string } | null
  secondInstanceEvents: SecondInstanceEvent[]
  features: PlaygroundFeature[]
  commands: Array<{ command: string; description: string }>
}

// The concrete in-process providers (webview2/webkitgtk) inject the bridge;
// browser-process and external providers do not, so the page degrades gracefully.
const bridge = (window as { chrome?: { webview?: { postMessage(value: unknown): void } } }).chrome?.webview

installPwaHeadLinks()

function installPwaHeadLinks(): void {
  const manifest = document.createElement('link')
  manifest.rel = 'manifest'
  manifest.href = '/manifest.webmanifest'
  const icon = document.createElement('link')
  icon.rel = 'icon'
  icon.href = '/icon-192.png'
  document.head.append(manifest, icon)
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

const snapshot = await fetch('/api/playground').then((response) => response.json()) as PlaygroundSnapshot
const info = snapshot.info

setText('app-id', info.id)
setText('app-version', info.version)
setText('app-env', info.env)
setText('app-platform', `${info.platform} / ${info.arch}`)
setText('app-provider', info.provider)
setText('app-updater', `${info.updater}${snapshot.update.structuralUpdates ? ' + structural' : ''}`)
setText('bridge-state', bridge ? 'window.chrome.webview — connected' : 'none (browser provider; HTTP API still works)')

const notifyBridgeButton = document.getElementById('notify-bridge') as HTMLButtonElement | null
if (notifyBridgeButton) {
  notifyBridgeButton.disabled = !bridge
  notifyBridgeButton.addEventListener('click', () => {
    bridge?.postMessage({ type: 'notify' })
    setNotifyResult('Sent through window.chrome.webview.postMessage.')
  })
}

document.getElementById('notify-api')?.addEventListener('click', () => {
  void (async () => {
    setNotifyResult('Sending notification through /api/notify…')
    const response = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'BunDesk playground', body: 'Notification delivered through context.notify' }),
    })
    const payload = await response.json() as { delivered?: boolean; error?: string }
    setNotifyResult(response.ok
      ? payload.delivered
        ? 'Notification accepted by the platform notifier.'
        : 'Notifier command reported failure (expected on headless systems).'
      : `Notification failed: ${payload.error ?? response.status}`)
  })()
})

document.getElementById('reload')?.addEventListener('click', () => window.location.reload())

document.getElementById('update-check')?.addEventListener('click', () => {
  void (async () => {
    const result = document.getElementById('update-result')
    if (!result) return
    result.textContent = 'Checking the configured update provider…'
    try {
      const response = await fetch('/api/update-check', { method: 'POST' })
      const payload = await response.json() as {
        current?: { version?: string; size: number; sha256: string }
        update?: { version?: string; url: string; size?: number; sha256?: string } | null
        error?: string
      }
      result.textContent = response.ok
        ? JSON.stringify(payload, null, 2)
        : `Update check failed: ${payload.error ?? response.status}`
    } catch (error) {
      result.textContent = `Update check failed: ${error instanceof Error ? error.message : String(error)}`
    }
  })()
})

renderFeatures(snapshot.features)
renderCommands(snapshot.commands)
renderSecondInstanceEvents(snapshot.secondInstanceEvents)

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js')
}

function setNotifyResult(value: string): void {
  setText('notify-result', value)
}

function renderFeatures(features: PlaygroundFeature[]): void {
  const list = document.getElementById('features')
  if (!list) return
  list.replaceChildren(...features.map((feature) => {
    const item = document.createElement('li')
    const label = document.createElement('span')
    const status = document.createElement('code')
    status.className = `status status-${feature.status}`
    status.textContent = feature.status
    const title = document.createElement('strong')
    title.textContent = feature.name
    const detail = document.createElement('span')
    detail.className = 'detail'
    detail.textContent = feature.detail
    label.append(title, detail)
    item.append(status, label)
    if (feature.endpoint) {
      const endpoint = document.createElement('a')
      endpoint.href = feature.endpoint
      endpoint.target = '_blank'
      endpoint.rel = 'noreferrer'
      endpoint.textContent = 'API'
      item.append(endpoint)
    }
    if (feature.command) {
      const command = document.createElement('code')
      command.className = 'command'
      command.textContent = feature.command
      item.append(command)
    }
    return item
  }))
}

function renderCommands(commands: Array<{ command: string; description: string }>): void {
  const list = document.getElementById('commands')
  if (!list) return
  list.replaceChildren(...commands.map((entry) => {
    const item = document.createElement('li')
    const command = document.createElement('code')
    command.textContent = entry.command
    const description = document.createElement('span')
    description.textContent = entry.description
    item.append(command, description)
    return item
  }))
}

function renderSecondInstanceEvents(events: SecondInstanceEvent[]): void {
  const list = document.getElementById('second-instance-events')
  if (!list) return
  if (events.length === 0) return
  list.replaceChildren(...events.map((event) => {
    const item = document.createElement('li')
    const time = document.createElement('time')
    time.dateTime = event.receivedAt
    time.textContent = event.receivedAt
    const argv = document.createElement('code')
    argv.textContent = event.argv.join(' ') || '(no arguments)'
    const meta = document.createElement('span')
    meta.textContent = `pid=${event.pid} cwd=${event.cwd}`
    item.append(time, argv, meta)
    return item
  }))
}

export {}
