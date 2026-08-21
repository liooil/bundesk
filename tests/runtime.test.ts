import { afterAll, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDesktopApp,
  createUpdater,
  createWin32Tray,
  findChromiumBrowser,
  findFirefoxBrowser,
  githubReleaseProvider,
  getLinuxIntegrationStatus,
  installService,
  launchChromiumAppWindow,
  launchFirefoxWindow,
  createPwaInstallPolicyEntry,
  installPwaInteractively,
  launchPwaWindow,
  getWindowProviderMatrix,
  inspectWindowProvider,
  openDesktopWindow,
  WindowProviderError,
  mergePwaInstallPolicy,
  registerLinuxIntegration,
  registerWindowsIntegration,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderTermuxBootScript,
  resolveAppEnvironment,
  staticBinaryProvider,
  unregisterLinuxIntegration,
  windowsToastScript,
  createLinuxTray,
} from '../src/index'
import type { DesktopAppSession, LinuxIntegrationOptions, SecondInstanceEvent } from '../src/index'

const temporaryDirectories: string[] = []

async function requestUnix(socketPath: string, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>()
  let raw = ''
  void Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      },
      data(_socket, data) {
        raw += new TextDecoder().decode(data)
      },
      close() {
        const [headers = '', body = ''] = raw.split('\r\n\r\n', 2)
        resolve({ status: Number(headers.split(' ')[1]), body })
      },
      error(_socket, error) {
        reject(error)
      },
    },
  }).catch(reject)
  return promise
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe('desktop runtime', () => {
  it('prints generated help and version without starting the application', async () => {
    const app = createDesktopApp({
      id: 'dev.bundesk.cli-test',
      version: '1.2.3',
      cli: {
        name: 'cli-test',
        description: 'CLI test application',
        options: [{ flags: '--smoke', description: 'Run a smoke check' }],
      },
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
    })

    const help = await app.start(['--help'])
    expect(help.kind).toBe('command')
    if (help.kind === 'command') {
      expect(help.command).toBe('help')
      expect(help.result).toContain('Usage: cli-test [command] [options]')
      expect(help.result).toContain('--smoke')
      expect(help.result).toContain('--provider <provider>')
      expect(help.result).toContain('webview2')
    }

    const shortHelp = await app.start(['-h'])
    expect(shortHelp.kind === 'command' && shortHelp.command).toBe('help')

    const version = await app.start(['--version'])
    expect(version).toEqual({ kind: 'command', command: 'version', result: 'cli-test 1.2.3' })
    const shortVersion = await app.start(['-V'])
    expect(shortVersion).toEqual(version)
  })

  it('accepts only concrete provider names from CLI options', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'bundesk-browser-cli-'))
    temporaryDirectories.push(profile)
    for (const [index, args] of [
      ['--provider', 'chromium-app'],
      ['--provider=chromium-app'],
    ].entries()) {
      const app = createDesktopApp({
        id: `runtime-browser-cli-${process.pid}-${index}`,
        server: { port: 0, stickyPort: false, fetch: () => new Response('ok') },
        window: {
          provider: 'webview2',
          preferred: process.execPath,
          userDataDir: join(profile, String(index)),
          inheritOutput: false,
        },
        singleInstance: false,
      })
      const session = await app.start(args)
      expect(session.kind).toBe('primary')
      if (session.kind !== 'primary') throw new Error('Expected a primary session')
      expect(session.windowProvider).toBe('chromium-app')
      expect(session.window).not.toBeNull()
      expect(session.window && 'executeScript' in session.window).toBe(false)
      await session.stop()
    }

    const pwa = createDesktopApp({
      id: `runtime-pwa-cli-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('unused') },
      window: {
        provider: 'chromium-app',
        preferred: process.execPath,
        pwa: {
          appId: 'abcdefghijklmnopabcdefghijklmnop',
          userDataDir: profile,
        },
      },
      singleInstance: false,
    })
    await expect(pwa.start(['--provider', 'chromium-pwa'])).rejects.toThrow('chromium-pwa: unavailable')

    const invalid = createDesktopApp({
      id: `runtime-browser-cli-invalid-${process.pid}`,
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
    })
    await expect(invalid.start(['--provider', 'native'])).rejects.toThrow('Invalid window provider')
    await expect(invalid.start(['--provider'])).rejects.toThrow('requires one of')
  })

  it('opens no window when the application omits window configuration', async () => {
    const app = createDesktopApp({
      id: `runtime-no-default-provider-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('ok') },
      singleInstance: false,
    })
    const session = await app.start([])
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    expect(session.window).toBeNull()
    expect(session.windowProvider).toBeNull()
    await session.stop()
  })

  it('reports provider facts without selecting a replacement', async () => {
    const matrix = getWindowProviderMatrix()
    expect(matrix.some((entry) =>
      entry.provider === 'webview2' &&
      entry.platform === 'win32' &&
      entry.arch === 'arm64' &&
      entry.implementation === 'not-implemented'
    )).toBe(true)

    const report = await inspectWindowProvider('android-view-intent')
    expect(report.provider).toBe('android-view-intent')
    if (!process.env.PREFIX?.includes('com.termux')) {
      expect(report.compatibility).toBe('incompatible')
      expect(report.diagnostics[0]?.code).toBe('BUNDESK_PROVIDER_PLATFORM_UNSUPPORTED')
    }
  })

  it('uses only the fallback chain supplied by the application', async () => {
    const missing = join(tmpdir(), `bundesk-no-browser-${process.pid}`)
    const common = {
      appId: `runtime-provider-fallback-${process.pid}`,
      url: 'https://example.invalid/',
      provider: 'chromium-app' as const,
      preferred: missing,
      firefoxCandidates: [process.execPath],
      inheritOutput: false,
    }

    try {
      await openDesktopWindow(common)
      throw new Error('Expected the concrete chromium-app provider to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(WindowProviderError)
      if (!(error instanceof WindowProviderError)) throw error
      expect(error.kind).toBe('unavailable')
      expect(error.attempts.map((attempt) => attempt.provider)).toEqual(['chromium-app'])
    }

    const window = await openDesktopWindow({
      ...common,
      fallback: [{ provider: 'firefox-window', on: ['unavailable'] }],
    })
    expect(window.provider).toBe('firefox-window')
    expect(window.attempts.map(({ provider, outcome }) => ({ provider, outcome }))).toEqual([
      { provider: 'chromium-app', outcome: 'failed' },
      { provider: 'firefox-window', outcome: 'opened' },
    ])
    window.close()
    await window.closed
  })
  it('routes install-pwa through the configured application lifecycle', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'bundesk-pwa-command-'))
    temporaryDirectories.push(userDataDir)
    const appId = 'abcdefghijklmnopabcdefghijklmnop'
    await mkdir(join(
      userDataDir,
      'Default',
      'Web Applications',
      'Manifest Resources',
      appId,
    ), { recursive: true })
    const app = createDesktopApp({
      id: `runtime-pwa-install-command-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('installable') },
      window: {
        provider: 'chromium-pwa',
        preferred: process.execPath,
        pwa: {
          appId,
          userDataDir,
          installUrl: 'https://app.example/',
        },
      },
      singleInstance: false,
    })
    const help = await app.start(['--help'])
    expect(help.kind === 'command' && help.result).toContain('install-pwa [--policy]')

    const installed = await app.start(['install-pwa'])
    expect(installed).toEqual({
      kind: 'command',
      command: 'install-pwa',
      result: expect.objectContaining({
        mode: 'interactive',
        status: 'already-installed',
        appId,
        url: 'https://app.example/',
      }),
    })
  })


  it('forwards install-pwa to the primary server instance and returns its result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-pwa-command-forward-'))
    temporaryDirectories.push(directory)
    const appId = 'abcdefghijklmnopabcdefghijklmnop'
    await mkdir(join(
      directory,
      'browser',
      'Default',
      'Web Applications',
      'Manifest Resources',
      appId,
    ), { recursive: true })
    const app = createDesktopApp({
      id: `runtime-pwa-install-forward-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('installable') },
      window: {
        provider: 'chromium-app',
        preferred: process.execPath,
        pwa: {
          appId,
          userDataDir: join(directory, 'browser'),
          installUrl: 'https://app.example/',
        },
      },
      singleInstance: { dataDirectory: join(directory, 'instance') },
    })
    const primary = await app.start(['serve'])
    expect(primary.kind).toBe('primary')
    if (primary.kind !== 'primary') throw new Error('Expected a primary session')

    const secondary = await app.start(['install-pwa'])
    expect(secondary).toEqual(expect.objectContaining({
      kind: 'secondary',
      accepted: true,
      result: expect.objectContaining({
        mode: 'interactive',
        status: 'already-installed',
        appId,
      }),
    }))
    await primary.stop()
  })

  it('owns the Bun HTTP server lifecycle', async () => {
    const app = createDesktopApp({
      id: `runtime-server-${process.pid}`,
      server: {
        port: 0,
        stickyPort: false,
        fetch: () => new Response('runtime-ok'),
      },
      window: false,
      singleInstance: false,
    })
    const result = await app.start([])
    expect(result.kind).toBe('primary')
    if (result.kind !== 'primary') throw new Error('Expected a primary session')
    expect(await fetch(result.url).then((response) => response.text())).toBe('runtime-ok')
    await result.stop()
    expect(result.server.pendingRequests).toBe(0)
  })

  it('serves routes over a unix socket without binding a TCP port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-unix-server-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'app.sock')
    const app = createDesktopApp({
      id: `runtime-unix-server-${process.pid}`,
      server: {
        unix: socketPath,
        routes: {
          '/static': new Response('static-ok'),
          '/items/:id': {
            POST: (request: Request) => Response.json({
              id: (request as Request & { params: Record<string, string> }).params.id,
            }),
          },
        },
      },
      window: false,
      singleInstance: false,
    })

    const session = await app.start([])
    expect(session.kind).toBe('primary')
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    expect(session.unix).toBe(socketPath)
    expect(session.server.port).toBeUndefined()
    expect(session.url.protocol).toBe('http+unix:')
    expect((await requestUnix(socketPath, '/static')).body).toBe('static-ok')
    expect(JSON.parse((await requestUnix(socketPath, '/items/42', 'POST')).body)).toEqual({ id: '42' })
    expect((await requestUnix(socketPath, '/missing')).status).toBe(404)
    await session.stop()
  })

  it('forwards single-instance IPC through the app unix socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-unix-ipc-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'app.sock')
    const dataDirectory = join(directory, 'instance')
    let received: SecondInstanceEvent | undefined
    const appId = `runtime-unix-ipc-${process.pid}`
    const primary = await createDesktopApp({
      id: appId,
      server: {
        unix: socketPath,
        routes: { '/app-route': new Response('route-ok') },
        fetch: () => new Response('fallback-ok'),
      },
      window: false,
      singleInstance: { dataDirectory },
      onSecondInstance(event) {
        received = event
      },
    }).start([])
    expect(primary.kind).toBe('primary')
    if (primary.kind !== 'primary') throw new Error('Expected a primary session')

    const record = JSON.parse(await readFile(join(dataDirectory, 'instance.json'), 'utf8')) as { unix?: string; port?: number }
    expect(record.unix).toBe(socketPath)
    expect(record.port).toBeUndefined()
    expect((await requestUnix(socketPath, '/app-route')).body).toBe('route-ok')
    expect((await requestUnix(socketPath, 'http://localhost/app-route')).body).toBe('route-ok')
    expect((await requestUnix(socketPath, '/fallback')).body).toBe('fallback-ok')
    const unauthorized = await fetch('http://localhost/second-instance', {
      method: 'POST',
      unix: socketPath,
      body: JSON.stringify({ argv: [], cwd: process.cwd(), pid: process.pid, receivedAt: new Date().toISOString() }),
    })
    expect(unauthorized.status).toBe(401)

    const secondary = await createDesktopApp({
      id: appId,
      server: { unix: socketPath, fetch: () => new Response('unused') },
      window: false,
      singleInstance: { dataDirectory },
    }).start(['sample.demo'])
    expect(secondary).toEqual(expect.objectContaining({
      kind: 'secondary',
      accepted: true,
    }))
    expect(received?.argv).toEqual(['sample.demo'])
    expect(received?.cwd).toBe(process.cwd())
    await primary.stop()
  })

  it('rejects TCP overrides and window launch in unix mode', async () => {
    const socketPath = join(tmpdir(), `bundesk-unix-invalid-${process.pid}.sock`)
    const headless = createDesktopApp({
      id: `runtime-unix-invalid-${process.pid}`,
      server: { unix: socketPath, fetch: () => new Response('unused') },
      window: false,
      singleInstance: false,
    })
    await expect(headless.start(['--port', '12345'])).rejects.toThrow('cannot be combined')

    const windowed = createDesktopApp({
      id: `runtime-unix-window-${process.pid}`,
      server: { unix: socketPath, fetch: () => new Response('unused') },
      window: { provider: 'chromium-app' },
      singleInstance: false,
    })
    await expect(windowed.start([])).rejects.toThrow('headless')
  })

  it('reuses the last dynamic port and falls back when it is unavailable', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'bundesk-sticky-port-'))
    temporaryDirectories.push(dataDirectory)
    const appId = `runtime-sticky-port-${process.pid}`
    const createApp = () => createDesktopApp({
      id: appId,
      server: {
        stickyPort: { dataDirectory },
        fetch: () => new Response('sticky-ok'),
      },
      window: false,
      singleInstance: false,
    })
    const sessions: DesktopAppSession[] = []
    let blocker: Bun.Server<undefined> | undefined

    try {
      const first = await createApp().start([])
      expect(first.kind).toBe('primary')
      if (first.kind !== 'primary') throw new Error('Expected a primary session')
      sessions.push(first)
      const firstPort = Number(first.url.port)
      expect(firstPort).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(join(dataDirectory, 'server-port.json'), 'utf8'))).toEqual({ port: firstPort })
      await first.stop()

      const reused = await createApp().start([])
      expect(reused.kind).toBe('primary')
      if (reused.kind !== 'primary') throw new Error('Expected a primary session')
      sessions.push(reused)
      expect(Number(reused.url.port)).toBe(firstPort)
      await reused.stop()

      blocker = Bun.serve({ hostname: '127.0.0.1', port: firstPort, fetch: () => new Response('occupied') })
      const fallback = await createApp().start([])
      expect(fallback.kind).toBe('primary')
      if (fallback.kind !== 'primary') throw new Error('Expected a primary session')
      sessions.push(fallback)
      const fallbackPort = Number(fallback.url.port)
      expect(fallbackPort).toBeGreaterThan(0)
      expect(fallbackPort).not.toBe(firstPort)
      expect(JSON.parse(await readFile(join(dataDirectory, 'server-port.json'), 'utf8'))).toEqual({ port: fallbackPort })
      await fallback.stop()
      await blocker.stop(true)
      blocker = undefined

      const fixed = await createDesktopApp({
        id: appId,
        server: {
          port: firstPort,
          stickyPort: { dataDirectory },
          fetch: () => new Response('fixed-ok'),
        },
        window: false,
        singleInstance: false,
      }).start([])
      expect(fixed.kind).toBe('primary')
      if (fixed.kind !== 'primary') throw new Error('Expected a primary session')
      sessions.push(fixed)
      expect(Number(fixed.url.port)).toBe(firstPort)
      expect(JSON.parse(await readFile(join(dataDirectory, 'server-port.json'), 'utf8'))).toEqual({ port: fallbackPort })
    } finally {
      await Promise.all(sessions.map((session) => session.stop()))
      await blocker?.stop(true)
    }
  })

  it('forwards argv and cwd to the primary instance callback', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'bundesk-instance-test-'))
    temporaryDirectories.push(dataDirectory)
    let resolveEvent: ((event: SecondInstanceEvent) => void) | undefined
    const eventReceived = new Promise<SecondInstanceEvent>((resolve) => {
      resolveEvent = resolve
    })
    const primaryApp = createDesktopApp({
      id: `runtime-instance-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('ok') },
      window: false,
      singleInstance: { dataDirectory },
      onSecondInstance(event) {
        resolveEvent?.(event)
      },
    })
    const primary = await primaryApp.start([])
    expect(primary.kind).toBe('primary')
    const instanceRecord = JSON.parse(await readFile(join(dataDirectory, 'instance.json'), 'utf8')) as { port: number }
    const unauthorized = await fetch(`http://127.0.0.1:${instanceRecord.port}/second-instance`, {
      method: 'POST',
      body: JSON.stringify({ argv: [], cwd: process.cwd(), pid: process.pid, receivedAt: new Date().toISOString() }),
    })
    expect(unauthorized.status).toBe(401)

    const secondaryApp = createDesktopApp({
      id: `runtime-instance-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('unused') },
      window: false,
      singleInstance: { dataDirectory },
    })
    const secondary = await secondaryApp.start(['sample.demo'])
    expect(secondary.kind).toBe('secondary')
    if (secondary.kind === 'secondary') expect(secondary.accepted).toBe(true)
    const event = await eventReceived
    expect(event.argv).toEqual(['sample.demo'])
    expect(event.cwd).toBe(process.cwd())
    await (primary as DesktopAppSession).stop()
  })

  it('checks and atomically installs a static binary update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-update-test-'))
    temporaryDirectories.push(directory)
    const targetPath = join(directory, 'sample-app.bin')
    await writeFile(targetPath, 'old-binary')
    const nextBinary = new TextEncoder().encode('new-binary-content')
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(nextBinary)
    const sha256 = hasher.digest('hex')
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const headers = {
          etag: `"${sha256}"`,
          'content-length': String(nextBinary.byteLength),
          'x-checksum-sha256': sha256,
        }
        return request.method === 'HEAD'
          ? new Response(null, { headers })
          : new Response(nextBinary, { headers })
      },
    })

    try {
      const updater = createUpdater({
        targetPath,
        currentVersion: '1.0.0',
        provider: staticBinaryProvider({
          binaryUrl: `http://127.0.0.1:${server.port}/sample-app.bin`,
          version: '1.1.0',
          structuralUpdates: true,
        }),
      })
      const checked = await updater.check()
      expect(checked.update?.version).toBe('1.1.0')
      expect(checked.update?.structural).toEqual({})
      if (!checked.update) throw new Error('Expected an update')
      const installed = await updater.install(checked.update)
      expect(await Bun.file(targetPath).text()).toBe('new-binary-content')
      expect(await Bun.file(installed.backupPath).text()).toBe('old-binary')
    } finally {
      await server.stop(true)
    }
  })

  it('resolves a GitHub release asset through the provider API', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          tag_name: 'v2.0.0',
          name: 'Version 2',
          body: 'Changes',
          draft: false,
          prerelease: false,
          assets: [{
            name: 'sample.exe',
            browser_download_url: 'https://downloads.example/sample.exe',
            size: 123,
            digest: `sha256:${'a'.repeat(64)}`,
          }],
        })
      },
    })
    try {
      const provider = githubReleaseProvider({
        owner: 'owner',
        repository: 'repository',
        assetName: 'sample.exe',
        structuralUpdates: true,
        apiUrl: `http://127.0.0.1:${server.port}`,
      })
      const update = await provider.check({
        path: 'sample.exe',
        version: '1.0.0',
        size: 1,
        sha256: 'old',
        etags: ['old'],
      })
      expect(update).toEqual({
        version: '2.0.0',
        url: 'https://downloads.example/sample.exe',
        size: 123,
        sha256: 'a'.repeat(64),
        changelog: 'Changes',
        structural: {},
      })
    } finally {
      await server.stop(true)
    }
  })

  it.skipIf(process.platform !== 'win32')('launches an installed Chromium browser in App Mode', async () => {
    const browser = await findChromiumBrowser()
    expect(browser).not.toBeNull()
    if (!browser) throw new Error('Expected Edge or Chrome on Windows')
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-browser-test-'))
    temporaryDirectories.push(directory)
    const server = Bun.serve({ port: 0, fetch: () => new Response('<title>Runtime test</title>') })
    try {
      const window = await launchChromiumAppWindow({
        appId: `runtime-browser-${process.pid}`,
        url: `http://127.0.0.1:${server.port}`,
        preferred: browser,
        userDataDir: join(directory, 'profile'),
        browserArgs: ['--headless=new', '--disable-gpu', '--no-first-run'],
        inheritOutput: false,
      })
      expect(window).not.toBeNull()
      expect(window?.pid).toBeGreaterThan(0)
      if (window?.exitCode === null) window.kill()
      await window?.exited
    } finally {
      await server.stop(true)
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('launches Firefox with an isolated tracked profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-firefox-test-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'firefox')
    const argsFile = join(directory, 'args.txt')
    const profile = join(directory, 'profile')
    await writeFile(executable, [
      '#!/usr/bin/env bun',
      `await Bun.write(${JSON.stringify(argsFile)}, Bun.argv.slice(2).join('\\n'))`,
    ].join('\n'))
    await chmod(executable, 0o755)

    expect(await findFirefoxBrowser({ candidates: [join(directory, 'missing'), executable] })).toBe(executable)
    const window = await launchFirefoxWindow({
      appId: `runtime-firefox-${process.pid}`,
      url: 'http://127.0.0.1:43210/example',
      preferred: 'firefox',
      firefoxCandidates: [executable],
      userDataDir: profile,
      browserArgs: ['--test-argument'],
      inheritOutput: false,
    })
    await window.exited
    expect((await readFile(argsFile, 'utf8')).split('\n')).toEqual([
      '--new-instance',
      '--profile',
      profile,
      '--new-window',
      'http://127.0.0.1:43210/example',
      '--test-argument',
    ])
  })

  it('merges one PWA enterprise policy entry without replacing unrelated policy', () => {
    const existing = [
      { url: 'https://existing.example/', default_launch_container: 'tab' },
      { url: 'https://app.example/', default_launch_container: 'tab' },
    ]
    const entry = createPwaInstallPolicyEntry('https://app.example', {
      createDesktopShortcut: true,
      customName: 'Example App',
    })
    const added = mergePwaInstallPolicy(existing, entry, 'add')
    expect(added).toEqual({
      changed: true,
      entries: [
        existing[0],
        {
          url: 'https://app.example/',
          default_launch_container: 'window',
          create_desktop_shortcut: true,
          custom_name: 'Example App',
        },
      ],
    })
    expect(mergePwaInstallPolicy(added.entries, entry, 'add').changed).toBe(false)
    expect(mergePwaInstallPolicy(added.entries, entry, 'remove')).toEqual({
      changed: true,
      entries: [existing[0]],
    })
  })

  it.skipIf(process.platform === 'win32')('detects an interactive PWA installation from the browser profile event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-pwa-interactive-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'chromium')
    const argsFile = join(directory, 'args.txt')
    const userDataDir = join(directory, 'user-data')
    const appId = 'abcdefghijklmnopabcdefghijklmnop'
    const manifestResources = join(
      userDataDir,
      'Default',
      'Web Applications',
      'Manifest Resources',
      appId,
    )
    await writeFile(executable, [
      '#!/usr/bin/env bun',
      "import { mkdir } from 'node:fs/promises'",
      `await mkdir(${JSON.stringify(manifestResources)}, { recursive: true })`,
      `await Bun.write(${JSON.stringify(argsFile)}, Bun.argv.slice(2).join('\\n'))`,
    ].join('\n'))
    await chmod(executable, 0o755)

    const result = await installPwaInteractively({
      appId,
      url: 'https://app.example/install',
      userDataDir,
      preferred: executable,
      inheritOutput: false,
    })
    expect(result.status).toBe('installed')
    expect((await readFile(argsFile, 'utf8')).split('\n')).toEqual([
      `--user-data-dir=${userDataDir}`,
      '--profile-directory=Default',
      '--new-window',
      'https://app.example/install',
    ])
  })

  it.skipIf(process.platform === 'win32')('launches an installed Chromium PWA from its browser profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bundesk-pwa-test-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'chromium')
    const argsFile = join(directory, 'args.txt')
    const userDataDir = join(directory, 'user-data')
    const profileDirectory = 'Profile 2'
    const appId = 'abcdefghijklmnopabcdefghijklmnop'
    const manifestResources = join(
      userDataDir,
      profileDirectory,
      'Web Applications',
      'Manifest Resources',
      appId,
    )
    await writeFile(executable, [
      '#!/usr/bin/env bun',
      `await Bun.write(${JSON.stringify(argsFile)}, Bun.argv.slice(2).join('\\n'))`,
    ].join('\n'))
    await chmod(executable, 0o755)
    await mkdir(manifestResources, { recursive: true })
    await Bun.write(join(manifestResources, 'installed'), '')

    const window = await launchPwaWindow({
      appId,
      profileDirectory,
      userDataDir,
      preferred: executable,
      browserArgs: ['--test-argument'],
      inheritOutput: false,
    })
    await window.exited
    expect((await readFile(argsFile, 'utf8')).split('\n')).toEqual([
      `--app-id=${appId}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      '--test-argument',
    ])
  })

  it('rejects a missing or invalid PWA installation before launching Chromium', async () => {
    await expect(launchPwaWindow({
      appId: 'invalid',
      preferred: process.execPath,
    })).rejects.toThrow('32 lowercase characters')

    const directory = await mkdtemp(join(tmpdir(), 'bundesk-pwa-missing-'))
    temporaryDirectories.push(directory)
    await expect(launchPwaWindow({
      appId: 'abcdefghijklmnopabcdefghijklmnop',
      userDataDir: directory,
      preferred: process.execPath,
    })).rejects.toThrow('is not installed in browser profile Default')
  })

  it('routes framework integration commands without starting the application server', async () => {
    const app = createDesktopApp({
      id: `runtime-command-${process.pid}`,
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
      desktopIntegration: {
        fileAssociations: [{
          extension: '.bundesktest',
          progId: 'BunDesk.TestFile',
          description: 'BunDesk test file',
        }],
      },
    })
    const result = await app.start(['status'])
    expect(result.kind).toBe('command')
    if (result.kind === 'command') expect(result.command).toBe('status')
  })

  it.skipIf(process.platform !== 'win32')('plans current-user file association changes without writing them', async () => {
    const result = await registerWindowsIntegration({
      executablePath: process.execPath,
      fileAssociations: [{
        extension: '.bundesktest',
        progId: 'BunDesk.TestFile',
        description: 'BunDesk test file',
      }],
      startMenuShortcut: {
        name: 'BunDesk Test',
      },
    }, { dryRun: true, makeDefault: true })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.details.some((line) => line.includes('HKCU\\Software\\Classes'))).toBe(true)
  })
})


describe('service registration', () => {
  it('renders a systemd user unit for the headless serve command', () => {
    const unit = renderSystemdUnit('my-company.my-app', '/opt/my-app/bin/my-app')
    expect(unit).toContain('[Install]')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('ExecStart="/opt/my-app/bin/my-app" serve --no-window')
  })

  it('renders a launchd plist with log paths', () => {
    const plist = renderLaunchdPlist('my-company.my-app', '/Applications/My App.app/Contents/MacOS/My App', '/data/dir')
    expect(plist).toContain('<key>Label</key><string>my-company.my-app</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<string>--no-window</string>')
    expect(plist).toContain(join('/data/dir', 'service.log'))
  })

  it('renders a termux boot script', () => {
    const script = renderTermuxBootScript('/data/data/com.termux/files/usr/bin/my-app')
    expect(script).toContain('#!/data/data/com.termux/files/usr/bin/sh')
    expect(script).toContain('exec "/data/data/com.termux/files/usr/bin/my-app" serve --no-window')
  })

  it('routes service commands without writing when dry-running', async () => {
    const app = createDesktopApp({
      id: `runtime-service-${process.pid}`,
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
    })
    const installed = await app.start(['install-service', '--dry-run'])
    expect(installed.kind).toBe('command')
    if (installed.kind === 'command') {
      expect(installed.command).toBe('install-service')
      const result = installed.result as { ok: boolean }
      expect(result.ok).toBe(true)
    }
    const status = await app.start(['service-status'])
    expect(status.kind).toBe('command')
    if (status.kind === 'command') {
      const result = status.result as { supported: boolean }
      expect(result.supported).toBe(true)
    }
  })

  it.skipIf(process.platform !== 'win32')('plans an HKCU Run key registration without writing it', async () => {
    const result = await installService({
      appId: 'bundesk-test',
      executablePath: process.execPath,
    }, { dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.details.some((line) => line.includes('CurrentVersion\\Run'))).toBe(true)
  })
})

describe('system notifications', () => {
  it('builds a Windows toast script with the configured AUMID', () => {
    const script = windowsToastScript('my-company.my-app')
    expect(script).toContain('ToastNotificationManager')
    expect(script).toContain('ToastText02')
    expect(script).toContain('$env:BUN_DESKTOP_TOAST_TITLE')
    expect(script).toContain("CreateToastNotifier('my-company.my-app')")
  })

  it.skipIf(process.platform !== 'win32')('delivers a toast through context.notify', async () => {
    const app = createDesktopApp({
      id: `runtime-notify-${process.pid}`,
      server: { port: 0, stickyPort: false, fetch: () => new Response('ok') },
      window: false,
      singleInstance: false,
      notifications: true,
    })
    const session = await app.start([])
    expect(session.kind).toBe('primary')
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    try {
      const delivered = await session.notify({
        title: 'BunDesk test toast',
        body: 'delivered through context.notify',
      })
      expect(delivered).toBe(true)
    } finally {
      await session.stop()
    }
  }, 30_000)
})

describe('webview2 window provider', () => {
  it.skipIf(process.platform !== 'win32')('opens a WebView2 window and executes script in it', async () => {
    // The initial about:blank load does not fire NavigationCompleted; the
    // first completion is the app URL, which is when the DOM is queryable.
    let resolveNavigated: ((info: { success: boolean; errorStatus: number }) => void) | undefined
    const navigated = new Promise<{ success: boolean; errorStatus: number }>((resolve) => {
      resolveNavigated = resolve
    })
    const app = createDesktopApp({
      id: `runtime-webview-${process.pid}`,
      server: {
        port: 0,
        stickyPort: false,
        fetch: () => new Response('<html><body><h1>webview-test</h1></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      },
      window: {
        provider: 'webview2',
        path: '/',
        width: 480,
        height: 320,
        title: 'WebView2 test',
        onNavigateCompleted: (info) => resolveNavigated?.(info),
      },
      singleInstance: false,
    })
    const session = await app.start([])
    expect(session.kind).toBe('primary')
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    try {
      expect(session.window).not.toBeNull()
      const window = session.window
      if (!window) throw new Error('Expected a window')
      if (!('executeScript' in window)) throw new Error('Expected a WebView2 window from the webview2 provider')
      const navigation = await navigated
      expect(navigation.success).toBe(true)
      expect(await window.ready).toEqual({
        evidence: 'navigation-completed',
        url: session.url.href,
      })
      expect(window.lifecycle).toEqual({ ownership: 'window', windowCloseObservable: true })
      expect(window.attempts).toEqual([{ provider: 'webview2', outcome: 'opened', diagnostics: [] }])
      const heading = await window.executeScript('document.querySelector("h1").textContent')
      expect(heading).toBe('webview-test')
    } finally {
      await session.stop()
    }
  }, 60_000)
})

describe('system tray', () => {
  it.skipIf(process.platform !== 'win32')('adds and removes a tray icon through the Win32 FFI path', async () => {
    let activated = 0
    let menuClicks = 0
    const handle = createWin32Tray({
      tooltip: 'BunDesk test tray',
      menu: [{ label: 'Item A' }, { separator: true }, { label: 'Item B' }],
      onActivate: () => {
        activated++
      },
      onMenuClick: () => {
        menuClicks++
      },
    })
    expect(handle).not.toBeNull()
    if (!handle) throw new Error('Expected the tray to be created on Windows')
    handle.update({ tooltip: 'BunDesk test tray v2' })
    handle.destroy()
    handle.destroy() // idempotent
    expect(activated).toBe(0)
    expect(menuClicks).toBe(0)
  })
})

describe('linux desktop integration', () => {
  it.skipIf(process.platform !== 'linux')('registers, reports, and unregisters XDG file associations', async () => {
    const dataHome = await mkdtemp(join(tmpdir(), 'bundesk-xdg-data-'))
    const configHome = await mkdtemp(join(tmpdir(), 'bundesk-xdg-config-'))
    temporaryDirectories.push(dataHome, configHome)
    const previousData = process.env.XDG_DATA_HOME
    const previousConfig = process.env.XDG_CONFIG_HOME
    process.env.XDG_DATA_HOME = dataHome
    process.env.XDG_CONFIG_HOME = configHome
    try {
      const options: LinuxIntegrationOptions = {
        appId: `bundesk-test-${process.pid}`,
        executablePath: process.execPath,
        fileAssociations: [{
          extension: '.bundesktest',
          progId: 'BunDesk.TestFile',
          description: 'BunDesk test file',
        }],
        startMenuShortcut: { name: 'BunDesk Test' },
      }
      const registered = await registerLinuxIntegration(options, { makeDefault: true })
      expect(registered.ok).toBe(true)

      const status = await getLinuxIntegrationStatus(options)
      expect(status.supported).toBe(true)
      expect(status.fileAssociations[0]).toMatchObject({
        extension: '.bundesktest',
        registered: true,
        defaultForCurrentUser: true,
      })
      expect(status.startMenuShortcut.exists).toBe(true)

      const unregistered = await unregisterLinuxIntegration(options)
      expect(unregistered.ok).toBe(true)
      const after = await getLinuxIntegrationStatus(options)
      expect(after.fileAssociations[0]?.registered).toBe(false)
      expect(after.startMenuShortcut.exists).toBe(false)
    } finally {
      if (previousData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousData
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousConfig
    }
  })
})

describe('app environment resolution', () => {
  const noEnv: Record<string, string | undefined> = {}
  it('defaults to development under bun, production when packaged', () => {
    expect(resolveAppEnvironment([], { packaged: false, env: noEnv })).toBe('development')
    expect(resolveAppEnvironment([], { packaged: true, env: noEnv })).toBe('production')
  })
  it('NODE_ENV wins over the default', () => {
    expect(resolveAppEnvironment([], { packaged: true, env: { NODE_ENV: 'development' } })).toBe('development')
    expect(resolveAppEnvironment([], { packaged: false, env: { NODE_ENV: 'production' } })).toBe('production')
  })
  it('BUNDESK_ENV wins over NODE_ENV', () => {
    expect(resolveAppEnvironment([], { packaged: false, env: { NODE_ENV: 'production', BUNDESK_ENV: 'development' } })).toBe('development')
    expect(resolveAppEnvironment([], { packaged: true, env: { NODE_ENV: 'development', BUNDESK_ENV: 'production' } })).toBe('production')
  })
  it('CLI --mode wins over every env var', () => {
    expect(resolveAppEnvironment(['--mode=production'], { packaged: false, env: { NODE_ENV: 'development', BUNDESK_ENV: 'development' } })).toBe('production')
    expect(resolveAppEnvironment(['--mode', 'development'], { packaged: true, env: { NODE_ENV: 'production', BUNDESK_ENV: 'production' } })).toBe('development')
  })
  it('non-standard values are ignored, not consumed', () => {
    expect(resolveAppEnvironment(['--mode=staging'], { packaged: true, env: noEnv })).toBe('production')
    expect(resolveAppEnvironment([], { packaged: false, env: { NODE_ENV: 'staging' } })).toBe('development')
    expect(resolveAppEnvironment([], { packaged: true, env: { BUNDESK_ENV: 'test' } })).toBe('production')
    // app-owned args like --mode=staging pass through untouched
    expect(resolveAppEnvironment(['--mode=staging', 'input.txt'], { packaged: false, env: noEnv })).toBe('development')
  })
})

describe('bun --hot runtime', () => {
  it('replaces the active BunDesk session without blocking module evaluation', async () => {
    // Bun's Linux watcher ignores hidden directories, so keep the fixture
    // inside the project tree without a dot-prefixed path.
    const directory = await mkdtemp(join(import.meta.dir, 'tmp-hot-runtime-'))
    temporaryDirectories.push(directory)
    const entrypoint = join(directory, 'hot-runtime.ts')
    const valuePath = join(directory, 'hot-runtime-value.ts')
    const eventsPath = join(directory, 'events.log')
    const frameworkPath = join(import.meta.dir, '../src/index.ts').replaceAll('\\', '/')
    await writeFile(entrypoint, [
      "import { appendFile } from 'node:fs/promises'",
      `import { createDesktopApp } from ${JSON.stringify(frameworkPath)}`,
      "import { value } from './hot-runtime-value'",
      "declare global { var bundeskHotFixtureEvaluation: number | undefined }",
      'globalThis.bundeskHotFixtureEvaluation = (globalThis.bundeskHotFixtureEvaluation ?? 0) + 1',
      'const evaluation = globalThis.bundeskHotFixtureEvaluation',
      `const eventsPath = ${JSON.stringify(eventsPath.replaceAll('\\', '/'))}`,
      "await appendFile(eventsPath, `evaluate:${evaluation}:${value}\\n`)",
      'const app = createDesktopApp({',
      "  id: 'dev.bundesk.hot-runtime-test',",
      `  server: { hostname: '127.0.0.1', port: Number(process.env.BUNDESK_HOT_TEST_PORT), stickyPort: false, fetch: () => new Response(\`${'${evaluation}:${value}'}\`) },`,
      '  window: false,',
      '  singleInstance: false,',
      "  onReady: async () => { await appendFile(eventsPath, `ready:${evaluation}:${value}\\n`) },",
      '})',
      'await app.run()',
      "await appendFile(eventsPath, `returned:${evaluation}:${value}\\n`)",
    ].join('\n'))
    await writeFile(valuePath, "export const value = 'one'\n")
    await writeFile(eventsPath, '')

    const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
    const port = reserved.port
    await reserved.stop(true)
    if (!port) throw new Error('Expected a dynamic test port')

    const child = Bun.spawn([process.execPath, '--hot', entrypoint], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        BUNDESK_HOT_TEST_PORT: String(port),
      },
    })

    try {
      await waitForCondition(async () => {
        const events = await readFile(eventsPath, 'utf8').catch(() => '')
        return events.includes('returned:1:one')
      }, 10_000)
      expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe('1:one')

      await writeFile(valuePath, "export const value = 'two'\n")
      await waitForCondition(async () => {
        const events = await readFile(eventsPath, 'utf8').catch(() => '')
        return events.includes(':two') && events.match(/returned:\d+:two/g)?.length
      }, 10_000)
      const updated = await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())
      expect(updated).toMatch(/^\d+:two$/)
      expect(await readFile(eventsPath, 'utf8')).toContain('ready:')
    } finally {
      child.kill(9)
      await child.exited
    }
  }, 20_000)
})

