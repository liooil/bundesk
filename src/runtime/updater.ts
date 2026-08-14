import { MD5 } from 'bun'
import { open, rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  reconstructStructuralUpdate,
  StructuralRangeUnsupportedError,
  type StructuralReconstructionProgress,
} from '../structural-update'


export interface CurrentExecutable {
  path: string
  version?: string
  size: number
  sha256: string
  etags: string[]
}
export interface StructuralUpdateDescriptor {
  /** Fall back to downloading the complete target when layout reuse, digest verification, or Range requests fail. Defaults to true. */
  fallbackToFull?: boolean
}


export interface UpdateDescriptor {
  version?: string
  url: string
  size?: number
  sha256?: string
  etag?: string
  changelog?: string
  structural?: StructuralUpdateDescriptor
  downloadHeaders?: Record<string, string>
}

export interface UpdateProvider {
  check(current: CurrentExecutable, signal?: AbortSignal, force?: boolean): Promise<UpdateDescriptor | null>
}

export interface StaticBinaryProviderOptions {
  binaryUrl: string
  changelogUrl?: string
  version?: string
  headers?: Record<string, string>
  /** Reuse matching runtime sections without publishing an update index. */
  structuralUpdates?: boolean
  structuralFallbackToFull?: boolean
}

export type PlatformAssetName = string | Partial<Record<
  'windows-x64' | 'windows-arm64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64',
  string
>>

export interface GitHubReleaseProviderOptions {
  owner: string
  repository: string
  assetName: PlatformAssetName
  /** Reuse matching runtime sections without publishing an update index. */
  structuralUpdates?: boolean
  structuralFallbackToFull?: boolean
  token?: string
  apiUrl?: string
  includePrerelease?: boolean
}

export interface UpdaterOptions {
  provider: UpdateProvider
  currentVersion?: string
  targetPath?: string
  restartArgs?: string[]
  allowBunRuntime?: boolean
  onProgress?: (progress: UpdateProgress) => void
}

export interface UpdateProgress {
  phase?: 'planning' | 'inspecting-current' | 'reconstructing' | 'downloading' | 'verifying' | 'installing'
  downloaded: number
  total?: number
  reused?: number
  targetTotal?: number
}

export interface InstalledUpdate {
  descriptor: UpdateDescriptor
  targetPath: string
  backupPath: string
}

export interface UpdateCheckResult {
  current: CurrentExecutable
  update: UpdateDescriptor | null
}

export interface Updater {
  check(signal?: AbortSignal, force?: boolean): Promise<UpdateCheckResult>
  install(update: UpdateDescriptor, signal?: AbortSignal): Promise<InstalledUpdate>
  installAndRestart(update: UpdateDescriptor, signal?: AbortSignal): Promise<InstalledUpdate>
}

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

interface GitHubRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

export function staticBinaryProvider(options: StaticBinaryProviderOptions): UpdateProvider {
  return {
    async check(current, signal, force) {
      const response = await fetch(options.binaryUrl, {
        method: 'HEAD',
        headers: options.headers,
        signal,
      })
      if (!response.ok) {
        throw new Error(`Update HEAD request failed (${response.status} ${response.statusText}): ${options.binaryUrl}`)
      }

      const etag = normalizeEtag(response.headers.get('etag'))
      if (!force && etag && current.etags.includes(etag)) return null
      const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
      const sha256 = response.headers.get('x-checksum-sha256') ?? parseDigestHeader(response.headers.get('digest'))
      let changelog: string | undefined
      if (options.changelogUrl) {
        const changelogResponse = await fetch(options.changelogUrl, { headers: options.headers, signal })
        if (changelogResponse.ok) changelog = await changelogResponse.text()
      }
      return {
        version: options.version,
        url: options.binaryUrl,
        size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
        sha256: sha256?.replace(/^sha256:/i, '').toLowerCase(),
        etag,
        changelog,
        structural: options.structuralUpdates
          ? { fallbackToFull: options.structuralFallbackToFull }
          : undefined,
        downloadHeaders: options.headers,
      }
    },
  }
}

