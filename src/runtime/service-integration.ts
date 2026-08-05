import { homedir } from 'node:os'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getAppDataDirectory, validateAppId } from './paths'
import { isTermux } from './platform'
import { runRegistry } from './windows-integration'

/**
 * Register a BunDesk app as an always-on headless service.
 *
 * The service runs `"<exe>" serve --no-browser`: the HTTP/API layer stays up
 * without a window, and interactive launches forward to it through the
 * single-instance IPC and open a window onto the running server.
 *
 * | Platform | Mechanism | Notes |
 * | --- | --- | --- |
 * | Windows | HKCU Run key (logon auto-start) | A true SCM service needs native `StartServiceCtrlDispatcher`, which Bun cannot provide |
 * | Linux | systemd user unit | `~/.config/systemd/user/<appId>.service` |
 * | macOS | launchd LaunchAgent | `~/Library/LaunchAgents/<appId>.plist` |
 * | Termux | termux-boot script | `~/.termux/boot/<appId>.sh` |
 */

export interface ServiceOptions {
  appId: string
  executablePath?: string
}

export interface ServiceResult {
  ok: boolean
  changed: boolean
  details: string[]
}

export type ServiceKind = 'windows-runkey' | 'systemd-user' | 'launchd-agent' | 'termux-boot'

export interface ServiceStatus {
  supported: boolean
  kind: ServiceKind | null
  installed: boolean
  /** True when a live primary instance owns the app (the service process itself). */
  active: boolean
  /** The registered launch command, as stored by the platform. */
  command: string | null
  details: string[]
}

const serviceArgs = ['serve', '--no-browser']

function serviceCommandLine(executablePath: string): string {
  return `"${executablePath}" ${serviceArgs.join(' ')}`
}

