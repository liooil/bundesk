import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  isPwaInstalled,
  resolvePwaTarget,
  type FindBrowserOptions,
  type InstalledPwaOptions,
  type ResolvedPwaTarget,
} from './browser'
import { runRegistry } from './windows-integration'

export interface PwaInstallationOptions extends FindBrowserOptions, InstalledPwaOptions {
  /** Manifest start URL to open or force-install. */
  url: string | URL
  /** Time allowed for the browser to finish installation. Defaults to five minutes. */
  timeoutMs?: number
  browserArgs?: string[]
  inheritOutput?: boolean
  signal?: AbortSignal
}

export interface PwaPolicyOptions {
  createDesktopShortcut?: boolean
  customName?: string
}

export interface PwaPolicyInstallationOptions extends PwaInstallationOptions {
  policy?: PwaPolicyOptions
  dryRun?: boolean
}

export interface PwaInstallationResult {
  mode: 'interactive' | 'policy'
  status: 'installed' | 'already-installed' | 'policy-configuration-planned' | 'policy-unchanged'
  appId: string
  url: string
  browser: string
  userDataDir: string
  profileDirectory: string
  manifestResources: string
  launcherPid?: number
  policyChanged?: boolean
}

export interface PwaPolicyRemovalResult {
  mode: 'policy'
  status: 'policy-removed' | 'policy-absent' | 'policy-removal-planned'
  url: string
  browser: string
  changed: boolean
  dryRun: boolean
}

export interface PwaInstallPolicyEntry {
  url: string
  default_launch_container: 'window'
  create_desktop_shortcut?: boolean
  custom_name?: string
}

const policyValueName = 'WebAppInstallForceList'
const defaultInstallTimeoutMs = 5 * 60_000

/**
 * Opens the configured URL in the selected Chromium profile and waits for the
 * user to accept the browser's native install prompt.
 */
export async function installPwaInteractively(
  options: PwaInstallationOptions,
): Promise<PwaInstallationResult> {
  const target = await resolvePwaTarget(options)
  const url = normalizeInstallUrl(options.url)
  if (await isPwaInstalled(target)) return installationResult('interactive', 'already-installed', target, url)

  const waiter = await createInstallationWaiter(target, options.timeoutMs, options.signal)
  let launcher: Bun.Subprocess
  try {
    const output = options.inheritOutput === false ? 'ignore' : 'inherit'
    console.info(`[BunDesk] Opened ${url}; confirm installation in ${target.browser}`)
    launcher = Bun.spawn([
      target.browser,
      `--user-data-dir=${target.userDataDir}`,
      `--profile-directory=${target.profileDirectory}`,
      '--new-window',
      url,
      ...(options.browserArgs ?? []),
    ], { stdio: ['ignore', output, output] })
    launcher.unref()
  } catch (error) {
    waiter.cancel()
    await waiter.promise.catch(() => undefined)
    throw error
  }

  await failOnLauncherError(launcher, waiter)
  return installationResult('interactive', 'installed', target, url, launcher.pid)
}

/**
 * Adds the URL to Chromium's mandatory WebAppInstallForceList policy and waits
 * for the selected profile to report the installed app. Automatic policy
 * mutation is currently Windows-only and preserves unrelated policy entries.
 */
export async function installPwaWithPolicy(
  options: PwaPolicyInstallationOptions,
): Promise<PwaInstallationResult> {
  const target = await resolvePwaTarget(options)
  const url = normalizeInstallUrl(options.url)
  const entry = createPwaInstallPolicyEntry(url, options.policy)
  const policy = await updateWindowsPwaPolicy(target.browser, entry, 'add', options.dryRun === true)
  if (options.dryRun) {
    return {
      ...installationResult(
        'policy',
        policy.changed ? 'policy-configuration-planned' : 'policy-unchanged',
        target,
        url,
      ),
      policyChanged: policy.changed,
    }
  }
  if (await isPwaInstalled(target)) {
    return {
      ...installationResult('policy', 'already-installed', target, url),
      policyChanged: policy.changed,
    }
  }

  let waiter: Awaited<ReturnType<typeof createInstallationWaiter>> | undefined
  try {
    waiter = await createInstallationWaiter(target, options.timeoutMs, options.signal)
    const output = options.inheritOutput === false ? 'ignore' : 'inherit'
    const launcher = Bun.spawn([
      target.browser,
      `--user-data-dir=${target.userDataDir}`,
      `--profile-directory=${target.profileDirectory}`,
      '--no-startup-window',
      ...(options.browserArgs ?? []),
    ], { stdio: ['ignore', output, output] })
    launcher.unref()
    await failOnLauncherError(launcher, waiter)
    return {
      ...installationResult('policy', 'installed', target, url, launcher.pid),
      policyChanged: policy.changed,
    }
  } catch (error) {
    if (waiter) {
      waiter.cancel()
      await waiter.promise.catch(() => undefined)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `PWA installation verification failed after the enterprise policy was configured: ${message}. ` +
      'The policy remains active; run remove-pwa-policy to remove it.',
      { cause: error },
    )
  }
}

