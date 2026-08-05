import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDesktopApp,
  createUpdater,
  findChromiumBrowser,
  githubReleaseProvider,
  launchAppWindow,
  registerWindowsIntegration,
  staticBinaryProvider,
} from '../src/index'
import type { DesktopAppSession, SecondInstanceEvent } from '../src/index'

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe('desktop runtime', () => {
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

  it('routes framework integration commands without starting the application server', async () => {
    const app = createDesktopApp({
      id: `runtime-command-${process.pid}`,
      server: { port: 0, fetch: () => new Response('must not start') },
      window: false,
      singleInstance: false,
      windowsIntegration: {
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
