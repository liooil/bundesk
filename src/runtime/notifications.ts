import { isTermux } from './platform'

/**
 * System notifications.
 *
 * | Platform | Mechanism | Notes |
 * | --- | --- | --- |
 * | Windows | WinRT toast via a PowerShell bridge | Classic `Shell_NotifyIcon` balloons are suppressed on Windows 10/11 (verified: NIM_MODIFY returns success but nothing is shown); toasts are the supported path |
 * | Linux | `notify-send` (libnotify) | display only |
 * | macOS | `osascript` display notification | display only |
 * | Termux | `termux-notification` (termux-api) | display only |
 *
 * Click/activation callbacks require an AppUserModelID registration (a Start
 * Menu shortcut carrying the AUMID) and are not implemented yet.
 */

export interface DesktopNotificationOptions {
  title?: string
  body?: string
  /** Linux: icon path for notify-send. Windows/macOS: unused. */
  icon?: string
}

export interface NotifierDeps {
  /** Windows: AppUserModelID to attribute the toast to. */
  aumid?: string
}

const windowsPowerShellAumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}'

export function windowsToastScript(aumid: string): string {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$title = $env:BUN_DESKTOP_TOAST_TITLE',
    '$body = $env:BUN_DESKTOP_TOAST_BODY',
    'if ([string]::IsNullOrEmpty($body)) {',
    '  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText01)',
    '} else {',
    '  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '}',
    '$texts = $xml.GetElementsByTagName("text")',
    '$texts.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null',
    'if ($texts.Length -gt 1) { $texts.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null }',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid}').Show($toast)`,
  ].join('\n')
}

export async function notifySystem(
  options: DesktopNotificationOptions,
  deps: NotifierDeps = {},
): Promise<boolean> {
  if (process.platform === 'win32') {
    const aumid = deps.aumid ?? windowsPowerShellAumid
    return runCommand(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsToastScript(aumid)], {
      BUN_DESKTOP_TOAST_TITLE: options.title ?? '',
      BUN_DESKTOP_TOAST_BODY: options.body ?? '',
    })
  }

  if (isTermux()) {
    const args = ['termux-notification']
    if (options.title) args.push('--title', options.title)
    if (options.body) args.push('--content', options.body)
    if (args.length === 1) return false
    return runCommand(args)
  }

  if (process.platform === 'linux') {
    const args = ['notify-send']
    if (options.icon) args.push('-i', options.icon)
    if (options.title) args.push(options.title)
    if (options.body) args.push(options.body)
    if (args.length === 1) return false
    return runCommand(args)
  }

  if (process.platform === 'darwin') {
    let script = `display notification ${quoteAppleScript(options.body ?? '')}`
    if (options.title) script += ` with title ${quoteAppleScript(options.title)}`
    return runCommand(['osascript', '-e', script])
  }

  return false
}

async function runCommand(args: string[], env: Record<string, string> = {}): Promise<boolean> {
  let proc
  try {
    proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...env } })
  } catch {
    return false
  }
  return (await proc.exited) === 0
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