async function waitForCondition(check: () => boolean | number | Promise<boolean | number | undefined>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}

describe('dbus codec', () => {
  const roundTrip = (signature: string, values: unknown[]): unknown[] => {
    const { encodeBody, decodeBody } = require('../src/runtime/dbus') as typeof import('../src/runtime/dbus')
    return decodeBody(encodeBody(signature, values), signature)
  }
  it('round-trips strings, numbers and booleans', () => {
    expect(roundTrip('sib', ['hello', -42, true])).toEqual(['hello', -42, true])
  })
  it('round-trips dicts a{sv} with variant values', () => {
    const entries = [['label', ['s', 'Open']], ['enabled', ['b', true]]] as [string, [string, unknown]][]
    expect(roundTrip('a{sv}', [entries])).toEqual([entries])
  })
  it('round-trips nested menu layout (ia{sv}av)', () => {
    const layout = [[1, [['label', ['s', 'Item']]] as [string, [string, unknown]][], []]]
    expect(roundTrip('a(ia{sv}av)', [layout])).toEqual([layout])
  })
  it('round-trips icon pixmaps a(iiay)', () => {
    const pixmap = [[2, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]]]
    expect(roundTrip('a(iiay)', [pixmap])).toEqual([pixmap])
  })
  it('round-trips tooltips (ssa(iiay))', () => {
    expect(roundTrip('(ssa(iiay))', [['', 'tip', []]])).toEqual([['', 'tip', []]])
  })
})