export function githubReleaseProvider(options: GitHubReleaseProviderOptions): UpdateProvider {
  return {
    async check(current, signal, force) {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'BunDesk',
      }
      if (options.token) headers.authorization = `Bearer ${options.token}`
      const apiRoot = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
      const endpoint = options.includePrerelease
        ? `${apiRoot}/repos/${options.owner}/${options.repository}/releases?per_page=20`
        : `${apiRoot}/repos/${options.owner}/${options.repository}/releases/latest`
      const response = await fetch(endpoint, { headers, signal })
      if (!response.ok) {
        throw new Error(`GitHub release request failed (${response.status} ${response.statusText})`)
      }
      const payload = await response.json() as GitHubRelease | GitHubRelease[]
      const release = Array.isArray(payload)
        ? payload.find((item) => !item.draft && (options.includePrerelease || !item.prerelease))
        : payload
      if (!release) return null

      const remoteVersion = release.tag_name.replace(/^v/, '')
      if (!force && current.version && remoteVersion === current.version.replace(/^v/, '')) return null
      const assetName = resolveGitHubAssetName(options.assetName)
      const asset = release.assets.find((candidate) => candidate.name === assetName)
      if (!asset) throw new Error(`GitHub release ${release.tag_name} does not contain asset ${assetName}`)
      const structural = options.structuralUpdates
        ? { fallbackToFull: options.structuralFallbackToFull }
        : undefined
      return {
        version: remoteVersion,
        url: asset.browser_download_url,
        size: asset.size,
        sha256: asset.digest?.replace(/^sha256:/i, '').toLowerCase(),
        changelog: release.body ?? release.name ?? undefined,
        structural,
        downloadHeaders: options.token
          ? { authorization: `Bearer ${options.token}`, 'user-agent': 'BunDesk' }
          : undefined,
      }
    },
  }
}

export function createUpdater(options: UpdaterOptions): Updater {
  const targetPath = options.targetPath ?? process.execPath

  return {
    async check(signal, force) {
      const current = await inspectExecutable(targetPath, options.currentVersion)
      return { current, update: await options.provider.check(current, signal, force) }
    },
    async install(update, signal) {
      assertUpdateTargetSafe(targetPath, options.allowBunRuntime)
      return installUpdate(update, {
        targetPath,
        signal,
        onProgress: options.onProgress,
      })
    },
    async installAndRestart(update, signal) {
      assertUpdateTargetSafe(targetPath, options.allowBunRuntime)
      const installed = await installUpdate(update, {
        targetPath,
        signal,
        onProgress: options.onProgress,
      })
      Bun.spawn({
        cmd: [
          targetPath,
          '--bun-desktop-after-update',
          `--bun-desktop-wait-for-pid=${process.pid}`,
          ...(options.restartArgs ?? process.argv.slice(2)),
        ],
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      }).unref()
      return installed
    },
  }
}

function assertUpdateTargetSafe(targetPath: string, allowBunRuntime = false): void {
  const executableName = basename(targetPath).toLowerCase()
  if (!allowBunRuntime && ['bun', 'bun.exe', 'bun-debug', 'bun-debug.exe'].includes(executableName)) {
    throw new Error('Refusing to update the Bun runtime; set targetPath to an application executable')
  }
}

export async function inspectExecutable(path: string, version?: string): Promise<CurrentExecutable> {
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size <= 0) throw new Error(`Executable does not exist or is empty: ${path}`)
  const sha256 = new Bun.CryptoHasher('sha256')
  const md5 = new MD5()
  const multipart = new MD5()
  const chunkSize = 16 * 1024 * 1024
  const chunks = Math.ceil(file.size / chunkSize)

  for (let index = 0; index < chunks; index++) {
    const bytes = await file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)).arrayBuffer()
    sha256.update(bytes)
    md5.update(bytes)
    multipart.update(MD5.hash(bytes))
  }

  const etags = [sha256.digest('hex'), md5.digest('hex')]
  if (chunks > 1) etags.push(`${multipart.digest('hex')}-${chunks}`)
  return {
    path,
    version,
    size: file.size,
    sha256: etags[0]!,
    etags,
  }
}