export function renderSystemdUnit(appId: string, executablePath: string): string {
  return [
    '[Unit]',
    `Description=${appId} BunDesk service`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${serviceCommandLine(executablePath)}`,
    `WorkingDirectory=${dirname(executablePath)}`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function renderLaunchdPlist(appId: string, executablePath: string, logDirectory: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>${escapeXml(appId)}</string>
<key>ProgramArguments</key>
<array>
<string>${escapeXml(executablePath)}</string>
<string>serve</string>
<string>--no-browser</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>WorkingDirectory</key><string>${escapeXml(dirname(executablePath))}</string>
<key>StandardOutPath</key><string>${escapeXml(join(logDirectory, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(join(logDirectory, 'service-error.log'))}</string>
</dict>
</plist>
`
}

export function renderTermuxBootScript(executablePath: string): string {
  return `#!/data/data/com.termux/files/usr/bin/sh\nexec "${executablePath}" serve --no-browser\n`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function servicePaths(appId: string, executablePath: string): {
  unitPath: string
  plistPath: string
  bootScriptPath: string
  logDirectory: string
} {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return {
    unitPath: join(configHome, 'systemd', 'user', `${appId}.service`),
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${appId}.plist`),
    bootScriptPath: join(homedir(), '.termux', 'boot', `${appId}.sh`),
    logDirectory: getAppDataDirectory(appId),
  }
}

async function runCommand(
  args: string[],
  failureMessage: string,
): Promise<{ ok: boolean; detail: string }> {
  let proc
  try {
    proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  } catch {
    return { ok: false, detail: failureMessage }
  }
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    return { ok: false, detail: stderr.trim() || failureMessage }
  }
  return { ok: true, detail: `${args.join(' ')} succeeded` }
}

async function isInstanceActive(appId: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(join(getAppDataDirectory(appId), 'instance.json'), 'utf8')) as { pid?: unknown }
    if (!Number.isInteger(record.pid)) return false
    return isProcessAlive(record.pid as number)
  } catch {
    return false
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function currentUserId(): Promise<string> {
  try {
    return String(typeof process.getuid === 'function' ? process.getuid() : 0)
  } catch {
    return '0'
  }
}

// --- Windows: HKCU Run key -------------------------------------------------

const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

async function installWindowsService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const value = serviceCommandLine(executablePath)
  const result = await runRegistry(['add', runKey, '/v', appId, '/t', 'REG_SZ', '/d', value, '/f'], dryRun)
  return {
    ok: result.ok,
    changed: !dryRun && result.ok,
    details: [result.detail, 'Service starts at logon via the HKCU Run key (no admin required)'],
  }
}

async function uninstallWindowsService(appId: string, dryRun: boolean): Promise<ServiceResult> {
  const result = await runRegistry(['delete', runKey, '/v', appId, '/f'], dryRun, true)
  return { ok: result.ok, changed: !dryRun && result.ok, details: [result.detail] }
}

async function statusWindowsService(appId: string): Promise<ServiceStatus> {
  const proc = Bun.spawn(['reg.exe', 'query', runKey, '/v', appId], {
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ])
  const command = stdout.match(/REG_\w+\s+(.+)$/m)?.[1]?.trim() ?? null
  return {
    supported: true,
    kind: 'windows-runkey',
    installed: exitCode === 0,
    active: await isInstanceActive(appId),
    command,
    details: ['Windows registration uses the HKCU Run key; SCM services need native code Bun cannot provide'],
  }
}

// --- Linux: systemd user unit ---------------------------------------------

async function installLinuxService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  if (dryRun) {
    details.push(`[dry-run] write ${paths.unitPath}`)
    details.push('[dry-run] systemctl --user daemon-reload && systemctl --user enable --now')
    return { ok: true, changed: false, details }
  }

  await mkdir(dirname(paths.unitPath), { recursive: true })
  await writeFile(paths.unitPath, renderSystemdUnit(appId, executablePath), 'utf8')
  details.push(`Wrote ${paths.unitPath}`)

  const reload = await runCommand(['systemctl', '--user', 'daemon-reload'], 'systemctl --user daemon-reload failed')
  details.push(reload.detail)
  if (!reload.ok) return { ok: false, changed: true, details }

  const enable = await runCommand(
    ['systemctl', '--user', 'enable', '--now', `${appId}.service`],
    `systemctl --user enable --now ${appId}.service failed`,
  )
  details.push(enable.detail)
  return { ok: enable.ok, changed: true, details }
}

async function uninstallLinuxService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  if (dryRun) {
    details.push(`[dry-run] systemctl --user disable --now ${appId}.service`)
    details.push(`[dry-run] remove ${paths.unitPath}`)
    return { ok: true, changed: false, details }
  }

  const disable = await runCommand(
    ['systemctl', '--user', 'disable', '--now', `${appId}.service`],
    'systemctl --user disable failed (service may not be enabled)',
  )
  details.push(disable.detail)

  await rm(paths.unitPath, { force: true })
  details.push(`Removed ${paths.unitPath}`)

  const reload = await runCommand(['systemctl', '--user', 'daemon-reload'], 'systemctl --user daemon-reload failed')
  details.push(reload.detail)
  return { ok: true, changed: true, details }
}

async function statusLinuxService(appId: string, executablePath: string): Promise<ServiceStatus> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  const unitExists = await Bun.file(paths.unitPath).exists()

  let activeState = 'unknown'
  if (unitExists) {
    const proc = await runCommand(['systemctl', '--user', 'is-active', `${appId}.service`], '')
    activeState = proc.detail.split('\n')[0]?.trim() || 'unknown'
  }
  const enabled = unitExists
    ? (await runCommand(['systemctl', '--user', 'is-enabled', `${appId}.service`], '')).detail.split('\n')[0]?.trim() || 'disabled'
    : 'disabled'
  details.push(`systemd state: ${activeState} / ${enabled}`)

  return {
    supported: true,
    kind: 'systemd-user',
    installed: unitExists,
    active: (activeState === 'active' || activeState === 'activating') || await isInstanceActive(appId),
    command: unitExists ? (await readFile(paths.unitPath, 'utf8').catch(() => '')).match(/^ExecStart=(.+)$/m)?.[1] ?? null : null,
    details,
  }
}

// --- macOS: launchd LaunchAgent -------------------------------------------

async function installMacosService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  if (dryRun) {
    details.push(`[dry-run] write ${paths.plistPath}`)
    details.push('[dry-run] launchctl bootstrap gui/<uid> + enable')
    return { ok: true, changed: false, details }
  }

  await mkdir(dirname(paths.plistPath), { recursive: true })
  await mkdir(paths.logDirectory, { recursive: true })
  await writeFile(paths.plistPath, renderLaunchdPlist(appId, executablePath, paths.logDirectory), 'utf8')
  details.push(`Wrote ${paths.plistPath}`)

  const uid = await currentUserId()
  const bootstrap = await runCommand(
    ['launchctl', 'bootstrap', `gui/${uid}`, paths.plistPath],
    `launchctl bootstrap gui/${uid} failed`,
  )
  if (!bootstrap.ok) {
    const legacy = await runCommand(['launchctl', 'load', '-w', paths.plistPath], 'launchctl load -w failed')
    details.push(legacy.detail)
    return { ok: legacy.ok, changed: true, details }
  }
  details.push(bootstrap.detail)
  const enable = await runCommand(['launchctl', 'enable', `gui/${uid}/${appId}`], `launchctl enable gui/${uid}/${appId} failed`)
  details.push(enable.detail)
  return { ok: enable.ok, changed: true, details }
}

async function uninstallMacosService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  if (dryRun) {
    details.push(`[dry-run] launchctl bootout gui/<uid>/${appId}`)
    details.push(`[dry-run] remove ${paths.plistPath}`)
    return { ok: true, changed: false, details }
  }

  const uid = await currentUserId()
  const bootout = await runCommand(
    ['launchctl', 'bootout', `gui/${uid}/${appId}`],
    'launchctl bootout failed (agent may not be loaded)',
  )
  details.push(bootout.detail)

  await rm(paths.plistPath, { force: true })
  details.push(`Removed ${paths.plistPath}`)
  return { ok: true, changed: true, details }
}

async function statusMacosService(appId: string, executablePath: string): Promise<ServiceStatus> {
  const paths = servicePaths(appId, executablePath)
  const details: string[] = []
  const plistExists = await Bun.file(paths.plistPath).exists()

  const uid = await currentUserId()
  const loaded = await runCommand(
    ['launchctl', 'print', `gui/${uid}/${appId}`],
    `launchctl print gui/${uid}/${appId} failed`,
  )
  details.push(loaded.detail)

  return {
    supported: true,
    kind: 'launchd-agent',
    installed: plistExists,
    active: loaded.ok || await isInstanceActive(appId),
    command: plistExists
      ? (await readFile(paths.plistPath, 'utf8').catch(() => '')).match(/<key>ProgramArguments<\/key>[\s\S]*?<string>(.+?)<\/string>/)?.[1] ?? null
      : null,
    details,
  }
}

// --- Termux: termux-boot script -------------------------------------------

async function installTermuxService(
  appId: string,
  executablePath: string,
  dryRun: boolean,
): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  if (dryRun) {
    return {
      ok: true,
      changed: false,
      details: [`[dry-run] write ${paths.bootScriptPath}`, 'Termux:Boot runs the script at device boot'],
    }
  }
  await mkdir(dirname(paths.bootScriptPath), { recursive: true })
  await writeFile(paths.bootScriptPath, renderTermuxBootScript(executablePath), 'utf8')
  await chmod(paths.bootScriptPath, 0o755)
  return { ok: true, changed: true, details: [`Wrote ${paths.bootScriptPath}`, 'Termux:Boot runs the script at device boot'] }
}

async function uninstallTermuxService(appId: string, executablePath: string, dryRun: boolean): Promise<ServiceResult> {
  const paths = servicePaths(appId, executablePath)
  if (dryRun) {
    return { ok: true, changed: false, details: [`[dry-run] remove ${paths.bootScriptPath}`] }
  }
  await rm(paths.bootScriptPath, { force: true })
  return { ok: true, changed: true, details: [`Removed ${paths.bootScriptPath}`] }
}

async function statusTermuxService(appId: string, executablePath: string): Promise<ServiceStatus> {
  const paths = servicePaths(appId, executablePath)
  const script = await readFile(paths.bootScriptPath, 'utf8').catch(() => null)
  return {
    supported: true,
    kind: 'termux-boot',
    installed: script !== null,
    active: await isInstanceActive(appId),
    command: script?.match(/^exec (.+)$/m)?.[1] ?? null,
    details: ['Termux:Boot runs boot scripts; no service manager is involved'],
  }
}

// --- Public API ------------------------------------------------------------

export async function installService(
  options: ServiceOptions,
  settings: { dryRun?: boolean } = {},
): Promise<ServiceResult> {
  const appId = validateAppId(options.appId)
  const executablePath = resolve(options.executablePath ?? process.execPath)
  if (process.platform === 'win32') return installWindowsService(appId, executablePath, settings.dryRun ?? false)
  if (process.platform === 'linux') return installLinuxService(appId, executablePath, settings.dryRun ?? false)
  if (process.platform === 'darwin') return installMacosService(appId, executablePath, settings.dryRun ?? false)
  if (isTermux()) return installTermuxService(appId, executablePath, settings.dryRun ?? false)
  return { ok: false, changed: false, details: ['Service registration is not supported on this platform'] }
}

export async function uninstallService(
  options: ServiceOptions,
  settings: { dryRun?: boolean } = {},
): Promise<ServiceResult> {
  const appId = validateAppId(options.appId)
  const executablePath = resolve(options.executablePath ?? process.execPath)
  if (process.platform === 'win32') return uninstallWindowsService(appId, settings.dryRun ?? false)
  if (process.platform === 'linux') return uninstallLinuxService(appId, executablePath, settings.dryRun ?? false)
  if (process.platform === 'darwin') return uninstallMacosService(appId, executablePath, settings.dryRun ?? false)
  if (isTermux()) return uninstallTermuxService(appId, executablePath, settings.dryRun ?? false)
  return { ok: false, changed: false, details: ['Service registration is not supported on this platform'] }
}

export async function getServiceStatus(options: ServiceOptions): Promise<ServiceStatus> {
  const appId = validateAppId(options.appId)
  const executablePath = resolve(options.executablePath ?? process.execPath)
  if (process.platform === 'win32') return statusWindowsService(appId)
  if (process.platform === 'linux') return statusLinuxService(appId, executablePath)
  if (process.platform === 'darwin') return statusMacosService(appId, executablePath)
  if (isTermux()) return statusTermuxService(appId, executablePath)
  return {
    supported: false,
    kind: null,
    installed: false,
    active: false,
    command: null,
    details: ['Service registration is not supported on this platform'],
  }
}
