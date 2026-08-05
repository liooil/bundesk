import { homedir } from 'node:os'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { validateAppId } from './paths'
import {
  validateFileAssociation,
  type FileAssociationOptions,
  type FileAssociationStatus,
} from './windows-integration'

export interface StartMenuEntryOptions {
  name: string
  description?: string
  icon?: string
}

export interface LinuxIntegrationOptions {
  appId?: string
  executablePath?: string
  fileAssociations?: FileAssociationOptions[]
  startMenuShortcut?: StartMenuEntryOptions | false
}

export interface LinuxIntegrationResult {
  ok: boolean
  changed: boolean
  details: string[]
}

export interface LinuxIntegrationStatus {
  supported: boolean
  executablePath: string
  fileAssociations: FileAssociationStatus[]
  startMenuShortcut: {
    configured: boolean
    path: string | null
    exists: boolean
  }
}

export interface LinuxIntegrationPaths {
  applicationsDirectory: string
  desktopEntryPath: string
  mimePackagePath: string
  mimeappsPath: string
  mimeDatabaseDirectory: string
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

function integrationPaths(options: LinuxIntegrationOptions): LinuxIntegrationPaths {
  const executablePath = resolve(options.executablePath ?? process.execPath)
  const appId = options.appId ?? basename(executablePath).replace(/\.[^.]+$/, '').toLowerCase()
  validateAppId(appId)
  const applicationsDirectory = join(dataHome(), 'applications')
  return {
    applicationsDirectory,
    desktopEntryPath: join(applicationsDirectory, `${appId}.desktop`),
    mimePackagePath: join(dataHome(), 'mime', 'packages', `${appId}.xml`),
    mimeappsPath: join(configHome(), 'mimeapps.list'),
    mimeDatabaseDirectory: join(dataHome(), 'mime'),
  }
}

function mimeTypeFor(progId: string): string {
  const subtype = progId.toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (!subtype) throw new Error(`Invalid ProgID: ${progId}`)
  return `application/x-${subtype}`
}

function desktopEntryContent(
  executablePath: string,
  options: LinuxIntegrationOptions,
  mimeTypes: string[],
): string {
  const shortcut = options.startMenuShortcut === false || options.startMenuShortcut === undefined
    ? undefined
    : options.startMenuShortcut
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${shortcut?.name ?? basename(executablePath)}`,
  ]
  if (shortcut?.description) lines.push(`Comment=${shortcut.description}`)
  lines.push(
    `Exec="${executablePath}" %F`,
    `TryExec=${executablePath}`,
  )
  if (shortcut?.icon) lines.push(`Icon=${resolve(shortcut.icon)}`)
  lines.push('Terminal=false', 'Categories=Utility;')
  if (mimeTypes.length > 0) lines.push(`MimeType=${mimeTypes.map((type) => `${type};`).join('')}`)
  return `${lines.join('\n')}\n`
}

function mimePackageXml(options: LinuxIntegrationOptions): string {
  const entries = (options.fileAssociations ?? []).map((association) => {
    const glob = association.extension.startsWith('.') ? `*${association.extension}` : association.extension
    return [
      `  <mime-type type="${mimeTypeFor(association.progId)}">`,
      `    <comment>${escapeXml(association.description)}</comment>`,
      `    <glob pattern="${glob}"/>`,
      '  </mime-type>',
    ].join('\n')
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    ...entries,
    '</mime-info>',
    '',
  ].join('\n')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

interface MimeappsFile {
  sections: Map<string, string[]>
}

function parseMimeapps(content: string): MimeappsFile {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line
      sections.set(current, [])
    } else if (current && line.length > 0 && !line.startsWith('#')) {
      sections.get(current)?.push(line)
    }
  }
  return { sections }
}

function serializeMimeapps(file: MimeappsFile): string {
  const parts: string[] = []
  for (const [name, lines] of file.sections) {
    if (lines.length === 0) continue
    parts.push(`${name}\n${lines.join('\n')}`)
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : ''
}

async function readMimeapps(path: string): Promise<MimeappsFile> {
  const content = await readFile(path, 'utf8').catch(() => '')
  return parseMimeapps(content)
}

function updateMimeappsEntries(
  file: MimeappsFile,
  associations: FileAssociationOptions[],
  desktopFileName: string,
  makeDefault: boolean,
): void {
  const added = file.sections.get('[Added Associations]') ?? []
  const defaults = file.sections.get('[Default Applications]') ?? []
  const remove = (lines: string[], mime: string, desktopFile: string): string[] =>
    lines.filter((line) => line !== `${mime}=${desktopFile}`)
  const add = (lines: string[], mime: string, desktopFile: string): string[] => {
    if (lines.some((line) => line.startsWith(`${mime}=`) && line.includes(desktopFile))) return lines
    return [...lines, `${mime}=${desktopFile}`]
  }
  for (const association of associations) {
    const mime = mimeTypeFor(association.progId)
    const nextAdded = add(remove(added, mime, desktopFileName), mime, desktopFileName)
    added.splice(0, added.length, ...nextAdded)
    const nextDefaults = makeDefault
      ? add(remove(defaults, mime, desktopFileName), mime, desktopFileName)
      : remove(defaults, mime, desktopFileName)
    defaults.splice(0, defaults.length, ...nextDefaults)
  }
  if (added.length > 0) file.sections.set('[Added Associations]', added)
  else file.sections.delete('[Added Associations]')
  if (defaults.length > 0) file.sections.set('[Default Applications]', defaults)
  else file.sections.delete('[Default Applications]')
}

async function refreshMimeDatabase(directory: string, details: string[]): Promise<void> {
  let mimeProcess
  try {
    mimeProcess = Bun.spawn(['update-mime-database', directory], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    details.push('update-mime-database not found; MIME cache not refreshed')
    return
  }
  const [exitCode, stderr] = await Promise.all([
    mimeProcess.exited,
    new Response(mimeProcess.stderr).text(),
  ])
  if (exitCode !== 0) {
    details.push(stderr.trim() || 'update-mime-database failed; MIME cache not refreshed')
  } else {
    details.push('MIME database refreshed')
  }
}

export async function registerLinuxIntegration(
  options: LinuxIntegrationOptions,
  settings: { makeDefault?: boolean; dryRun?: boolean } = {},
): Promise<LinuxIntegrationResult> {
  const executablePath = resolve(options.executablePath ?? process.execPath)
  const paths = integrationPaths(options)
  const associations = options.fileAssociations ?? []
  const details: string[] = []

  if (associations.length > 0) {
    if (settings.dryRun) {
      details.push(`[dry-run] write ${paths.mimePackagePath}`)
    } else {
      await mkdir(dirname(paths.mimePackagePath), { recursive: true })
      await writeFile(paths.mimePackagePath, mimePackageXml(options), 'utf8')
      details.push(`Wrote ${paths.mimePackagePath}`)
    }
  }

  if (options.startMenuShortcut !== false) {
    const mimeTypes = associations.map((association) => mimeTypeFor(association.progId))
    if (settings.dryRun) {
      details.push(`[dry-run] write ${paths.desktopEntryPath}`)
    } else {
      await mkdir(paths.applicationsDirectory, { recursive: true })
      await writeFile(paths.desktopEntryPath, desktopEntryContent(executablePath, options, mimeTypes), 'utf8')
      details.push(`Wrote ${paths.desktopEntryPath}`)
    }
  }

  if (associations.length > 0) {
    const desktopFileName = basename(paths.desktopEntryPath)
    if (settings.dryRun) {
      details.push(`[dry-run] update ${paths.mimeappsPath}`)
    } else {
      const file = await readMimeapps(paths.mimeappsPath)
      updateMimeappsEntries(file, associations, desktopFileName, settings.makeDefault ?? false)
      const serialized = serializeMimeapps(file)
      if (serialized) {
        await mkdir(dirname(paths.mimeappsPath), { recursive: true })
        await writeFile(paths.mimeappsPath, serialized, 'utf8')
      } else {
        await rm(paths.mimeappsPath, { force: true })
      }
      details.push(`Updated ${paths.mimeappsPath}`)
    }
  }

  if (!settings.dryRun && associations.length > 0) {
    await refreshMimeDatabase(paths.mimeDatabaseDirectory, details)
  }
  return { ok: true, changed: !settings.dryRun, details }
}

export async function unregisterLinuxIntegration(
  options: LinuxIntegrationOptions,
  settings: { dryRun?: boolean } = {},
): Promise<LinuxIntegrationResult> {
  const executablePath = resolve(options.executablePath ?? process.execPath)
  const paths = integrationPaths(options)
  const associations = options.fileAssociations ?? []
  const details: string[] = []

  const removeFile = async (path: string, label: string): Promise<void> => {
    if (settings.dryRun) {
      details.push(`[dry-run] remove ${path}`)
      return
    }
    await rm(path, { force: true })
    details.push(`Removed ${label}`)
  }

  if (associations.length > 0) {
    await removeFile(paths.mimePackagePath, paths.mimePackagePath)
    const desktopFileName = basename(paths.desktopEntryPath)
    if (settings.dryRun) {
      details.push(`[dry-run] update ${paths.mimeappsPath}`)
    } else {
      const file = await readMimeapps(paths.mimeappsPath)
      updateMimeappsEntries(file, associations, desktopFileName, false)
      const serialized = serializeMimeapps(file)
      if (serialized) {
        await writeFile(paths.mimeappsPath, serialized, 'utf8')
      } else {
        await rm(paths.mimeappsPath, { force: true })
      }
      details.push(`Updated ${paths.mimeappsPath}`)
    }
  }

  if (options.startMenuShortcut !== false) {
    await removeFile(paths.desktopEntryPath, paths.desktopEntryPath)
  }

  if (!settings.dryRun && associations.length > 0) {
    await refreshMimeDatabase(paths.mimeDatabaseDirectory, details)
  }
  return { ok: true, changed: !settings.dryRun, details }
}

export async function getLinuxIntegrationStatus(
  options: LinuxIntegrationOptions,
): Promise<LinuxIntegrationStatus> {
  const executablePath = resolve(options.executablePath ?? process.execPath)
  const paths = integrationPaths(options)
  const desktopEntry = await readFile(paths.desktopEntryPath, 'utf8').catch(() => null)
  const mimeapps = await readMimeapps(paths.mimeappsPath)
  const defaults = new Set(mimeapps.sections.get('[Default Applications]') ?? [])
  const added = new Set(mimeapps.sections.get('[Added Associations]') ?? [])
  const desktopFileName = basename(paths.desktopEntryPath)

  const fileAssociations: FileAssociationStatus[] = (options.fileAssociations ?? []).map((association) => {
    validateFileAssociation(association)
    const mime = mimeTypeFor(association.progId)
    const openCommand = desktopEntry?.match(/^Exec=(.+)$/m)?.[1] ?? null
    return {
      extension: association.extension,
      progId: association.progId,
      registered: Boolean(desktopEntry?.includes(`MimeType=`) && (added.has(`${mime}=${desktopFileName}`) || desktopEntry.includes(`${mime};`))),
      defaultForCurrentUser: defaults.has(`${mime}=${desktopFileName}`),
      openCommand,
    }
  })

  const desktopEntryExists = desktopEntry !== null
  return {
    supported: true,
    executablePath,
    fileAssociations,
    startMenuShortcut: {
      configured: options.startMenuShortcut !== false,
      path: paths.desktopEntryPath,
      exists: desktopEntryExists,
    },
  }
}
