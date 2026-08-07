import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'
import {
  createMacosAppBundle,
  macosBundleLayout,
  type DesktopMacosOptions,
  type MacosAppBundleResult,
} from './darwin-bundle'

export type WindowsConsoleMode = 'detached' | 'hidden' | 'inherit'

export interface DesktopWindowsOptions {
  console?: WindowsConsoleMode
  icon?: string
  title?: string
  publisher?: string
  version?: string
  description?: string
  copyright?: string
}

export interface WindowsRuntimeOptions {
  /** Use this Bun Windows executable instead of the current runtime or a download. */
  executablePath?: string
  /** Bun release version to download. Defaults to the running Bun version. */
  version?: string
  /** Override the exact ZIP URL, for example with an internal mirror. */
  downloadUrl?: string
  /** Cache directory for downloaded Bun runtimes. */
  cacheDir?: string
  /** Optional SHA-256 of the extracted bun.exe. */
  sha256?: string
}

export type DesktopCompileOptions = Omit<
  Bun.CompileBuildOptions,
  'target' | 'outfile' | 'windows' | 'executablePath'
>

export type DesktopAppConfig = Omit<
  Bun.BuildConfig,
  'entrypoints' | 'compile' | 'target' | 'outdir'
> & {
  root?: string
  entrypoint: string
  outfile: string
  target?: Bun.Build.CompileTarget
  compile?: DesktopCompileOptions
  windows?: DesktopWindowsOptions
  runtime?: WindowsRuntimeOptions
  macos?: DesktopMacosOptions
}

export interface DesktopBuildResult {
  result: Bun.BuildOutput
  outfile: string
  size: number
  sha256: string
  /** Present when the target is `bun-darwin-*` and outfile ends in `.app`. */
  bundle?: MacosAppBundleResult
}

export class DesktopBuildError extends Error {
  readonly logs: readonly (BuildMessage | ResolveMessage)[]

  constructor(logs: readonly (BuildMessage | ResolveMessage)[]) {
    super(logs.map((log) => log.message).join('\n') || 'Bun build failed')
    this.name = 'DesktopBuildError'
    this.logs = logs
  }
}

export function defineConfig<T extends DesktopAppConfig | DesktopAppConfig[]>(config: T): T {
  return config
}

export async function buildDesktopApp(config: DesktopAppConfig): Promise<DesktopBuildResult> {
  const root = resolve(config.root ?? process.cwd())
  const target = config.target ?? 'bun-windows-x64'
  const isWindowsTarget = target.startsWith('bun-windows-')
  const isDarwinTarget = target.startsWith('bun-darwin-')
  if (!isWindowsTarget && (config.windows || config.runtime)) {
    throw new Error('windows and runtime options require a bun-windows-* target')
  }
  if (config.macos && !isDarwinTarget) {
    throw new Error('macos options require a bun-darwin-* target')
  }
  if (isDarwinTarget && config.macos && !config.outfile.toLowerCase().endsWith('.app')) {
    throw new Error('macos options require an outfile ending in .app')
  }

  const entrypoint = resolveFrom(root, config.entrypoint)
  const requestedOutput = resolveFrom(root, config.outfile)
  const outfile = isWindowsTarget && !requestedOutput.toLowerCase().endsWith('.exe')
    ? `${requestedOutput}.exe`
    : requestedOutput
  const darwinLayout = isDarwinTarget && outfile.toLowerCase().endsWith('.app')
    ? macosBundleLayout(outfile)
    : null
  const compileOutfile = darwinLayout?.executablePath ?? outfile
  await mkdir(dirname(compileOutfile), { recursive: true })

  const {
    root: _root,
    entrypoint: _entrypoint,
    outfile: _outfile,
    target: _target,
    compile: compileOptions,
    windows: windowsOptions,
    runtime: runtimeOptions,
    macos: macosOptions,
    ...buildOptions
  } = config

  const compile: Bun.CompileBuildOptions = {
    autoloadBunfig: false,
    autoloadDotenv: false,
    ...compileOptions,
    target,
    outfile: compileOutfile,
  }

  let temporaryDirectory: string | undefined
  try {
    if (isWindowsTarget) {
      const windows = windowsOptions ?? {}
      const consoleMode = windows.console ?? 'detached'
      if (consoleMode === 'hidden') {
        compile.windows = { hideConsole: true }
      }

      const needsPatchedRuntime = consoleMode === 'detached' || hasWindowsMetadata(windows)
      if (needsPatchedRuntime) {
        const runtimePath = await resolveWindowsRuntime(root, target, runtimeOptions ?? {})
        const runtimeBytes = await Bun.file(runtimePath).arrayBuffer()
        const patchedBytes = await patchWindowsRuntime(runtimeBytes, {
          ...windows,
          console: consoleMode,
          icon: windows.icon ? resolveFrom(root, windows.icon) : undefined,
        }, outfile)
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'bundesk-'))
        const patchedRuntimePath = join(temporaryDirectory, 'bun.exe')
        await Bun.write(patchedRuntimePath, patchedBytes)
        compile.executablePath = patchedRuntimePath
      }
    }

    const result = await Bun.build({
      ...buildOptions,
      entrypoints: [entrypoint],
      compile,
    })
    if (!result.success) throw new DesktopBuildError(result.logs)

    const output = Bun.file(compileOutfile)
    if (!(await output.exists())) throw new Error(`Bun reported success but did not create ${compileOutfile}`)
    const bytes = await output.arrayBuffer()

    let bundle: MacosAppBundleResult | undefined
    if (darwinLayout) {
      bundle = await createMacosAppBundle({
        bundlePath: darwinLayout.bundlePath,
        executablePath: darwinLayout.executablePath,
        executableName: darwinLayout.executableName,
        macos: macosOptions ?? {},
        version: macosOptions?.version ?? '1.0.0',
      })
    }
    return {
      result,
      outfile,
      size: bytes.byteLength,
      sha256: digest(bytes),
      bundle,
    }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

