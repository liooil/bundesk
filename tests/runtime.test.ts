import { afterAll, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  launchAppWindow,
  registerLinuxIntegration,
  registerWindowsIntegration,
  resolveCliWindowProvider,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderTermuxBootScript,
  resolveAppEnvironment,
  staticBinaryProvider,
  unregisterLinuxIntegration,
  windowsToastScript,
  createLinuxTray,
} from '../src/index'
import type { DesktopAppOptions, DesktopAppSession, LinuxIntegrationOptions, SecondInstanceEvent } from '../src/index'

const temporaryDirectories: string[] = []

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
      actions: [{
        name: 'greet',
        description: 'Greet someone',
        args: [{ name: 'name', type: 'string', required: true }],
        handler: ({ name }) => ({ name }),
      }],
    })

    const help = await app.start(['--help'])
    expect(help.kind).toBe('command')
    if (help.kind === 'command') {
      expect(help.command).toBe('help')
      expect(help.result).toContain('Usage: cli-test [command] [options]')
      expect(help.result).toContain('greet --name <string>')
      expect(help.result).toContain('--smoke')
      expect(help.result).toContain('--provider <provider>')
    }

    const shortHelp = await app.start(['-h'])
    expect(shortHelp.kind === 'command' && shortHelp.command).toBe('help')

    const version = await app.start(['--version'])
    expect(version).toEqual({ kind: 'command', command: 'version', result: 'cli-test 1.2.3' })
    const shortVersion = await app.start(['-V'])
    expect(shortVersion).toEqual(version)
  })

  it('selects browser or the platform-native webview from CLI options', async () => {
    expect(resolveCliWindowProvider('browser', 'linux')).toBe('browser')
    expect(resolveCliWindowProvider('webview', 'win32')).toBe('webview')
    expect(resolveCliWindowProvider('webview', 'linux')).toBe('webkit')
    expect(() => resolveCliWindowProvider('webview', 'darwin')).toThrow('not available')

    const profile = await mkdtemp(join(tmpdir(), 'bundesk-browser-cli-'))
    temporaryDirectories.push(profile)
    for (const [index, args] of [['--browser'], ['--provider', 'browser'], ['--provider=browser']].entries()) {
      const app = createDesktopApp({
        id: `runtime-browser-cli-${process.pid}-${index}`,
        server: { port: 0, fetch: () => new Response('ok') },
        window: {
          provider: 'webview',
          preferred: process.execPath,
          userDataDir: join(profile, String(index)),
          inheritOutput: false,
        },
        singleInstance: false,
      })
      const session = await app.start(args)
      expect(session.kind).toBe('primary')
      if (session.kind !== 'primary') throw new Error('Expected a primary session')
      expect(session.windowProvider).toBe('browser')
      expect(session.window).not.toBeNull()
      expect(session.window && 'executeScript' in session.window).toBe(false)
      await session.stop()
    }

    const invalid = createDesktopApp({
      id: `runtime-browser-cli-invalid-${process.pid}`,
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
    })
    await expect(invalid.start(['--provider', 'native'])).rejects.toThrow('expected browser or webview')
    await expect(invalid.start(['--provider'])).rejects.toThrow('requires browser or webview')
  })

  it('owns the Bun HTTP server lifecycle', async () => {
    const app = createDesktopApp({
      id: `runtime-server-${process.pid}`,
      server: {
        port: 0,
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

  it('forwards argv and cwd to the primary instance callback', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'bundesk-instance-test-'))
    temporaryDirectories.push(dataDirectory)
    let resolveEvent: ((event: SecondInstanceEvent) => void) | undefined
    const eventReceived = new Promise<SecondInstanceEvent>((resolve) => {
      resolveEvent = resolve
    })
    const primaryApp = createDesktopApp({
      id: `runtime-instance-${process.pid}`,
      server: { port: 0, fetch: () => new Response('ok') },
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
      server: { port: 0, fetch: () => new Response('unused') },
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
        }),
      })
      const checked = await updater.check()
      expect(checked.update?.version).toBe('1.1.0')
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
      const window = await launchAppWindow({
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

  it.skipIf(process.platform === 'win32')('falls back to Firefox with an isolated tracked profile', async () => {
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
    const window = await launchAppWindow({
      appId: `runtime-firefox-${process.pid}`,
      url: 'http://127.0.0.1:43210/example',
      preferred: 'firefox',
      firefoxCandidates: [executable],
      userDataDir: profile,
      browserArgs: ['--test-argument'],
      inheritOutput: false,
    })
    expect(window).not.toBeNull()
    await window?.exited
    expect((await readFile(argsFile, 'utf8')).split('\n')).toEqual([
      '--new-instance',
      '--profile',
      profile,
      '--new-window',
      'http://127.0.0.1:43210/example',
      '--test-argument',
    ])
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

function actionTestApp(overrides: Partial<DesktopAppOptions> = {}) {
  return createDesktopApp({
    id: `runtime-actions-${process.pid}`,
    server: { port: 0, routes: { '/': new Response('ok') } },
    window: false,
    singleInstance: false,
    actions: [{
      name: 'greet',
      description: 'Greet someone',
      args: [
        { name: 'name', type: 'string', required: true },
        { name: 'count', type: 'number', default: 1 },
      ],
      handler(args) {
        return { greeting: `hello ${args.name}`, count: args.count }
      },
    }],
    ...overrides,
  })
}

describe('actions: one functionality, cli + api + gui', () => {
  it('exposes actions over the HTTP API and the generated GUI console', async () => {
    const app = actionTestApp()
    const session = await app.start([])
    expect(session.kind).toBe('primary')
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    try {
      const list = await fetch(new URL('/api/actions', session.url)).then((response) => response.json()) as Array<{ name: string; args: unknown[] }>
      expect(list).toHaveLength(1)
      expect(list[0]?.name).toBe('greet')

      const executed = await fetch(new URL('/api/actions/greet', session.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'world', count: 2 }),
      }).then((response) => response.json())
      expect(executed).toEqual({ greeting: 'hello world', count: 2 })

      const missing = await fetch(new URL('/api/actions/nope', session.url), { method: 'POST', body: '{}' })
      expect(missing.status).toBe(404)

      const invalid = await fetch(new URL('/api/actions/greet', session.url), { method: 'POST', body: '{}' })
      expect(invalid.status).toBe(400)

      const consolePage = await fetch(new URL('/__bundesk/actions', session.url))
      expect(consolePage.status).toBe(200)
      expect(await consolePage.text()).toContain('BunDesk Actions')
    } finally {
      await session.stop()
    }
  })

  it('runs the same action from the CLI and exits', async () => {
    const app = actionTestApp()
    const result = await app.start(['greet', '--name', 'cli', '--count', '3'])
    expect(result.kind).toBe('action')
    if (result.kind === 'action') {
      expect(result.action).toBe('greet')
      expect(result.result).toEqual({ greeting: 'hello cli', count: 3 })
    }
  })

  it('forwards a CLI action to the primary instance and returns the result', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'bundesk-action-forward-'))
    temporaryDirectories.push(dataDirectory)
    const options: DesktopAppOptions = {
      id: `runtime-actions-forward-${process.pid}`,
      server: { port: 0, fetch: () => new Response('unused') },
      window: false,
      singleInstance: { dataDirectory },
      actions: [{
        name: 'greet',
        args: [{ name: 'name', type: 'string', required: true }],
        handler(args) {
          return { greeting: `hello ${args.name}` }
        },
      }],
    }
    const primaryApp = createDesktopApp(options)
    const primary = await primaryApp.start([])
    expect(primary.kind).toBe('primary')

    const secondaryApp = createDesktopApp(options)
    const secondary = await secondaryApp.start(['greet', '--name', 'forwarded'])
    expect(secondary.kind).toBe('secondary')
    if (secondary.kind === 'secondary') {
      expect(secondary.accepted).toBe(true)
      expect(secondary.result).toEqual({ greeting: 'hello forwarded' })
    }
    await (primary as DesktopAppSession).stop()
  })

  it('rejects unknown flags and missing required args from the CLI', async () => {
    const app = actionTestApp()
    await expect(app.start(['greet', '--bogus', 'x'])).rejects.toThrow('unknown flag')
    await expect(app.start(['greet'])).rejects.toThrow('requires argument: name')
  })

  it('exposes actions on the app context', async () => {
    const app = actionTestApp()
    const session = await app.start([])
    expect(session.kind).toBe('primary')
    if (session.kind !== 'primary') throw new Error('Expected a primary session')
    try {
      expect(await session.actions.call('greet', { name: 'ctx' })).toEqual({ greeting: 'hello ctx', count: 1 })
    } finally {
      await session.stop()
    }
  })
})

describe('service registration', () => {
  it('renders a systemd user unit for the headless serve command', () => {
    const unit = renderSystemdUnit('my-company.my-app', '/opt/my-app/bin/my-app')
    expect(unit).toContain('[Install]')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('ExecStart="/opt/my-app/bin/my-app" serve --no-browser')
    expect(unit).toContain('WorkingDirectory=/opt/my-app/bin')
  })

  it('renders a launchd plist with log paths', () => {
    const plist = renderLaunchdPlist('my-company.my-app', '/Applications/My App.app/Contents/MacOS/My App', '/data/dir')
    expect(plist).toContain('<key>Label</key><string>my-company.my-app</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<string>--no-browser</string>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain(join('/data/dir', 'service.log'))
  })

  it('renders a termux boot script', () => {
    const script = renderTermuxBootScript('/data/data/com.termux/files/usr/bin/my-app')
    expect(script).toContain('#!/data/data/com.termux/files/usr/bin/sh')
    expect(script).toContain('exec "/data/data/com.termux/files/usr/bin/my-app" serve --no-browser')
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
      server: { port: 0, fetch: () => new Response('ok') },
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
        fetch: () => new Response('<html><body><h1>webview-test</h1></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      },
      window: {
        provider: 'webview',
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
      if (!('executeScript' in window)) throw new Error('Expected a WebView2 window from the webview provider')
      const navigation = await navigated
      expect(navigation.success).toBe(true)
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