/** Removes only the matching URL from WebAppInstallForceList. It does not uninstall the PWA. */
export async function removePwaInstallationPolicy(
  options: PwaInstallationOptions & { dryRun?: boolean },
): Promise<PwaPolicyRemovalResult> {
  const target = await resolvePwaTarget(options)
  const url = normalizeInstallUrl(options.url)
  const policy = await updateWindowsPwaPolicy(target.browser, createPwaInstallPolicyEntry(url), 'remove', options.dryRun === true)
  return {
    mode: 'policy',
    status: options.dryRun && policy.changed
      ? 'policy-removal-planned'
      : policy.changed
        ? 'policy-removed'
        : 'policy-absent',
    url,
    browser: target.browser,
    changed: policy.changed,
    dryRun: options.dryRun === true,
  }
}
export function createPwaInstallPolicyEntry(
  url: string | URL,
  options: PwaPolicyOptions = {},
): PwaInstallPolicyEntry {
  const entry: PwaInstallPolicyEntry = {
    url: normalizeInstallUrl(url),
    default_launch_container: 'window',
  }
  if (options.createDesktopShortcut !== undefined) {
    entry.create_desktop_shortcut = options.createDesktopShortcut
  }
  if (options.customName !== undefined) {
    const customName = options.customName.trim()
    if (!customName) throw new Error('PWA policy customName must not be empty')
    entry.custom_name = customName
  }
  return entry
}

export function mergePwaInstallPolicy(
  current: unknown,
  entry: PwaInstallPolicyEntry,
  operation: 'add' | 'remove',
): { entries: unknown[]; changed: boolean } {
  if (!Array.isArray(current)) throw new Error(`${policyValueName} must contain a JSON array`)
  const matching = (value: unknown) => {
    if (!value || typeof value !== 'object' || typeof (value as { url?: unknown }).url !== 'string') return false
    try {
      return normalizeInstallUrl((value as { url: string }).url) === entry.url
    } catch {
      return false
    }
  }
  if (operation === 'remove') {
    const entries = current.filter((value) => !matching(value))
    return { entries, changed: entries.length !== current.length }
  }

  let replaced = false
  const entries: unknown[] = []
  for (const value of current) {
    if (!matching(value)) {
      entries.push(value)
    } else if (!replaced) {
      entries.push(entry)
      replaced = true
    }
  }
  if (!replaced) entries.push(entry)
  return { entries, changed: JSON.stringify(entries) !== JSON.stringify(current) }
}

function installationResult(
  mode: PwaInstallationResult['mode'],
  status: PwaInstallationResult['status'],
  target: ResolvedPwaTarget,
  url: string,
  launcherPid?: number,
): PwaInstallationResult {
  return {
    mode,
    status,
    appId: target.appId,
    url,
    browser: target.browser,
    userDataDir: target.userDataDir,
    profileDirectory: target.profileDirectory,
    manifestResources: target.manifestResources,
    ...(launcherPid === undefined ? {} : { launcherPid }),
  }
}