describe('linux tray (StatusNotifierItem)', () => {
  const hasSessionBus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR)
  it.skipIf(!hasSessionBus)('cancels an in-flight registration when destroyed immediately', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/tray-fast-stop.ts')], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ timedOut: false, exitCode })),
      Bun.sleep(5_000).then(() => ({ timedOut: true, exitCode: null })),
    ])
    if (outcome.timedOut) {
      child.kill()
      await child.exited
    }
    const stderr = await new Response(child.stderr).text()
    expect(outcome.timedOut).toBe(false)
    expect(outcome.exitCode).toBe(0)
    expect(stderr).toBe('')
  }, 10_000)

  it.skipIf(!hasSessionBus)('registers, updates and destroys on a live session bus', async () => {
    const { createLinuxTray } = await import('../src/runtime/tray-linux')
    const tray = createLinuxTray<unknown>(
      { tooltip: 'suite-test', menu: [{ label: 'Item' }] },
      { onActivate: () => {}, onMenuClick: () => {} },
    )
    expect(tray).not.toBeNull()
    await Bun.sleep(1200) // allow the async D-Bus connection + registration
    tray!.update({ tooltip: 'updated', menu: [{ label: 'Only' }] })
    await Bun.sleep(300)
    tray!.destroy()
  }, 15_000)
})
