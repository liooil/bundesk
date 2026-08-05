import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface MacosDocumentTypeOptions {
  extension: `.${string}`
  name: string
  /** UTI for the type; defaults to `<bundleIdentifier>.<extension>` and is exported for the OS. */
  identifier?: string
  role?: 'Editor' | 'Viewer'
}

export interface MacosUrlTypeOptions {
  scheme: string
  name?: string
}

export interface DesktopMacosOptions {
  bundleIdentifier?: string
  displayName?: string
  /** Path to an .icns icon; copied into the bundle's Resources. */
  icon?: string
  version?: string
  minimumSystemVersion?: string
  documentTypes?: MacosDocumentTypeOptions[]
  urlTypes?: MacosUrlTypeOptions[]
  /** True for background-only apps: no Dock icon, no menu bar. */
  background?: boolean
  /**
   * codesign identity for `codesign --force --deep -s <identity>`.
   * Defaults to ad-hoc (`-`) when building on macOS; set `false` to skip.
   * Cross-compiled bundles are not signed and must be signed on a Mac before
   * distribution (Gatekeeper/notarization).
   */
  codesign?: string | false
}

export interface MacosAppBundleResult {
  appPath: string
  executablePath: string
  infoPlistPath: string
  signed: boolean
  codesignIdentity?: string
}

export async function createMacosAppBundle(options: {
  bundlePath: string
  executablePath: string
  executableName: string
  macos: DesktopMacosOptions
  version: string
}): Promise<MacosAppBundleResult> {
  const resourcesDirectory = join(options.bundlePath, 'Contents', 'Resources')
  await mkdir(resourcesDirectory, { recursive: true })

  let iconFile: string | undefined
  if (options.macos.icon) {
    if (!options.macos.icon.toLowerCase().endsWith('.icns')) {
      throw new Error(`macos.icon must be an .icns file: ${options.macos.icon}`)
    }
    iconFile = 'AppIcon.icns'
    await Bun.write(join(resourcesDirectory, iconFile), Bun.file(options.macos.icon))
  }

  const infoPlistPath = join(options.bundlePath, 'Contents', 'Info.plist')
  await writeFile(infoPlistPath, renderInfoPlist({ ...options, iconFile }), 'utf8')

  const codesign = options.macos.codesign
  if (codesign === false || process.platform !== 'darwin') {
    return {
      appPath: options.bundlePath,
      executablePath: options.executablePath,
      infoPlistPath,
      signed: false,
    }
  }

  const identity = codesign ?? '-'
  const codesignProcess = Bun.spawn(['codesign', '--force', '--deep', '-s', identity, options.bundlePath], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([
    codesignProcess.exited,
    new Response(codesignProcess.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`codesign failed (${exitCode}): ${stderr.trim() || options.bundlePath}`)
  }
  return {
    appPath: options.bundlePath,
    executablePath: options.executablePath,
    infoPlistPath,
    signed: true,
    codesignIdentity: identity,
  }
}

function renderInfoPlist(options: {
  executableName: string
  macos: DesktopMacosOptions
  version: string
  iconFile?: string
}): string {
  const { macos, executableName, version } = options
  const bundleIdentifier = macos.bundleIdentifier ??
    `com.example.${executableName.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`
  const displayName = macos.displayName ?? executableName
  const documentTypes = macos.documentTypes ?? []
  const urlTypes = macos.urlTypes ?? []

  const baseEntries: Array<[string, string]> = [
    ['CFBundleExecutable', executableName],
    ['CFBundleIdentifier', bundleIdentifier],
    ['CFBundleName', displayName],
    ['CFBundleDisplayName', displayName],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
  ]
  const entries = baseEntries.map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`)

  const minimumSystemVersion = macos.minimumSystemVersion
  if (minimumSystemVersion) {
    entries.push(`<key>LSMinimumSystemVersion</key><string>${escapeXml(minimumSystemVersion)}</string>`)
  }
  entries.push('<key>NSHighResolutionCapable</key><true/>')
  const iconName = options.iconFile?.replace(/\.icns$/i, '')
  if (iconName) {
    entries.push(`<key>CFBundleIconFile</key><string>${escapeXml(iconName)}</string>`)
  }
  if (macos.background) {
    entries.push('<key>LSUIElement</key><true/>')
  }

  if (documentTypes.length > 0) {
    const exported: string[] = []
    const types: string[] = []
    for (const document of documentTypes) {
      const uti = document.identifier ?? `${bundleIdentifier}.${document.extension.slice(1).toLowerCase()}`
      const role = document.role ?? 'Editor'
      exported.push([
        '<dict>',
        '<key>UTTypeIdentifier</key>',
        `<string>${escapeXml(uti)}</string>`,
        '<key>UTTypeDescription</key>',
        `<string>${escapeXml(document.name)}</string>`,
        '<key>UTTypeConformsTo</key>',
        '<array><string>public.data</string></array>',
        '<key>UTTypeTagSpecification</key>',
        '<dict>',
        '<key>public.filename-extension</key>',
        `<array><string>${escapeXml(document.extension.slice(1))}</string></array>`,
        '</dict>',
        '</dict>',
      ].join(''))
      types.push([
        '<dict>',
        '<key>CFBundleTypeName</key>',
        `<string>${escapeXml(document.name)}</string>`,
        '<key>CFBundleTypeRole</key>',
        `<string>${role}</string>`,
        '<key>LSItemContentTypes</key>',
        `<array><string>${escapeXml(uti)}</string></array>`,
        '</dict>',
      ].join(''))
    }
    entries.push('<key>UTExportedTypeDeclarations</key>', `<array>${exported.join('')}</array>`)
    entries.push('<key>CFBundleDocumentTypes</key>', `<array>${types.join('')}</array>`)
  }

  if (urlTypes.length > 0) {
    const types = urlTypes.map((urlType) => [
      '<dict>',
      '<key>CFBundleURLName</key>',
      `<string>${escapeXml(urlType.name ?? urlType.scheme)}</string>`,
      '<key>CFBundleURLSchemes</key>',
      `<array><string>${escapeXml(urlType.scheme)}</string></array>`,
      '</dict>',
    ].join(''))
    entries.push('<key>CFBundleURLTypes</key>', `<array>${types.join('')}</array>`)
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries,
    '</dict>',
    '</plist>',
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

export function macosBundleLayout(outfile: string): {
  bundlePath: string
  executablePath: string
  executableName: string
} {
  const bundlePath = outfile.replace(/\.app$/i, '') + '.app'
  const executableName = basename(bundlePath).replace(/\.app$/i, '')
  return {
    bundlePath,
    executablePath: join(bundlePath, 'Contents', 'MacOS', executableName),
    executableName,
  }
}