export async function installUpdate(
  descriptor: UpdateDescriptor,
  options: {
    targetPath?: string
    signal?: AbortSignal
    onProgress?: (progress: UpdateProgress) => void
  } = {},
): Promise<InstalledUpdate> {
  const targetPath = options.targetPath ?? process.execPath
  const tempPath = `${targetPath}.update-tmp`
  const backupPath = `${targetPath}.old-backup`
  await rm(tempPath, { force: true })

  try {
    if (descriptor.structural) {
      options.onProgress?.({ phase: 'planning', downloaded: 0, total: 0 })
      try {
        if (!descriptor.sha256) {
          throw new Error('Structural updates require the full target SHA-256 in trusted release metadata')
        }
        await reconstructStructuralUpdate({
          currentPath: targetPath,
          outputPath: tempPath,
          targetUrl: descriptor.url,
          targetSize: descriptor.size,
          targetSha256: descriptor.sha256,
          headers: descriptor.downloadHeaders,
          ifRange: formatIfRange(descriptor.etag),
          signal: options.signal,
          onProgress: (progress) => options.onProgress?.(structuralProgress(progress)),
        })
      } catch (error) {
        if (descriptor.structural.fallbackToFull === false) throw error
        if (!(error instanceof StructuralRangeUnsupportedError)) {
          console.warn(`[BunDesk] Structural update unavailable; downloading the complete target: ${error instanceof Error ? error.message : String(error)}`)
        }
        await rm(tempPath, { force: true })
        await downloadFullUpdate(descriptor, tempPath, options)
      }
    } else {
      await downloadFullUpdate(descriptor, tempPath, options)
    }

    options.onProgress?.({
      phase: 'verifying',
      downloaded: 0,
      total: descriptor.size,
      targetTotal: descriptor.size,
    })
    const downloadedInfo = await inspectExecutable(tempPath, descriptor.version)
    if (descriptor.size !== undefined && downloadedInfo.size !== descriptor.size) {
      throw new Error(`Update size mismatch: expected ${descriptor.size}, received ${downloadedInfo.size}`)
    }
    const expectedSha = descriptor.sha256?.replace(/^sha256:/i, '').toLowerCase()
    if (expectedSha && downloadedInfo.sha256 !== expectedSha) {
      throw new Error(`Update SHA-256 mismatch: expected ${expectedSha}, received ${downloadedInfo.sha256}`)
    }
    if (descriptor.etag && !downloadedInfo.etags.includes(normalizeEtag(descriptor.etag) ?? '')) {
      throw new Error(`Update ETag mismatch: expected ${descriptor.etag}`)
    }
    if (targetPath.toLowerCase().endsWith('.exe')) {
      const header = new Uint8Array(await Bun.file(tempPath).slice(0, 2).arrayBuffer())
      if (header[0] !== 0x4d || header[1] !== 0x5a) throw new Error('Downloaded update is not a Windows executable')
    }

    options.onProgress?.({
      phase: 'installing',
      downloaded: 0,
      total: downloadedInfo.size,
      targetTotal: downloadedInfo.size,
    })
    await rm(backupPath, { force: true })
    await rename(targetPath, backupPath)
    try {
      await rename(tempPath, targetPath)
    } catch (error) {
      await rename(backupPath, targetPath).catch(() => undefined)
      throw error
    }
    return { descriptor, targetPath, backupPath }
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}


async function downloadFullUpdate(
  descriptor: UpdateDescriptor,
  tempPath: string,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: UpdateProgress) => void
  },
): Promise<void> {
  const response = await fetch(descriptor.url, {
    headers: descriptor.downloadHeaders,
    signal: options.signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`Update download failed (${response.status} ${response.statusText}): ${descriptor.url}`)
  }
  const totalHeader = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  const total = descriptor.size ?? (Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined)
  const output = await open(tempPath, 'w', 0o700)
  let downloaded = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Update cancelled')
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      let written = 0
      while (written < value.byteLength) {
        const result = await output.write(value, written, value.byteLength - written)
        if (result.bytesWritten <= 0) throw new Error(`Failed to write update at ${downloaded + written}`)
        written += result.bytesWritten
      }
      downloaded += value.byteLength
      options.onProgress?.({ phase: 'downloading', downloaded, total, targetTotal: descriptor.size })
    }
    await output.sync()
  } finally {
    await output.close()
  }
  if (downloaded <= 0) throw new Error('Downloaded update is empty')
}

function structuralProgress(progress: StructuralReconstructionProgress): UpdateProgress {
  return {
    phase: progress.phase,
    downloaded: progress.downloaded,
    total: progress.downloadTotal,
    reused: progress.reused,
    targetTotal: progress.targetTotal,
  }
}

function formatIfRange(etag: string | undefined): string | undefined {
  const normalized = normalizeEtag(etag)
  return normalized ? `\"${normalized}\"` : undefined
}

export async function cleanupAfterUpdate(options: {
  targetPath?: string
  waitForPid?: number
  timeoutMs?: number
} = {}): Promise<void> {
  if (options.waitForPid) {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (Date.now() < deadline && isProcessAlive(options.waitForPid)) await Bun.sleep(100)
  }
  const targetPath = options.targetPath ?? process.execPath
  await Promise.all([
    rm(`${targetPath}.update-tmp`, { force: true }),
    rm(`${targetPath}.old-backup`, { force: true }),
  ])
}

function resolvePlatformAssetName(configured: PlatformAssetName): string {
  if (typeof configured === 'string') return configured
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const key = `${platform}-${process.arch}` as keyof typeof configured
  const value = configured[key]
  if (!value) throw new Error(`No GitHub release asset configured for ${key}`)
  return value
}

function resolveGitHubAssetName(configured: GitHubReleaseProviderOptions['assetName']): string {
  return resolvePlatformAssetName(configured)
}

function normalizeEtag(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/^W\//, '').replaceAll('"', '').toLowerCase()
  return normalized || undefined
}

function parseDigestHeader(value: string | null): string | undefined {
  if (!value) return undefined
  const match = value.match(/(?:^|,\s*)sha-?256=(?::)?([A-Za-z0-9+/=_-]+)/i)
  if (!match?.[1]) return undefined
  const digest = match[1]
  if (/^[a-f0-9]{64}$/i.test(digest)) return digest.toLowerCase()
  try {
    return Buffer.from(digest, 'base64').toString('hex')
  } catch {
    return undefined
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