function hasWindowsMetadata(options: DesktopWindowsOptions): boolean {
  return Boolean(
    options.icon ||
    options.title ||
    options.publisher ||
    options.version ||
    options.description ||
    options.copyright
  )
}

async function resolveWindowsRuntime(
  root: string,
  target: Bun.Build.CompileTarget,
  options: WindowsRuntimeOptions,
): Promise<string> {
  if (options.executablePath) return resolveFrom(root, options.executablePath)

  if (canUseCurrentRuntime(target)) return process.execPath

  const version = (options.version ?? Bun.version).replace(/^bun-v|^v/, '')
  const assetName = windowsRuntimeAsset(target)
  const cacheRoot = options.cacheDir
    ? resolveFrom(root, options.cacheDir)
    : defaultCacheDirectory()
  const runtimePath = join(cacheRoot, `bun-v${version}-${assetName}.exe`)
  const cached = Bun.file(runtimePath)
  if (await cached.exists()) {
    await verifyRuntime(cached, options.sha256)
    return runtimePath
  }

  const url = options.downloadUrl ??
    `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${assetName}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download Bun runtime (${response.status} ${response.statusText}): ${url}`)

  const reader = new ZipReader(new BlobReader(await response.blob()))
  try {
    const entries = await reader.getEntries()
    const executable = entries.find((entry) => entry.filename.endsWith('/bun.exe') || entry.filename === 'bun.exe')
    if (!executable || !('getData' in executable)) {
      throw new Error(`Downloaded archive does not contain bun.exe: ${url}`)
    }
    const blob = await executable.getData(new BlobWriter())
    await verifyRuntime(blob, options.sha256)
    await mkdir(cacheRoot, { recursive: true })
    await Bun.write(runtimePath, blob)
  } finally {
    await reader.close()
  }
  return runtimePath
}

function canUseCurrentRuntime(target: Bun.Build.CompileTarget): boolean {
  const executableName = basename(process.execPath).toLowerCase()
  if (process.platform !== 'win32' || !['bun.exe', 'bun-debug.exe'].includes(executableName)) return false
  if (process.arch === 'x64') return target === 'bun-windows-x64'
  if (process.arch === 'arm64') return target === 'bun-windows-arm64'
  return false
}

function windowsRuntimeAsset(target: Bun.Build.CompileTarget): string {
  switch (target) {
    case 'bun-windows-x64':
    case 'bun-windows-x64-modern':
      return 'bun-windows-x64'
    case 'bun-windows-x64-baseline':
      return 'bun-windows-x64-baseline'
    case 'bun-windows-arm64':
      return 'bun-windows-arm64'
    default:
      throw new Error(`Unsupported Windows target: ${target}`)
  }
}

function defaultCacheDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BunDesk', 'runtimes')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'bundesk', 'runtimes')
}

