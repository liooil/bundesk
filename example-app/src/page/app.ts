/** Frontend of the example page (bundled by the fullstack pipeline). */

interface AppInfo {
  id: string
  version: string
  env: string
  platform: string
  provider: string
}

// The in-process providers ('webview'/'webkit') inject window.chrome.webview;
// the 'browser' provider has no bridge, so the page degrades gracefully.
const bridge = (window as { chrome?: { webview?: { postMessage(value: unknown): void } } }).chrome?.webview

function setText(id: string, value: string): void {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

const info = await fetch('/api/info').then((response) => response.json()) as AppInfo
setText('app-id', info.id)
setText('app-version', info.version)
setText('app-env', info.env)
setText('app-platform', info.platform)
setText('app-provider', info.provider)
setText('bridge-state', bridge ? 'window.chrome.webview — connected' : 'none (browser provider)')

const notifyButton = document.getElementById('notify') as HTMLButtonElement | null
if (notifyButton) {
  notifyButton.disabled = !bridge
  notifyButton.addEventListener('click', () => {
    bridge?.postMessage({ type: 'notify' })
  })
}

document.getElementById('reload')?.addEventListener('click', () => window.location.reload())

export {}