async function createInstallationWaiter(
  target: ResolvedPwaTarget,
  timeoutMs = defaultInstallTimeoutMs,
  signal?: AbortSignal,
): Promise<{ promise: Promise<void>; cancel(): void }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PWA installation timeoutMs must be greater than zero')
  const manifestRoot = dirname(target.manifestResources)
  await mkdir(manifestRoot, { recursive: true })

  let settled = false
  let checking = false
  let resolvePromise!: () => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const watcher = watch(manifestRoot, () => {
    if (checking || settled) return
    checking = true
    void isPwaInstalled(target).then((installed) => {
      if (installed) finish()
    }).catch(fail).finally(() => {
      checking = false
    })
  })
  watcher.on('error', fail)
  const timer = setTimeout(() => {
    fail(new Error(
      `PWA ${target.appId} was not installed in profile ${target.profileDirectory} within ${timeoutMs}ms`,
    ))
  }, timeoutMs)
  const onAbort = () => fail(signal?.reason ?? new Error('PWA installation was cancelled'))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  function cleanup() {
    clearTimeout(timer)
    watcher.close()
    signal?.removeEventListener('abort', onAbort)
  }
  function finish() {
    if (settled) return
    settled = true
    cleanup()
    resolvePromise()
  }
  function fail(error: unknown) {
    if (settled) return
    settled = true
    cleanup()
    rejectPromise(error)
  }
  if (await isPwaInstalled(target)) finish()
  return { promise, cancel: () => fail(new Error('PWA installation was cancelled')) }
}

async function failOnLauncherError(
  launcher: Bun.Subprocess,
  waiter: { promise: Promise<void>; cancel(): void },
): Promise<void> {
  const launcherFailure = launcher.exited.then((exitCode) => {
    if (exitCode !== 0) throw new Error(`Chromium PWA installer launcher exited with code ${exitCode}`)
    return new Promise<never>(() => undefined)
  })
  try {
    await Promise.race([waiter.promise, launcherFailure])
  } catch (error) {
    waiter.cancel()
    throw error
  }
}

async function updateWindowsPwaPolicy(
  browser: string,
  entry: PwaInstallPolicyEntry,
  operation: 'add' | 'remove',
  dryRun: boolean,
): Promise<{ changed: boolean }> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Automatic PWA enterprise policy installation is currently supported only on Windows; ' +
      'Linux and macOS require administrator-managed browser policy deployment',
    )
  }
  const key = windowsPolicyKey(browser, 'HKCU')
  const machine = await readWindowsPwaPolicy(windowsPolicyKey(browser, 'HKLM'))
  const machineContainsUrl = mergePwaInstallPolicy(machine, entry, 'remove').changed
  if (machineContainsUrl) {
    if (operation === 'remove') {
      throw new Error(`${entry.url} is enforced by machine policy and cannot be removed from the current-user registry`)
    }
    return { changed: false }
  }
  if (operation === 'add' && machine.length > 0) {
    throw new Error(
      `${policyValueName} is already managed by machine policy; deploy ${entry.url} through the administrator policy instead`,
    )
  }
  const current = await readWindowsPwaPolicy(key)
  const merged = mergePwaInstallPolicy(current, entry, operation)
  if (!merged.changed || dryRun) return { changed: merged.changed }

  const command = merged.entries.length === 0
    ? ['delete', key, '/v', policyValueName, '/f']
    : ['add', key, '/v', policyValueName, '/t', 'REG_SZ', '/d', JSON.stringify(merged.entries), '/f']
  const result = await runRegistry(command, false, operation === 'remove')
  if (!result.ok) throw new Error(`Failed to update ${policyValueName}: ${result.detail}`)
  return { changed: true }
}

function windowsPolicyKey(browser: string, hive: 'HKCU' | 'HKLM'): string {
  const executable = browser.replaceAll('\\', '/').toLowerCase()
  if (executable.includes('msedge')) return `${hive}\\Software\\Policies\\Microsoft\\Edge`
  if (executable.includes('google') && executable.includes('chrome')) {
    return `${hive}\\Software\\Policies\\Google\\Chrome`
  }
  throw new Error('PWA enterprise policy installation supports Microsoft Edge and Google Chrome on Windows')
}

async function readWindowsPwaPolicy(key: string): Promise<unknown[]> {
  const child = Bun.spawn(['reg.exe', 'query', key, '/v', policyValueName], {
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ])
  if (exitCode !== 0) return []
  const raw = stdout.match(/WebAppInstallForceList\s+REG_SZ\s+(.+)$/m)?.[1]?.trim()
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${policyValueName} contains invalid JSON; refusing to overwrite existing browser policy`)
  }
  if (!Array.isArray(value)) throw new Error(`${policyValueName} must contain a JSON array`)
  return value
}

function normalizeInstallUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PWA installation URL must use http or https')
  }
  return url.href
}
