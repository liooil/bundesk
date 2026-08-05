import { join, resolve } from 'node:path'

export interface FileAssociationOptions {
  extension: `.${string}`
  progId: string
  description: string
  icon?: string
}

export interface StartMenuShortcutOptions {
  name: string
  description?: string
  icon?: string
}

export interface WindowsIntegrationOptions {
  executablePath?: string
  fileAssociations?: FileAssociationOptions[]
  startMenuShortcut?: StartMenuShortcutOptions | false
}

export interface FileAssociationStatus {
  extension: string
  progId: string
  registered: boolean
  defaultForCurrentUser: boolean
  openCommand: string | null
}

export interface WindowsIntegrationStatus {
  supported: boolean
  executablePath: string
  fileAssociations: FileAssociationStatus[]
  startMenuShortcut: {
    configured: boolean
    path: string | null
    exists: boolean
  }
}

export interface WindowsIntegrationResult {
  ok: boolean
  changed: boolean
  details: string[]
}

const classesRoot = 'HKCU\\Software\\Classes'

export async function registerWindowsIntegration(
  options: WindowsIntegrationOptions,
  settings: { makeDefault?: boolean; dryRun?: boolean } = {},
): Promise<WindowsIntegrationResult> {
  if (process.platform !== 'win32') return unsupportedResult()
  const executablePath = resolve(options.executablePath ?? process.execPath)
  const details: string[] = []

  for (const association of options.fileAssociations ?? []) {
    validateFileAssociation(association)
    const extensionKey = `${classesRoot}\\${association.extension}`
    const progIdKey = `${classesRoot}\\${association.progId}`
    const icon = association.icon ? resolve(association.icon) : executablePath
    const commands = [
      ['add', progIdKey, '/ve', '/d', association.description, '/f'],
      ['add', `${progIdKey}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f'],
      ['add', `${progIdKey}\\shell\\open\\command`, '/ve', '/d', `"${executablePath}" "%1"`, '/f'],
      ['add', `${extensionKey}\\OpenWithProgids`, '/v', association.progId, '/t', 'REG_NONE', '/d', '', '/f'],
    ]
    if (settings.makeDefault) commands.push(['add', extensionKey, '/ve', '/d', association.progId, '/f'])
    for (const command of commands) {
      const result = await runRegistry(command, settings.dryRun)
      details.push(result.detail)
      if (!result.ok) return { ok: false, changed: false, details }
    }
  }

  if (options.startMenuShortcut) {
    const shortcut = await writeStartMenuShortcut(executablePath, options.startMenuShortcut, settings.dryRun)
    details.push(shortcut.detail)
    if (!shortcut.ok) return { ok: false, changed: false, details }
  }
  if (!settings.dryRun) await notifyAssociationChanged()
  return { ok: true, changed: true, details }
}

export async function unregisterWindowsIntegration(
  options: WindowsIntegrationOptions,
  settings: { dryRun?: boolean } = {},
): Promise<WindowsIntegrationResult> {
  if (process.platform !== 'win32') return unsupportedResult()
  const details: string[] = []

  for (const association of options.fileAssociations ?? []) {
    validateFileAssociation(association)
    const extensionKey = `${classesRoot}\\${association.extension}`
    const currentDefault = await queryRegistryDefault(extensionKey)
    const commands = [
      ['delete', `${extensionKey}\\OpenWithProgids`, '/v', association.progId, '/f'],
      ['delete', `${classesRoot}\\${association.progId}`, '/f'],
    ]
    if (currentDefault === association.progId) commands.push(['delete', extensionKey, '/ve', '/f'])
    for (const command of commands) {
      const result = await runRegistry(command, settings.dryRun, true)
      details.push(result.detail)
      if (!result.ok) return { ok: false, changed: false, details }
    }
  }

  if (options.startMenuShortcut) {
    const shortcutPath = getShortcutPath(options.startMenuShortcut.name)
    if (settings.dryRun) {
      details.push(`[dry-run] remove ${shortcutPath}`)
    } else {
      await Bun.file(shortcutPath).delete().catch(() => undefined)
      details.push(`Removed ${shortcutPath}`)
    }
  }
  if (!settings.dryRun) await notifyAssociationChanged()
  return { ok: true, changed: true, details }
}

export async function getWindowsIntegrationStatus(
  options: WindowsIntegrationOptions,
): Promise<WindowsIntegrationStatus> {
  const executablePath = resolve(options.executablePath ?? process.execPath)
  if (process.platform !== 'win32') {
    return {
      supported: false,
      executablePath,
      fileAssociations: [],
      startMenuShortcut: { configured: Boolean(options.startMenuShortcut), path: null, exists: false },
    }
  }

  const fileAssociations = await Promise.all((options.fileAssociations ?? []).map(async (association) => {
    validateFileAssociation(association)
    const extensionKey = `${classesRoot}\\${association.extension}`
    const openCommand = await queryRegistryDefault(`${classesRoot}\\${association.progId}\\shell\\open\\command`)
    const currentDefault = await queryRegistryDefault(extensionKey)
    return {
      extension: association.extension,
      progId: association.progId,
      registered: Boolean(openCommand?.toLowerCase().includes(executablePath.toLowerCase())),
      defaultForCurrentUser: currentDefault === association.progId,
      openCommand,
    }
  }))
  const shortcutPath = options.startMenuShortcut ? getShortcutPath(options.startMenuShortcut.name) : null
  return {
    supported: true,
    executablePath,
    fileAssociations,
    startMenuShortcut: {
      configured: Boolean(options.startMenuShortcut),
      path: shortcutPath,
      exists: shortcutPath ? await Bun.file(shortcutPath).exists() : false,
    },
  }
}

export function validateFileAssociation(options: FileAssociationOptions): void {
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.extension)) {
    throw new Error(`Invalid file extension: ${options.extension}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(options.progId)) {
    throw new Error(`Invalid ProgID: ${options.progId}`)
  }
}

export async function runRegistry(
  args: string[],
  dryRun = false,
  allowMissing = false,
): Promise<{ ok: boolean; detail: string }> {
  if (dryRun) return { ok: true, detail: `[dry-run] reg.exe ${args.join(' ')}` }
  const process = Bun.spawn(['reg.exe', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  const missing = allowMissing && exitCode === 1
  const output = (stderr || stdout).trim()
  return {
    ok: exitCode === 0 || missing,
    detail: exitCode === 0 ? `reg.exe ${args[0]} succeeded` : missing ? `Registry value was already absent` : output,
  }
}

async function queryRegistryDefault(key: string): Promise<string | null> {
  const process = Bun.spawn(['reg.exe', 'query', key, '/ve'], {
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ])
  if (exitCode !== 0) return null
  return stdout.match(/REG_\w+\s+(.+)$/m)?.[1]?.trim() ?? null
}

async function writeStartMenuShortcut(
  executablePath: string,
  options: StartMenuShortcutOptions,
  dryRun = false,
): Promise<{ ok: boolean; detail: string }> {
  const shortcutPath = getShortcutPath(options.name)
  if (dryRun) return { ok: true, detail: `[dry-run] create ${shortcutPath}` }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcut = $shell.CreateShortcut($env:BUN_DESKTOP_SHORTCUT_PATH)',
    '$shortcut.TargetPath = $env:BUN_DESKTOP_EXECUTABLE',
    '$shortcut.WorkingDirectory = Split-Path -Parent $env:BUN_DESKTOP_EXECUTABLE',
    '$shortcut.IconLocation = $env:BUN_DESKTOP_ICON',
    '$shortcut.Description = $env:BUN_DESKTOP_DESCRIPTION',
    '$shortcut.Save()',
  ].join('; ')
  const process = Bun.spawn(['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: {
      ...processEnv(),
      BUN_DESKTOP_SHORTCUT_PATH: shortcutPath,
      BUN_DESKTOP_EXECUTABLE: executablePath,
      BUN_DESKTOP_ICON: `${options.icon ? resolve(options.icon) : executablePath},0`,
      BUN_DESKTOP_DESCRIPTION: options.description ?? options.name,
    },
  })
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  return { ok: exitCode === 0, detail: exitCode === 0 ? `Created ${shortcutPath}` : stderr.trim() }
}

async function notifyAssociationChanged(): Promise<void> {
  const script = [
    "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);'",
    '[Win32.NativeMethods]::SHChangeNotify(0x08000000, 0x1000, [System.IntPtr]::Zero, [System.IntPtr]::Zero)',
  ].join('; ')
  const process = Bun.spawn(['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script], {
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  })
  await process.exited
}

function getShortcutPath(name: string): string {
  const safeName = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '')
  if (!safeName) throw new Error('Start menu shortcut name is empty after sanitization')
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set')
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${safeName}.lnk`)
}

function unsupportedResult(): WindowsIntegrationResult {
  return { ok: false, changed: false, details: ['Windows integration is only supported on Windows'] }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