async function verifyRuntime(file: Blob, expected: string | undefined): Promise<void> {
  if (!expected) return
  const actual = digest(await file.arrayBuffer())
  if (actual !== expected.replace(/^sha256:/i, '').toLowerCase()) {
    throw new Error(`Bun runtime SHA-256 mismatch: expected ${expected}, received ${actual}`)
  }
}

async function patchWindowsRuntime(
  bytes: ArrayBuffer,
  options: DesktopWindowsOptions,
  outfile: string,
): Promise<ArrayBuffer> {
  const executable = NtExecutable.from(bytes, { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const language = 0x0409
  const codepage = 1200

  if (options.icon) {
    const iconFile = Data.IconFile.from(await Bun.file(options.icon).arrayBuffer())
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      'IDI_APP_ICON',
      language,
      iconFile.icons.map((icon) => icon.data),
    )
  }

  if (hasWindowsMetadata(options)) {
    const versionInfo = Resource.VersionInfo.fromEntries(resources.entries)[0]
    if (!versionInfo) throw new Error('Bun runtime does not contain a Windows version resource')

    if (options.version) {
      versionInfo.setFileVersion(...numericVersion(options.version), language)
    }
    versionInfo.setStringValues(
      { lang: language, codepage },
      compactRecord({
        FileDescription: options.description,
        FileVersion: options.version,
        InternalName: options.title,
        OriginalFilename: basename(outfile),
        ProductName: options.title,
        ProductVersion: options.version,
        CompanyName: options.publisher,
        LegalCopyright: options.copyright,
      }),
    )
    versionInfo.outputToResourceEntries(resources.entries)
  }

  if (options.console === 'detached') {
    const manifest = resources.getResourceEntriesAsString(24, 1)[0]
    if (!manifest) throw new Error('Bun runtime does not contain an application manifest')
    resources.replaceResourceEntryFromString(
      24,
      1,
      language,
      injectDetachedConsolePolicy(manifest[1]),
    )
  }

  resources.outputResource(executable)
  return executable.generate()
}

function numericVersion(version: string): [number, number, number, number] {
  const parts = version.match(/\d+/g)?.slice(0, 4).map(Number) ?? []
  return [0, 1, 2, 3].map((index) => Math.min(parts[index] ?? 0, 65_535)) as [number, number, number, number]
}

function compactRecord(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function injectDetachedConsolePolicy(xml: string): string {
  const namespace = 'http://schemas.microsoft.com/SMI/2024/WindowsSettings'
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagNameNS(namespace, 'consoleAllocationPolicy').length > 0) return xml

  const nodes = document.getElementsByTagName('*')
  let application: Element | undefined
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes.item(index)
    if (node?.localName === 'application') {
      application = node
      break
    }
  }
  if (!application) throw new Error('Bun application manifest does not contain an application element')

  let windowsSettings: Element | undefined
  for (let index = 0; index < application.childNodes.length; index++) {
    const child = application.childNodes.item(index)
    if (child?.nodeType === 1 && (child as Element).localName === 'windowsSettings') {
      windowsSettings = child as Element
      break
    }
  }
  if (!windowsSettings) {
    const prefix = application.prefix ? `${application.prefix}:` : ''
    windowsSettings = document.createElementNS(
      'http://schemas.microsoft.com/SMI/2005/WindowsSettings',
      `${prefix}windowsSettings`,
    )
    application.appendChild(windowsSettings)
  }

  const policy = document.createElementNS(namespace, 'consoleAllocationPolicy')
  policy.textContent = 'detached'
  windowsSettings.appendChild(policy)
  return new XMLSerializer().serializeToString(document)
}

function digest(bytes: ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

export * from './runtime/actions'
export * from './runtime/app'
export * from './runtime/environment'
export * from './runtime/browser'
export * from './runtime/linux-integration'
export * from './runtime/notifications'
export * from './runtime/paths'
export * from './runtime/platform'
export * from './runtime/service-integration'
export * from './runtime/single-instance'
export * from './runtime/tray'
export * from './runtime/tray-linux'
export * from './runtime/tray-win32'
export * from './runtime/updater'
export * from './runtime/webview2'
export * from './runtime/webkit'
export * from './runtime/windows-integration'
export type {
  DesktopMacosOptions,
  MacosAppBundleResult,
  MacosDocumentTypeOptions,
  MacosUrlTypeOptions,
} from './darwin-bundle'
